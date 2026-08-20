import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import {
  getThreadTurnRecord,
  appendDaemonEventsInTransaction,
  deriveStoredEventItemFields,
  getThread,
  listCompletedTurnsByThreadIds,
  listThreadEnvironmentAssignmentsOnHost,
  MissingStoredTurnStartedError,
  events as storedEvents,
} from "@bb/db";
import type {
  AcceptedDaemonEvent,
  AppendDaemonEventInput,
  AppendDaemonEventsResult,
} from "@bb/db";
import {
  hostDaemonEventBatchRequestSchema,
  ungroupHostDaemonEvents,
  typedRoutes,
  type HostDaemonEventBatchResponse,
  type HostDaemonEventEnvelope,
  type HostDaemonInternalSchema,
  type HostDaemonRejectedEvent,
} from "@bb/host-daemon-contract";
import {
  getThreadEventScopeTurnId,
  requireThreadEventScopeTurnId,
  type ThreadEventType,
  type ThreadEventTurnStatus,
} from "@bb/domain";
import type {
  BindingLifecycleSignal,
  ProviderEventObservation,
  TurnSettledSignal,
} from "@get-bb/plugin-sdk";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../types.js";
import {
  isActivePruneTriggerThreadEventType,
  maybePruneActiveThreadEventHistory,
} from "../services/system/event-pruning.js";
import { queueChildThreadTurnNotificationBestEffort } from "../services/threads/child-thread-notifications.js";
import { isParentNotifiableChildThread } from "../services/threads/thread-parent.js";
import { getLastThreadOutput } from "../services/threads/thread-data.js";
import { runQueuedMessageAutoSendForThread } from "../services/threads/queued-messages.js";
import { deferAfterResponse } from "../services/lib/response-deferral.js";
import {
  isCommandTimeoutError,
  runtimeErrorLogFields,
} from "../services/lib/error-log-fields.js";
import { applyLoggedThreadLifecycleEvent } from "../services/threads/lifecycle-outcome.js";
import { applyTurnCompletedEvent } from "./turn-completed-events.js";
import {
  dispatchPluginBindingLifecycle,
  dispatchPluginProviderEvents,
  dispatchPluginTurnSettled,
  findPluginAgentTool,
} from "../services/plugins/plugin-agent-contributions.js";
import {
  appendChildSessionLifecycleEvent,
  getLastProviderThreadId,
} from "../services/threads/thread-events.js";
import {
  getInactiveSessionLogFields,
  requireAuthenticatedDaemonSession,
} from "./session-state.js";
import { getAuthenticatedDaemon } from "./auth.js";

interface ToStoredEventArgs {
  envelope: HostDaemonEventEnvelope;
  environmentId: string | null;
}

interface ResolvePostableEventBatchEntriesArgs {
  hostId: string;
  events: HostDaemonEventEnvelope[];
}

interface PostableEventBatchEntry {
  envelope: HostDaemonEventEnvelope;
  environmentId: string | null;
  eventIndex: number;
}

interface ResolvePostableEventBatchEntriesResult {
  entries: PostableEventBatchEntry[];
  rejectedEvents: HostDaemonEventBatchResponse["rejectedEvents"];
}

interface RejectedDaemonEventSummary {
  count: number;
  threadIds: string[];
}

const CHILD_SESSION_OUTPUT_EXCERPT_CHAR_LIMIT = 4_000;
const CHILD_SESSION_OUTPUT_TRUNCATION_MARKER = "\n\n[... output truncated ...]";

interface ResolveEventsToApplyArgs {
  db: AppDeps["db"];
  events: HostDaemonEventEnvelope[];
  insertedEventIndexes: number[];
}

interface NotifyInsertedEventThreadsDeps {
  hub: AppDeps["hub"];
}

interface NotifyInsertedEventThreadsArgs {
  eventInputs: AppendDaemonEventInput[];
  insertedInputIndexes: number[];
}

interface BuildProviderEventObservationsArgs {
  acceptedEvents: AcceptedDaemonEvent[];
  entries: PostableEventBatchEntry[];
  insertedInputIndexes: number[];
}

interface BuildRuntimeSignalsArgs {
  events: HostDaemonEventEnvelope[];
  /**
   * Captured before insertion: after an identity event is durable, looking up
   * the last provider thread id cannot tell a newly-created binding from a
   * resumed one.
   */
  previousProviderThreadIdByThreadId: ReadonlyMap<string, string | null>;
}

function parseStoredBackgroundTaskItemStatus(data: string): string | undefined {
  const parsed: unknown = JSON.parse(data);
  if (parsed === null || typeof parsed !== "object" || !("item" in parsed)) {
    return undefined;
  }
  const item = parsed.item;
  if (item === null || typeof item !== "object" || !("status" in item)) {
    return undefined;
  }
  return typeof item.status === "string" ? item.status : undefined;
}

