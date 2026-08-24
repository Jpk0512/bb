import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  events as storedEvents,
  getThread,
  getThreadTurnRecord,
  hasRootStoredTurnStarted,
  threadTurns,
  upsertThreadTurnRecord,
} from "@bb/db";
import {
  parseStoredThreadEvent,
  requireThreadEventScopeTurnId,
  threadScope,
  turnScope,
  type ThreadEvent,
  type ThreadLifecycleEvent,
  type ThreadStatus,
  type ThreadTurnRecord,
} from "@bb/domain";
import type { AppDeps } from "../types.js";
import {
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../services/system/event-pruning.js";
import { applyLoggedThreadLifecycleEvent } from "../services/threads/lifecycle-outcome.js";
import { buildThreadTurnRecord } from "../services/threads/turn-telemetry.js";

interface ApplyTurnCompletedEventResult {
  isRootTurnCompletion: boolean;
  nextStatus: ThreadStatus | null;
  thread: ReturnType<typeof getThread>;
  turn: ThreadTurnRecord | null;
}

function lifecycleEventForTurnCompletion(
  status: Extract<ThreadEvent, { type: "turn/completed" }>["status"],
): ThreadLifecycleEvent {
  if (status === "failed") {
    return { type: "run.failed" };
  }
  if (status === "interrupted") {
    return { type: "stop.settled" };
  }
  return { type: "run.succeeded" };
}

export function applyTurnCompletedEvent(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  payload: Extract<ThreadEvent, { type: "turn/completed" }>,
): ApplyTurnCompletedEventResult {
  const thread = getThread(deps.db, payload.threadId);
  if (!thread) {
    return {
      isRootTurnCompletion: false,
      nextStatus: null,
      thread: null,
      turn: null,
    };
  }

  const turnId = requireThreadEventScopeTurnId({
    type: payload.type,
    scope: payload.scope,
  });
  const isRootTurnCompletion = hasRootStoredTurnStarted(deps.db, {
    threadId: payload.threadId,
    turnId,
  });
  // Telemetry is strictly observational. It must cover nested turns and be
  // durable before idle pruning, but a malformed historical event must never
  // prevent the completion lifecycle from settling.
  const turn = materializeTurnRecord(deps, { threadId: payload.threadId, turnId });
  if (!isRootTurnCompletion) {
    return { isRootTurnCompletion, nextStatus: null, thread, turn };
  }

  const outcome = applyLoggedThreadLifecycleEvent(deps, {
    event: lifecycleEventForTurnCompletion(payload.status),
    threadId: payload.threadId,
  });
  const nextStatus = outcome.applied ? outcome.thread.status : null;

  if (nextStatus) {
    resetActiveThreadEventPruningState(payload.threadId);
  }

  if (nextStatus === "idle") {
    pruneThreadEventHistoryBestEffort(deps, {
      mode: "idle",
      threadId: payload.threadId,
    });
  }

  return { isRootTurnCompletion, nextStatus, thread, turn };
}

function materializeTurnRecord(
  deps: Pick<AppDeps, "db" | "logger">,
  args: { threadId: string; turnId: string },
): ThreadTurnRecord | null {
  try {
    return upsertThreadTurnRecord(
      deps.db,
      buildThreadTurnRecord(deps.db, args),
    );
  } catch (error) {
    deps.logger.warn(
      { err: error, threadId: args.threadId, turnId: args.turnId },
      "Failed to materialize turn telemetry",
    );
    return null;
  }
}

/**
 * Fills a telemetry gap without ever replacing an existing record: a record
 * written at completion time was built before idle pruning stripped event
 * detail, so rebuilding it from the surviving events can only lose data. The
 * existence check and the write share one synchronous tick, so a turn that
 * completes while the backfill runs keeps its completion-time record.
 */
function fillMissingTurnRecord(
  deps: Pick<AppDeps, "db" | "logger">,
  args: { threadId: string; turnId: string },
): ThreadTurnRecord | null {
  if (getThreadTurnRecord(deps.db, args) !== null) {
    return null;
  }
  return materializeTurnRecord(deps, args);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Turns rebuilt between event-loop yields. */
const TURN_TELEMETRY_BACKFILL_BATCH_SIZE = 25;

export interface ThreadTurnRecordBackfillResult {
  inspected: number;
  materialized: number;
}

/**
 * Rebuild missing turn telemetry from the durable event log. This is deliberately
 * projection-only: replaying old completions must not re-run lifecycle effects,
 * notifications, pruning, or plugin hooks.
 *
 * Only completions with no materialized record are candidates, so a boot with
 * nothing to fill costs one query. Rebuilding a turn decodes its whole event
 * range, so the work is batched behind event-loop yields: the caller's tick
 * (server boot) and request handling must never wait on total thread history.
 */
export async function backfillThreadTurnRecords(
  deps: Pick<AppDeps, "db" | "logger">,
): Promise<ThreadTurnRecordBackfillResult> {
  await yieldToEventLoop();
  const rows = deps.db
    .select({
      data: storedEvents.data,
      providerThreadId: storedEvents.providerThreadId,
      scopeKind: storedEvents.scopeKind,
      threadId: storedEvents.threadId,
      turnId: storedEvents.turnId,
      type: storedEvents.type,
    })
    .from(storedEvents)
    .leftJoin(
      threadTurns,
      and(
        eq(threadTurns.threadId, storedEvents.threadId),
        eq(threadTurns.turnId, storedEvents.turnId),
      ),
    )
    .where(
      and(
        eq(storedEvents.type, "turn/completed"),
        isNotNull(storedEvents.turnId),
        isNull(threadTurns.turnId),
      ),
    )
    .all();

  let materialized = 0;
  for (const [index, row] of rows.entries()) {
    if (index > 0 && index % TURN_TELEMETRY_BACKFILL_BATCH_SIZE === 0) {
      await yieldToEventLoop();
    }
    if (row.turnId === null) continue;
    try {
      const event = parseStoredThreadEvent({
        data: JSON.parse(row.data),
        providerThreadId: row.providerThreadId,
        scope:
          row.scopeKind === "turn" ? turnScope(row.turnId) : threadScope(),
        threadId: row.threadId,
        type: row.type,
      });
      if (event.type !== "turn/completed") continue;
      if (fillMissingTurnRecord(deps, { threadId: row.threadId, turnId: row.turnId })) {
        materialized += 1;
      }
    } catch (error) {
      deps.logger.warn(
        { err: error, threadId: row.threadId, turnId: row.turnId },
        "Skipped malformed historical turn completion during telemetry backfill",
      );
    }
  }
  return { inspected: rows.length, materialized };
}
