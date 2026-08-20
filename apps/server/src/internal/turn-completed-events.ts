import {
  getThread,
  hasRootStoredTurnStarted,
  upsertThreadTurnRecord,
} from "@bb/db";
import {
  requireThreadEventScopeTurnId,
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
  let turn: ThreadTurnRecord | null = null;
  try {
    turn = upsertThreadTurnRecord(
      deps.db,
      buildThreadTurnRecord(deps.db, { threadId: payload.threadId, turnId }),
    );
  } catch (error) {
    deps.logger.warn(
      { err: error, threadId: payload.threadId, turnId },
      "Failed to materialize turn telemetry",
    );
  }
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