function eventInputChangesBackgroundActivity(
  input: AppendDaemonEventInput,
): boolean {
  if (input.itemKind !== "backgroundTask") {
    return false;
  }
  if (
    input.type === "item/started" ||
    input.type === "item/backgroundTask/completed"
  ) {
    return true;
  }
  if (input.type !== "item/backgroundTask/progress") {
    return false;
  }
  try {
    return parseStoredBackgroundTaskItemStatus(input.data) !== "pending";
  } catch {
    return false;
  }
}

interface ShouldApplyEventEffectArgs {
  completedTurnKeyLookup: Set<string>;
  entry: HostDaemonEventEnvelope;
  index: number;
  insertedEventIndexLookup: Set<number>;
}

interface ListCompletedTurnKeysForStartedEventsArgs {
  batchEvents: HostDaemonEventEnvelope[];
  db: AppDeps["db"];
  insertedEventIndexLookup: ReadonlySet<number>;
}

interface TurnKeyArgs {
  threadId: string;
  turnId: string;
}

interface HasThreadCommandFailureSystemErrorForTurnDeps {
  db: AppDeps["db"];
}

interface HasThreadCommandFailureSystemErrorForTurnArgs {
  threadId: string;
  turnId: string;
}

interface HasThreadStopBeforeTurnStartedArgs {
  threadId: string;
  turnId: string;
}

interface ActivePruneCandidate {
  latestPrunableSequence: number;
  threadId: string;
}

interface ResolveActivePruneCandidatesArgs {
  acceptedEvents: AcceptedDaemonEvent[];
  events: HostDaemonEventEnvelope[];
  insertedEventIndexes: number[];
}

interface AddParentTurnNotificationFollowUpArgs {
  failedParentNotificationThreadIds: Set<string>;
  followUps: EventEffectFollowUp[];
  thread: NonNullable<ReturnType<typeof getThread>>;
  turnStatus: ThreadEventTurnStatus;
}

interface ParentTurnNotificationFollowUp {
  kind: "parent-turn-notification";
  childThreadId: string;
  projectId: string;
  parentThreadId: string;
  title: string | null;
  turnStatus: ThreadEventTurnStatus;
}

interface QueuedMessageAutoSendFollowUp {
  kind: "queued-message-auto-send";
  threadId: string;
}

type EventEffectFollowUp =
  | ParentTurnNotificationFollowUp
  | QueuedMessageAutoSendFollowUp;

function isRootTurnStartedEvent(
  event: Extract<HostDaemonEventEnvelope["event"], { type: "turn/started" }>,
): boolean {
  return !event.parentToolCallId;
}

function resolveProviderIdentifiers(event: HostDaemonEventEnvelope["event"]): {
  providerThreadId: string | null;
} {
  switch (event.type) {
    case "thread/started":
    case "client/thread/start":
    case "client/turn/requested":
    case "client/turn/rejected":
    case "client/turn/start":
    case "system/error":
    case "system/manager/user_message":
    case "system/thread/interrupted":
    case "system/operation":
    case "system/permissionGrant/lifecycle":
    case "system/userQuestion/lifecycle":
    case "system/thread-provisioning":
    case "system/childSession/lifecycle":
    case "system/provider-turn-watchdog":
      return { providerThreadId: null };
    case "thread/identity":
    case "thread/name/updated":
    case "provider/warning":
    case "provider/sessionReplaced":
    case "provider/modelFallback":
    case "provider/rateLimits/updated":
      return { providerThreadId: event.providerThreadId };
    case "thread/compacted":
      return { providerThreadId: event.providerThreadId };
    case "thread/context/cleared":
      return { providerThreadId: event.providerThreadId };
    case "thread/goal/updated":
    case "thread/goal/cleared":
      return { providerThreadId: event.providerThreadId };
    case "turn/started":
    case "turn/completed":
    case "turn/input/accepted":
    case "item/started":
    case "item/completed":
    case "item/backgroundTask/progress":
    case "item/backgroundTask/completed":
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/plan/delta":
    case "item/mcpToolCall/progress":
    case "item/toolCall/progress":
    case "thread/contextWindowUsage/updated":
    case "thread/tokenUsage/updated":
    case "turn/plan/updated":
    case "turn/diff/updated":
      return { providerThreadId: event.providerThreadId };
    case "provider/error":
    case "provider/unhandled":
      return { providerThreadId: event.providerThreadId };
    default: {
      const exhaustive: never = event;
      throw new Error(
        `Unsupported event type: ${String((exhaustive as { type?: string }).type)}`,
      );
    }
  }
}

function toStoredEvent(args: ToStoredEventArgs): AppendDaemonEventInput {
  const envelope = args.envelope;
  const { scope, type, threadId, ...data } = envelope.event;
  return {
    threadId: envelope.threadId,
    environmentId: args.environmentId,
    ...resolveProviderIdentifiers(envelope.event),
    scope,
    type,
    ...deriveStoredEventItemFields(envelope.event),
    data: JSON.stringify(data),
  };
}

