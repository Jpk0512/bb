import { eq } from "drizzle-orm";
import {
  events as storedEvents,
  getThread,
  hasRootStoredTurnStarted,
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
 * Rebuild missing turn telemetry from the durable event log. This is deliberately
 * projection-only: replaying old completions must not re-run lifecycle effects,
 * notifications, pruning, or plugin hooks.
 */
export function backfillThreadTurnRecords(
  deps: Pick<AppDeps, "db" | "logger">,
): { inspected: number; materialized: number } {
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
    .where(eq(storedEvents.type, "turn/completed"))
    .all();

  let materialized = 0;
  for (const row of rows) {
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
      if (materializeTurnRecord(deps, { threadId: row.threadId, turnId: row.turnId })) {
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
