import {
  findThreadSupersededBy,
  getThread,
  setThreadSupersededBy,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import type { Thread } from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";

/**
 * Thread lineage — the RETIRED disposition of charter D4.
 *
 * `supersededByThreadId` means a lineage retired this thread and the
 * conversation continues in the named thread. It is deliberately NOT
 * `archivedAt` (which means the user archived it) and NOT
 * `visibility: "hidden"` (which means a plugin owns it as a worker). Nothing
 * in here may collapse two of the three into one flag.
 *
 * A retired thread stays readable, navigable and deliverable. What changes is
 * where delivery lands: `resolveLineageHead` walks the edge forward so a
 * caller that holds a stale thread id reaches the live thread instead of
 * repairing the retired one's disposition.
 */

/**
 * Bounds the forward walk. A cycle is already impossible through
 * `setThreadLineage`, but the column is also writable by a future backfill and
 * by any other primitive, so the walk terminates on its own rather than
 * trusting the data.
 */
const MAX_LINEAGE_WALK = 64;

export interface LineageHead {
  /** The live thread a caller should deliver to. */
  thread: Thread;
  /** How many edges were followed to reach it. 0 means the input was live. */
  hops: number;
  /**
   * True when the walk stopped early — a cycle, a chain longer than
   * MAX_LINEAGE_WALK, or an edge pointing at a deleted thread. The returned
   * thread is still the best available target; the flag exists so callers can
   * log rather than silently deliver somewhere surprising.
   */
  truncated: boolean;
}

/**
 * Resolves the live head of a lineage chain, following `supersededByThreadId`
 * forward. Returns null when the named thread does not exist or is deleted.
 *
 * BBF-7 consumes this as `resolveNotificationTargetThread`, and deleting
 * bb-plugin-board's `ensureThreadListed` depends on it: a deliverer resolves
 * the head and delivers there, instead of un-hiding and un-archiving whatever
 * thread it was holding.
 *
 * The name and signature are a cross-wave contract. Do not change them.
 */
export function resolveLineageHead(
  db: DbConnection,
  threadId: string,
): LineageHead | null {
  const start = getThread(db, threadId);
  if (!start || start.deletedAt !== null) {
    return null;
  }

  let current: Thread = start;
  const seen = new Set<string>([current.id]);
  for (let hops = 0; hops < MAX_LINEAGE_WALK; hops += 1) {
    const nextId = current.supersededByThreadId;
    if (nextId === null || nextId === undefined) {
      return { thread: current, hops, truncated: false };
    }
    if (seen.has(nextId)) {
      return { thread: current, hops, truncated: true };
    }
    const next = getThread(db, nextId);
    if (!next || next.deletedAt !== null) {
      // A deleted successor is the end of the usable chain. The retired thread
      // is the only readable target left, so hand it back rather than null.
      return { thread: current, hops, truncated: true };
    }
    seen.add(next.id);
    current = next;
  }
  return { thread: current, hops: MAX_LINEAGE_WALK, truncated: true };
}

/**
 * The thread this one retired, or null. This is the backward edge the
 * lineage-aware timeline continues into, so it is a lookup by
 * `supersededByThreadId`, not by id.
 *
 * Project-scoped: a predecessor in another project is not a predecessor. The
 * timeline continuation turns a thread id in a pagination cursor into a read
 * of another thread's events, so this scope check is an authorization check,
 * not a tidiness one.
 */
export function findLineagePredecessor(
  db: DbConnection,
  thread: Pick<Thread, "id" | "projectId">,
): Thread | null {
  const predecessor = findThreadSupersededBy(db, thread.id);
  if (
    !predecessor ||
    predecessor.deletedAt !== null ||
    predecessor.projectId !== thread.projectId
  ) {
    return null;
  }
  return predecessor;
}

/**
 * The full chain, oldest first, that `threadId` belongs to. Walks backward to
 * the origin and then forward to the head.
 */
export function listLineage(db: DbConnection, threadId: string): Thread[] {
  const start = getThread(db, threadId);
  if (!start || start.deletedAt !== null) {
    return [];
  }

  const backward: Thread[] = [];
  const seen = new Set<string>([start.id]);
  let cursor: Thread = start;
  for (let hops = 0; hops < MAX_LINEAGE_WALK; hops += 1) {
    const predecessor = findLineagePredecessor(db, cursor);
    if (!predecessor || seen.has(predecessor.id)) {
      break;
    }
    seen.add(predecessor.id);
    backward.unshift(predecessor);
    cursor = predecessor;
  }

  const forward: Thread[] = [];
  cursor = start;
  for (let hops = 0; hops < MAX_LINEAGE_WALK; hops += 1) {
    const nextId = cursor.supersededByThreadId;
    if (nextId === null || nextId === undefined || seen.has(nextId)) {
      break;
    }
    const next = getThread(db, nextId);
    if (!next || next.deletedAt !== null) {
      break;
    }
    seen.add(next.id);
    forward.push(next);
    cursor = next;
  }

  return [...backward, start, ...forward];
}

export interface SetThreadLineageArgs {
  thread: Thread;
  supersededByThreadId: string | null;
}

/**
 * Sets or clears a thread's forward lineage edge.
 *
 * Clearing it is the "un-retire" of the disposition model — the one-click
 * return that `visibility: "hidden"` never had, and the reason a plugin no
 * longer needs an `archive`-instead-of-`hide` workaround plus a `restore`
 * command to undo it.
 */
export function setThreadLineage(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SetThreadLineageArgs,
): Thread {
  const { supersededByThreadId, thread } = args;

  if (supersededByThreadId !== null) {
    if (supersededByThreadId === thread.id) {
      throw new ApiError(
        400,
        "invalid_request",
        "A thread cannot supersede itself.",
      );
    }
    const successor = getThread(deps.db, supersededByThreadId);
    if (!successor || successor.deletedAt !== null) {
      throw new ApiError(
        404,
        "thread_not_found",
        "Superseding thread not found",
      );
    }
    if (successor.projectId !== thread.projectId) {
      throw new ApiError(
        400,
        "invalid_request",
        "A lineage edge cannot cross projects.",
      );
    }
    assertLineageEdgeCreatesNoCycle(deps.db, {
      successorId: successor.id,
      threadId: thread.id,
    });
  }

  const updated = setThreadSupersededBy(deps.db, deps.hub, {
    supersededByThreadId,
    threadId: thread.id,
  });
  if (!updated) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  return updated;
}

function assertLineageEdgeCreatesNoCycle(
  db: DbConnection,
  args: { successorId: string; threadId: string },
): void {
  // Walking forward from the proposed successor must never arrive back at the
  // thread being retired. Bounded by the same cap as the read walk so a chain
  // that is already corrupt cannot hang the request.
  let cursor = getThread(db, args.successorId);
  const seen = new Set<string>();
  for (let hops = 0; hops < MAX_LINEAGE_WALK && cursor; hops += 1) {
    if (cursor.id === args.threadId) {
      throw new ApiError(
        400,
        "invalid_request",
        "That lineage edge would create a cycle.",
      );
    }
    const nextId = cursor.supersededByThreadId;
    if (nextId === null || nextId === undefined || seen.has(nextId)) {
      return;
    }
    seen.add(nextId);
    cursor = getThread(db, nextId);
  }
}