/**
 * Plugin status labels are server-owned presentation metadata: providers do
 * not know about them, and old daemon clients therefore need no protocol
 * change. Persist the snapshot on both lifecycle events so historical rows
 * remain readable if a plugin later reloads or disappears.
 */
function withPluginToolStatusLabels(
  envelope: HostDaemonEventEnvelope,
): HostDaemonEventEnvelope {
  const event = envelope.event;
  if (
    (event.type !== "item/started" && event.type !== "item/completed") ||
    event.item.type !== "toolCall" ||
    event.item.server !== undefined
  ) {
    return envelope;
  }
  const statusLabels = findPluginAgentTool(event.item.tool)?.record
    .experimentalStatusLabels;
  if (statusLabels === null || statusLabels === undefined) return envelope;

  return {
    ...envelope,
    event: {
      ...event,
      item: {
        ...event.item,
        statusLabels,
      },
    },
  };
}

function notifyInsertedEventThreads(
  deps: NotifyInsertedEventThreadsDeps,
  args: NotifyInsertedEventThreadsArgs,
): void {
  const eventTypesByThreadId = new Map<string, Set<ThreadEventType>>();
  const backgroundActivityThreadIds = new Set<string>();
  for (const index of args.insertedInputIndexes) {
    const eventInput = args.eventInputs[index];
    if (eventInput) {
      const eventTypes =
        eventTypesByThreadId.get(eventInput.threadId) ??
        new Set<ThreadEventType>();
      eventTypes.add(eventInput.type);
      eventTypesByThreadId.set(eventInput.threadId, eventTypes);
      if (eventInputChangesBackgroundActivity(eventInput)) {
        backgroundActivityThreadIds.add(eventInput.threadId);
      }
    }
  }
  for (const [threadId, eventTypes] of eventTypesByThreadId) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      ...(backgroundActivityThreadIds.has(threadId)
        ? { backgroundActivityChanged: true }
        : {}),
      eventTypes: Array.from(eventTypes),
    });
  }
}

/** Provider observers receive only events whose insert committed. */
function buildProviderEventObservations(
  args: BuildProviderEventObservationsArgs,
): ProviderEventObservation[] {
  return args.acceptedEvents.map((acceptedEvent, acceptedIndex) => {
    const inputIndex = args.insertedInputIndexes[acceptedIndex];
    if (inputIndex === undefined) {
      throw new Error("Missing inserted event index for accepted daemon event");
    }
    const entry = args.entries[inputIndex];
    if (entry === undefined) {
      throw new Error("Missing daemon event entry for accepted daemon event");
    }
    const event = entry.envelope.event;
    return {
      threadId: acceptedEvent.threadId,
      environmentId: entry.environmentId,
      providerThreadId: resolveProviderIdentifiers(event).providerThreadId,
      sequence: acceptedEvent.sequence,
      turnId: getThreadEventScopeTurnId(event.scope) ?? null,
      scope: event.scope,
      event,
    };
  });
}

function bindingSignal(args: {
  detail: BindingLifecycleSignal["detail"];
  phase: BindingLifecycleSignal["phase"];
  providerId: string;
  providerThreadId: string;
  threadId: string;
}): BindingLifecycleSignal {
  return {
    threadId: args.threadId,
    providerId: args.providerId,
    providerThreadId: args.providerThreadId,
    bindingId: `${args.threadId}:${args.providerId}:${args.providerThreadId}`,
    phase: args.phase,
    detail: args.detail,
  };
}

function buildRuntimeSignals(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: BuildRuntimeSignalsArgs,
): Array<BindingLifecycleSignal | TurnSettledSignal> {
  const signals: Array<BindingLifecycleSignal | TurnSettledSignal> = [];
  const providerThreadIdByThreadId = new Map(
    args.previousProviderThreadIdByThreadId,
  );
  for (const entry of args.events) {
    const event = entry.event;
    const thread = getThread(deps.db, entry.threadId);
    if (!thread) continue;
    const providerId = thread.providerId;
    if (event.type === "turn/completed") {
      signals.push({
        threadId: entry.threadId,
        turnId: requireThreadEventScopeTurnId({
          type: event.type,
          scope: event.scope,
        }),
        providerThreadId: event.providerThreadId,
        providerId,
        requestId: null,
        outcome: event.status,
        error: null,
        providerCheckpointId: null,
        startedAt: null,
        settledAt: Date.now(),
        turn: getThreadTurnRecord(deps.db, {
          threadId: entry.threadId,
          turnId: requireThreadEventScopeTurnId({
            type: event.type,
            scope: event.scope,
          }),
        }),
      });
      continue;
    }
    if (
      event.type === "system/error" &&
      event.code === "provider_process_exited"
    ) {
      const providerThreadId = getLastProviderThreadId(deps, entry.threadId);
      signals.push({
        threadId: entry.threadId,
        turnId: getThreadEventScopeTurnId(event.scope) ?? null,
        providerThreadId,
        providerId,
        requestId: null,
        outcome: "provider-session-lost",
        error: event.message,
        providerCheckpointId: null,
        startedAt: null,
        settledAt: Date.now(),
        turn: null,
      });
      if (providerThreadId !== null) {
        signals.push(
          bindingSignal({
            threadId: entry.threadId,
            providerId,
            providerThreadId,
            phase: "crashed",
            detail: { message: event.message },
          }),
        );
      }
      continue;
    }
    const providerThreadId = resolveProviderIdentifiers(event).providerThreadId;
    if (providerThreadId === null) continue;
    if (event.type === "thread/identity") {
      const phase =
        providerThreadIdByThreadId.get(entry.threadId) === null ||
        providerThreadIdByThreadId.get(entry.threadId) === undefined
          ? "start"
          : "resume";
      signals.push(
        bindingSignal({
          threadId: entry.threadId,
          providerId,
          providerThreadId,
          phase,
          detail: null,
        }),
      );
      providerThreadIdByThreadId.set(entry.threadId, providerThreadId);
    } else if (event.type === "provider/sessionReplaced") {
      signals.push(
        bindingSignal({
          threadId: entry.threadId,
          providerId,
          providerThreadId,
          phase: "session-replaced",
          detail: { reason: event.reason, contextLost: event.contextLost },
        }),
      );
    } else if (event.type === "provider/modelFallback") {
      signals.push(
        bindingSignal({
          threadId: entry.threadId,
          providerId,
          providerThreadId,
          phase: "model-changed",
          detail: {
            originalModel: event.originalModel,
            fallbackModel: event.fallbackModel,
            reason: event.reason,
          },
        }),
      );
    } else if (event.type === "provider/rateLimits/updated") {
      signals.push(
        bindingSignal({
          threadId: entry.threadId,
          providerId,
          providerThreadId,
          phase: "health-degraded",
          detail: event.rateLimits,
        }),
      );
    }
  }
  return signals;
}

function deferPluginRuntimeHooks(args: {
  deps: LoggedPendingInteractionWorkSessionDeps;
  providerEvents: ProviderEventObservation[];
  signals: Array<BindingLifecycleSignal | TurnSettledSignal>;
}): void {
  if (args.providerEvents.length === 0 && args.signals.length === 0) return;
  deferAfterResponse({
    config: args.deps.config,
    logger: args.deps.logger,
    name: "Plugin runtime hook dispatch",
    work: () => {
      dispatchPluginProviderEvents(args.providerEvents);
      for (const signal of args.signals) {
        if ("outcome" in signal) {
          dispatchPluginTurnSettled(signal);
        } else {
          dispatchPluginBindingLifecycle(signal);
        }
      }
      return Promise.resolve();
    },
  });
}

function addParentTurnNotificationFollowUp(
  args: AddParentTurnNotificationFollowUpArgs,
): void {
  if (!isParentNotifiableChildThread(args.thread)) {
    return;
  }
  if (args.turnStatus === "failed") {
    if (args.failedParentNotificationThreadIds.has(args.thread.id)) {
      return;
    }
    args.failedParentNotificationThreadIds.add(args.thread.id);
  }
  args.followUps.push({
    kind: "parent-turn-notification",
    childThreadId: args.thread.id,
    projectId: args.thread.projectId,
    parentThreadId: args.thread.parentThreadId,
    title: args.thread.title,
    turnStatus: args.turnStatus,
  });
}

function appendChildSessionLifecycleUpdate(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db" | "hub">,
  args: {
    outputExcerpt?: string | null;
    status: "running" | "completed" | "failed" | "interrupted";
    statusReason?: string | null;
    thread: NonNullable<ReturnType<typeof getThread>>;
  },
): void {
  const { thread } = args;
  if (thread.parentThreadId === null || thread.childKind === null) {
    return;
  }
  appendChildSessionLifecycleEvent(deps, {
    childKind: thread.childKind,
    childThreadId: thread.id,
    model: null,
    outputExcerpt: args.outputExcerpt ?? null,
    parentThreadId: thread.parentThreadId,
    providerId: thread.providerId,
    scope: "thread",
    status: args.status,
    statusReason: args.statusReason ?? null,
    title: thread.title ?? thread.titleFallback ?? "Child session",
  });
}

function childSessionOutputExcerpt(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  childThreadId: string,
): string | null {
  const output = getLastThreadOutput(deps.db, childThreadId)?.trim();
  if (!output) {
    return null;
  }
  if (output.length <= CHILD_SESSION_OUTPUT_EXCERPT_CHAR_LIMIT) {
    return output;
  }
  const retainedLength = Math.max(
    0,
    CHILD_SESSION_OUTPUT_EXCERPT_CHAR_LIMIT -
      CHILD_SESSION_OUTPUT_TRUNCATION_MARKER.length,
  );
  return `${output.slice(0, retainedLength).trimEnd()}${CHILD_SESSION_OUTPUT_TRUNCATION_MARKER}`;
}

async function applyEventEffects(
  deps: LoggedPendingInteractionWorkSessionDeps,
  events: HostDaemonEventEnvelope[],
): Promise<EventEffectFollowUp[]> {
  // Apply event-owned state changes before returning so the accepted batch and
  // immediately visible thread state agree. Follow-ups that may queue daemon
  // work stay deferred to avoid command waits inside daemon ingress.
  const followUps: EventEffectFollowUp[] = [];
  const failedParentNotificationThreadIds = new Set<string>();
  for (const entry of events) {
    try {
      const event = entry.event;
      if (event.type === "turn/started") {
        const turnId = requireThreadEventScopeTurnId({
          type: event.type,
          scope: event.scope,
        });
        // Event-log staleness stays caller-side: a stop recorded before this
        // turn started means the activation is stale.
        if (
          hasThreadStopBeforeTurnStarted(deps, {
            threadId: entry.threadId,
            turnId,
          })
        ) {
          continue;
        }
        if (hasThreadAlreadyStartedRun(deps, entry.threadId)) {
          continue;
        }
        if (!isRootTurnStartedEvent(event)) {
          continue;
        }
        applyLoggedThreadLifecycleEvent(deps, {
          event: { type: "run.started" },
          threadId: entry.threadId,
        });
        const thread = getThread(deps.db, entry.threadId);
        if (thread) {
          appendChildSessionLifecycleUpdate(deps, {
            status: "running",
            thread,
          });
        }
        continue;
      }

      if (event.type === "turn/completed") {
        const turnId = requireThreadEventScopeTurnId({
          type: event.type,
          scope: event.scope,
        });
        if (
          event.status !== "interrupted" &&
          hasThreadStopBeforeTurnStarted(deps, {
            threadId: entry.threadId,
            turnId,
          })
        ) {
          continue;
        }
        const turnCompleted = applyTurnCompletedEvent(deps, {
          ...event,
          threadId: entry.threadId,
        });
        if (turnCompleted.thread && turnCompleted.isRootTurnCompletion) {
          appendChildSessionLifecycleUpdate(deps, {
            outputExcerpt: childSessionOutputExcerpt(
              deps,
              turnCompleted.thread.id,
            ),
            status:
              event.status === "completed"
                ? "completed"
                : event.status === "failed"
                  ? "failed"
                  : "interrupted",
            thread: turnCompleted.thread,
          });
        }
        if (
          turnCompleted.thread &&
          turnCompleted.isRootTurnCompletion &&
          // Forks / side chats are user-initiated branches, not agent-delegated
          // sub-tasks, so a completed turn must not post a "child finished"
          // notification back into their parent thread.
          isParentNotifiableChildThread(turnCompleted.thread)
        ) {
          // Command-result failures already notify parent threads for failed turns
          // without terminal events; late terminal events still own status effects.
          const alreadyHandledByCommandFailure =
            event.status === "failed" &&
            hasThreadCommandFailureSystemErrorForTurn(deps, {
              threadId: turnCompleted.thread.id,
              turnId,
            });
          if (!alreadyHandledByCommandFailure) {
            addParentTurnNotificationFollowUp({
              failedParentNotificationThreadIds,
              followUps,
              thread: turnCompleted.thread,
              turnStatus: event.status,
            });
          }
        }
        if (
          event.status === "completed" &&
          turnCompleted.nextStatus === "idle"
        ) {
          followUps.push({
            kind: "queued-message-auto-send",
            threadId: entry.threadId,
          });
        }
        continue;
      }

      if (
        event.type === "system/error" &&
        event.code === "provider_process_exited"
      ) {
        const thread = getThread(deps.db, entry.threadId);
        if (!thread) {
          continue;
        }
        deps.pendingInteractions.interruptPendingInteractionsForThreadIds({
          threadIds: [entry.threadId],
          reason:
            "Provider process exited while awaiting user interaction; retry the thread to continue",
        });
        const outcome = applyLoggedThreadLifecycleEvent(deps, {
          event: { type: "run.failed" },
          threadId: entry.threadId,
        });
        if (outcome.applied) {
          appendChildSessionLifecycleUpdate(deps, {
            outputExcerpt: childSessionOutputExcerpt(deps, thread.id),
            status: "failed",
            statusReason: event.message,
            thread,
          });
          addParentTurnNotificationFollowUp({
            failedParentNotificationThreadIds,
            followUps,
            thread,
            turnStatus: "failed",
          });
        }
        continue;
      }
    } catch (error) {
      deps.logger.error(
        {
          err: error,
          eventType: entry.event.type,
          threadId: entry.threadId,
        },
        "Failed to apply event side effects",
      );
    }
  }
  return followUps;
}

async function executeEventFollowUpBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  followUp: EventEffectFollowUp,
): Promise<void> {
  try {
    switch (followUp.kind) {
      case "parent-turn-notification":
        await queueChildThreadTurnNotificationBestEffort(deps, {
          childThread: {
            id: followUp.childThreadId,
            projectId: followUp.projectId,
            title: followUp.title,
          },
          parentThreadId: followUp.parentThreadId,
          turnStatus: followUp.turnStatus,
        });
        return;
      case "queued-message-auto-send":
        await runQueuedMessageAutoSendForThread(deps, {
          threadId: followUp.threadId,
        });
        return;
    }
  } catch (error) {
    if (isCommandTimeoutError(error)) {
      deps.logger.warn(
        {
          followUp,
          ...runtimeErrorLogFields(deps.config, error),
        },
        "Event follow-up deferred by host timeout",
      );
      return;
    }
    deps.logger.error(
      {
        err: error,
        followUp,
      },
      "Failed to run event follow-up",
    );
  }
}

function deferEventFollowUpBatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  followUps: EventEffectFollowUp[],
): void {
  if (followUps.length === 0) {
    return;
  }

  deferAfterResponse({
    config: deps.config,
    logger: deps.logger,
    name: "Event follow-up scheduling",
    work: async () => {
      await Promise.all(
        followUps.map((followUp) =>
          executeEventFollowUpBestEffort(deps, followUp),
        ),
      );
    },
  });
}

function toTurnKey(args: TurnKeyArgs): string {
  return `${args.threadId}:${args.turnId}`;
}

function hasThreadCommandFailureSystemErrorForTurn(
  deps: HasThreadCommandFailureSystemErrorForTurnDeps,
  args: HasThreadCommandFailureSystemErrorForTurnArgs,
): boolean {
  return (
    deps.db
      .select({ id: storedEvents.id })
      .from(storedEvents)
      .where(
        and(
          eq(storedEvents.threadId, args.threadId),
          eq(storedEvents.turnId, args.turnId),
          eq(storedEvents.scopeKind, "turn"),
          eq(storedEvents.type, "system/error"),
          sql`json_extract(${storedEvents.data}, '$.code') = 'thread_command_failed'`,
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function hasThreadStopBeforeTurnStarted(
  deps: Pick<AppDeps, "db">,
  args: HasThreadStopBeforeTurnStartedArgs,
): boolean {
  const turnStarted = deps.db
    .select({ sequence: storedEvents.sequence })
    .from(storedEvents)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.turnId, args.turnId),
        eq(storedEvents.type, "turn/started"),
      ),
    )
    .limit(1)
    .get();
  if (!turnStarted) {
    return false;
  }

  const latestTurnRequest = deps.db
    .select({ sequence: storedEvents.sequence })
    .from(storedEvents)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.type, "client/turn/requested"),
        lt(storedEvents.sequence, turnStarted.sequence),
      ),
    )
    .orderBy(desc(storedEvents.sequence))
    .limit(1)
    .get();
  const lowerSequence = latestTurnRequest?.sequence ?? 0;

  return (
    deps.db
      .select({ id: storedEvents.id })
      .from(storedEvents)
      .where(
        and(
          eq(storedEvents.threadId, args.threadId),
          eq(storedEvents.type, "system/thread/interrupted"),
          gt(storedEvents.sequence, lowerSequence),
          lt(storedEvents.sequence, turnStarted.sequence),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function hasThreadAlreadyStartedRun(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): boolean {
  const thread = getThread(deps.db, threadId);
  return (
    thread?.status === "active" &&
    thread.archivedAt === null &&
    thread.deletedAt === null
  );
}

function listCompletedTurnKeysForStartedEvents(
  args: ListCompletedTurnKeysForStartedEventsArgs,
): Set<string> {
  const startedTurnKeys = new Set<string>();
  const threadIds = new Set<string>();

  for (const entry of args.batchEvents) {
    if (entry.event.type !== "turn/started") {
      continue;
    }
    startedTurnKeys.add(
      toTurnKey({
        threadId: entry.threadId,
        turnId: requireThreadEventScopeTurnId({
          type: entry.event.type,
          scope: entry.event.scope,
        }),
      }),
    );
    threadIds.add(entry.threadId);
  }

  if (startedTurnKeys.size === 0 || threadIds.size === 0) {
    return new Set<string>();
  }

  const completedTurnKeys = new Set<string>();
  for (const row of listCompletedTurnsByThreadIds(args.db, [...threadIds])) {
    const turnKey = toTurnKey({
      threadId: row.threadId,
      turnId: row.turnId,
    });
    if (startedTurnKeys.has(turnKey)) {
      completedTurnKeys.add(turnKey);
    }
  }

  for (const [index, entry] of args.batchEvents.entries()) {
    if (
      !args.insertedEventIndexLookup.has(index) ||
      entry.event.type !== "turn/completed"
    ) {
      continue;
    }
    completedTurnKeys.delete(
      toTurnKey({
        threadId: entry.threadId,
        turnId: requireThreadEventScopeTurnId({
          type: entry.event.type,
          scope: entry.event.scope,
        }),
      }),
    );
  }
  return completedTurnKeys;
}

function shouldApplyEventEffect(args: ShouldApplyEventEffectArgs): boolean {
  const { entry } = args;

  if (entry.event.type === "turn/completed") {
    return args.insertedEventIndexLookup.has(args.index);
  }

  if (entry.event.type === "turn/started") {
    return !args.completedTurnKeyLookup.has(
      toTurnKey({
        threadId: entry.threadId,
        turnId: requireThreadEventScopeTurnId({
          type: entry.event.type,
          scope: entry.event.scope,
        }),
      }),
    );
  }

  // Keep other projections replayable so a daemon retry can repair them if the
  // event insert committed before the projection side effect ran.
  return true;
}

function resolveEventsToApply(
  args: ResolveEventsToApplyArgs,
): HostDaemonEventEnvelope[] {
  const insertedEventIndexLookup = new Set(args.insertedEventIndexes);
  const completedTurnKeyLookup = listCompletedTurnKeysForStartedEvents({
    batchEvents: args.events,
    db: args.db,
    insertedEventIndexLookup,
  });

  return args.events.filter((entry, index) =>
    shouldApplyEventEffect({
      completedTurnKeyLookup,
      entry,
      index,
      insertedEventIndexLookup,
    }),
  );
}

function resolveActivePruneCandidates(
  args: ResolveActivePruneCandidatesArgs,
): ActivePruneCandidate[] {
  const latestPrunableSequenceByThreadId = new Map<string, number>();

  for (const [acceptedIndex, acceptedEvent] of args.acceptedEvents.entries()) {
    const inputIndex = args.insertedEventIndexes[acceptedIndex];
    if (inputIndex === undefined) {
      throw new Error("Missing inserted event index for accepted daemon event");
    }
    const entry = args.events[inputIndex];
    if (entry === undefined) {
      throw new Error("Missing daemon event for inserted event index");
    }
    if (!isActivePruneTriggerThreadEventType(entry.event.type)) {
      continue;
    }

    const previousSequence = latestPrunableSequenceByThreadId.get(
      entry.threadId,
    );
    if (
      previousSequence === undefined ||
      acceptedEvent.sequence > previousSequence
    ) {
      latestPrunableSequenceByThreadId.set(
        entry.threadId,
        acceptedEvent.sequence,
      );
    }
  }

  return [...latestPrunableSequenceByThreadId.entries()].map(
    ([threadId, latestPrunableSequence]) => ({
      threadId,
      latestPrunableSequence,
    }),
  );
}

function summarizeRejectedDaemonEvents(
  rejectedEvents: readonly HostDaemonRejectedEvent[],
): RejectedDaemonEventSummary {
  return {
    count: rejectedEvents.length,
    threadIds: [...new Set(rejectedEvents.map((event) => event.threadId))],
  };
}

function resolvePostableEventBatchEntries(
  deps: Pick<AppDeps, "db">,
  args: ResolvePostableEventBatchEntriesArgs,
): ResolvePostableEventBatchEntriesResult {
  const threadIds = [...new Set(args.events.map((entry) => entry.threadId))];
  if (threadIds.length === 0) {
    return {
      entries: [],
      rejectedEvents: [],
    };
  }

  const ownedThreads = listThreadEnvironmentAssignmentsOnHost(deps.db, {
    hostId: args.hostId,
    threadIds,
  });

  const canonicalEnvironmentIdByThreadId = new Map<string, string | null>();
  for (const ownedThread of ownedThreads) {
    canonicalEnvironmentIdByThreadId.set(
      ownedThread.threadId,
      ownedThread.environmentId,
    );
  }

  const entries: PostableEventBatchEntry[] = [];
  const rejectedEvents: HostDaemonRejectedEvent[] = [];
  for (const [eventIndex, entry] of args.events.entries()) {
    if (!canonicalEnvironmentIdByThreadId.has(entry.threadId)) {
      rejectedEvents.push({
        eventIndex,
        reason: "thread_not_owned_by_host",
        threadId: entry.threadId,
      });
      continue;
    }
    const canonicalEnvironmentId =
      canonicalEnvironmentIdByThreadId.get(entry.threadId) ?? null;
    entries.push({
      envelope: entry,
      environmentId: canonicalEnvironmentId,
      eventIndex,
    });
  }

  return {
    entries,
    rejectedEvents,
  };
}

export function registerInternalEventRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/events",
    hostDaemonEventBatchRequestSchema,
    async (context, payload) => {
      let session: ReturnType<typeof requireAuthenticatedDaemonSession>;
      try {
        session = requireAuthenticatedDaemonSession({
          context,
          db: deps.db,
          sessionId: payload.sessionId,
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.body.code === "inactive_session"
        ) {
          deps.logger.info(
            getInactiveSessionLogFields(deps.db, {
              authenticatedHostId: getAuthenticatedDaemon(context).hostId,
              now: Date.now(),
              sessionId: payload.sessionId,
            }),
            "Daemon event batch for inactive session",
          );
        }
        throw error;
      }
      const events = ungroupHostDaemonEvents(payload.eventGroups);
      const { entries, rejectedEvents } = resolvePostableEventBatchEntries(
        deps,
        {
          hostId: session.hostId,
          events,
        },
      );
      if (rejectedEvents.length > 0) {
        deps.logger.warn(
          {
            hostId: session.hostId,
            rejectedEvents: summarizeRejectedDaemonEvents(rejectedEvents),
            sessionId: session.id,
          },
          "Rejected daemon events for threads outside the session host",
        );
      }
      const labelledEntries = entries.map((entry) => ({
        ...entry,
        envelope: withPluginToolStatusLabels(entry.envelope),
      }));
      const eventInputs = labelledEntries.map((entry) => {
        return toStoredEvent({
          envelope: entry.envelope,
          environmentId: entry.environmentId,
        });
      });
      const postableEvents = labelledEntries.map((entry) => entry.envelope);
      const previousProviderThreadIdByThreadId = new Map<
        string,
        string | null
      >();
      for (const entry of postableEvents) {
        if (
          entry.event.type === "thread/identity" &&
          !previousProviderThreadIdByThreadId.has(entry.threadId)
        ) {
          previousProviderThreadIdByThreadId.set(
            entry.threadId,
            getLastProviderThreadId(deps, entry.threadId),
          );
        }
      }
      let appendResult: AppendDaemonEventsResult;
      try {
        appendResult = deps.db.transaction(
          (tx) => appendDaemonEventsInTransaction(tx, eventInputs),
          { behavior: "immediate" },
        );
      } catch (error) {
        if (error instanceof MissingStoredTurnStartedError) {
          deps.logger.warn(
            {
              ...error.details,
              sessionId: session.id,
              ...runtimeErrorLogFields(deps.config, error),
            },
            "Rejected daemon event before turn/started",
          );
          throw new ApiError(409, "invalid_request", error.message);
        }
        throw error;
      }
      for (const index of appendResult.skippedTurnUnstartedInputIndexes) {
        const skipped = eventInputs[index];
        deps.logger.warn(
          {
            eventType: skipped?.type,
            threadId: skipped?.threadId,
            sessionId: session.id,
          },
          "Dropped orphan thread-state snapshot with no stored turn/started",
        );
      }
      notifyInsertedEventThreads(deps, {
        eventInputs,
        insertedInputIndexes: appendResult.insertedInputIndexes,
      });

      const followUps = await applyEventEffects(
        deps,
        resolveEventsToApply({
          db: deps.db,
          events: postableEvents,
          insertedEventIndexes: appendResult.insertedInputIndexes,
        }),
      );
      const insertedEvents = appendResult.insertedInputIndexes.map((index) => {
        const event = postableEvents[index];
        if (event === undefined) {
          throw new Error("Missing postable event for inserted daemon event");
        }
        return event;
      });
      deferPluginRuntimeHooks({
        deps,
        providerEvents: buildProviderEventObservations({
          acceptedEvents: appendResult.acceptedEvents,
          entries: labelledEntries,
          insertedInputIndexes: appendResult.insertedInputIndexes,
        }),
        signals: buildRuntimeSignals(deps, {
          events: insertedEvents,
          previousProviderThreadIdByThreadId,
        }),
      });
      for (const candidate of resolveActivePruneCandidates({
        acceptedEvents: appendResult.acceptedEvents,
        events: postableEvents,
        insertedEventIndexes: appendResult.insertedInputIndexes,
      })) {
        maybePruneActiveThreadEventHistory(deps, candidate);
      }

      deferEventFollowUpBatch(deps, followUps);
      return context.json({
        acceptedEvents: appendResult.acceptedEvents.map(
          (acceptedEvent, acceptedIndex) => {
            const inputIndex = appendResult.insertedInputIndexes[acceptedIndex];
            if (inputIndex === undefined) {
              throw new Error(
                "Missing inserted event index for accepted daemon event",
              );
            }
            const entry = entries[inputIndex];
            if (entry === undefined) {
              throw new Error("Missing daemon event entry for accepted event");
            }
            return {
              eventIndex: entry.eventIndex,
              sequence: acceptedEvent.sequence,
              threadId: acceptedEvent.threadId,
            };
          },
        ),
        rejectedEvents,
      });
    },
  );
}
