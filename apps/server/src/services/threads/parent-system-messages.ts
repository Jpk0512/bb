import {
  getEnvironment,
  getThread,
  requireThreadLifecycleEventApplied,
  type DbTransaction,
} from "@bb/db";
import type {
  PromptInput,
  PromptMentionResource,
  PromptTextMention,
  ResolvedThreadExecutionOptions,
  SystemMessageKind,
  SystemMessageSubject,
  Thread,
} from "@bb/domain";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { requireThreadEnvironment } from "../lib/entity-lookup.js";
import {
  addRequestIdToTurnSubmitCommandPayload,
  buildExecutionOptions,
  prepareTurnSubmitCommandPayload,
  type PreparedTurnSubmitCommandPayload,
} from "./thread-commands.js";
import {
  ensureThreadCanStartRequest,
  prepareReadyThreadTurnCommand,
  prepareReadyThreadTurnDispatch,
} from "./thread-lifecycle.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import {
  appendClientTurnEventInTransaction,
  appendPreparedClientTurnRequestedEventInTransaction,
  createClientTurnRequestId,
  getActiveTurnId,
} from "./thread-events.js";
import {
  dispatchTurnDuringReprovision,
  requireReadyThreadEnvironment,
  type ReadyThreadEnvironment,
} from "./thread-turn-dispatch.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  startLiveHostCommand,
} from "../hosts/live-command.js";

const PARENT_SYSTEM_MESSAGE_SOURCE = "tell";

/**
 * Why a parent-facing system message did or did not land.
 *
 * The distinction is load-bearing for durable announcements: `undeliverable`
 * means the intent can be discharged (the parent is archived or gone and never
 * coming back), while `deferred` means the parent simply cannot accept a turn
 * right now — an unanswered interaction, or a status race with a turn that
 * started underneath us — and the caller must retry rather than drop. Treating
 * `deferred` as failure is what used to strand orchestrator parents forever.
 */
export type ParentSystemMessageDeliveryOutcome =
  | { status: "delivered" }
  | {
      status: "undeliverable";
      reason: "thread-missing" | "thread-archived" | "thread-deleted";
    }
  | { status: "deferred"; reason: "pending-interaction" | "status-changed" };

const PARENT_SYSTEM_MESSAGE_DELIVERED: ParentSystemMessageDeliveryOutcome = {
  status: "delivered",
};

// Family-B taxonomy stamping carried alongside the message input from each emit
// site to the persisted `client/turn/requested` event. `senderThreadId` is null
// for these `initiator: "system"` messages, so the subject must be stamped at
// emit time.
export interface ParentSystemMessageTaxonomy {
  systemMessageKind: SystemMessageKind;
  systemMessageSubject: SystemMessageSubject | null;
}

interface QueueParentSystemMessageArgs extends ParentSystemMessageTaxonomy {
  input: PromptInput[];
  parentThreadId: string;
}

export interface ParentSystemRenderedMention {
  resource: PromptMentionResource;
  serializedText: string;
}

export interface ParentSystemThreadMentionSource {
  id: string;
  projectId: string;
  title: string | null;
}

interface ParentSystemTextSegment {
  kind: "text";
  text: string;
}

interface ParentSystemMentionSegment {
  kind: "mention";
  mention: ParentSystemRenderedMention;
}

export type ParentSystemInputSegment =
  | ParentSystemTextSegment
  | ParentSystemMentionSegment;

interface BuildParentSystemInputFromSegmentsArgs {
  segments: readonly ParentSystemInputSegment[];
}

interface BuildParentSystemInputFromTemplateSlotArgs {
  renderedText: string;
  segments: readonly ParentSystemInputSegment[];
  slot: string;
}

interface BuildParentSystemThreadMentionArgs {
  thread: ParentSystemThreadMentionSource;
}

interface RenderedParentSystemSlotParts {
  prefix: string;
  suffix: string;
}

interface QueueReadyParentSystemMessageArgs extends ParentSystemMessageTaxonomy {
  environment: ReadyThreadEnvironment;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  thread: Thread;
}

interface QueueActiveParentSystemMessageInTransactionArgs extends QueueReadyParentSystemMessageArgs {
  sessionId: string;
  preparedCommand: PreparedTurnSubmitCommandPayload;
}

interface QueueActiveParentSystemMessageResult {
  command: Extract<HostDaemonCommand, { type: "turn.submit" }> | null;
  queued: boolean;
}

function splitRenderedParentSystemSlot(
  args: BuildParentSystemInputFromTemplateSlotArgs,
): RenderedParentSystemSlotParts {
  const start = args.renderedText.indexOf(args.slot);
  if (start === -1) {
    throw new Error("Parent system template slot was not found in message");
  }
  const next = args.renderedText.indexOf(args.slot, start + args.slot.length);
  if (next !== -1) {
    throw new Error("Parent system template slot must be unique in message");
  }

  return {
    prefix: args.renderedText.slice(0, start),
    suffix: args.renderedText.slice(start + args.slot.length),
  };
}

export function buildParentSystemInputFromSegments(
  args: BuildParentSystemInputFromSegmentsArgs,
): PromptInput[] {
  let text = "";
  const mentions: PromptTextMention[] = [];

  for (const segment of args.segments) {
    if (segment.kind === "text") {
      text += segment.text;
      continue;
    }

    if (segment.mention.serializedText.length === 0) {
      throw new Error("Parent system mention text must not be empty");
    }
    const start = text.length;
    text += segment.mention.serializedText;
    mentions.push({
      start,
      end: text.length,
      resource: segment.mention.resource,
    });
  }

  return [{ type: "text", text, mentions }];
}

export function buildParentSystemInputFromTemplateSlot(
  args: BuildParentSystemInputFromTemplateSlotArgs,
): PromptInput[] {
  const parts = splitRenderedParentSystemSlot(args);
  return buildParentSystemInputFromSegments({
    segments: [
      { kind: "text", text: parts.prefix },
      ...args.segments,
      { kind: "text", text: parts.suffix },
    ],
  });
}

/**
 * Canonical display label for a thread that is the subject of a parent-facing
 * system message: the trimmed title, or the thread id when untitled. Shared by
 * the stamped `systemMessageSubject.threadName` and the body's `@thread`
 * mention label so the two can't drift.
 */
export function parentSystemThreadLabel(thread: {
  id: string;
  title: string | null;
}): string {
  return thread.title?.trim() || thread.id;
}

export function buildParentSystemThreadMention(
  args: BuildParentSystemThreadMentionArgs,
): ParentSystemRenderedMention {
  return {
    serializedText: `@thread:${args.thread.id}`,
    resource: {
      kind: "thread",
      label: parentSystemThreadLabel(args.thread),
      projectId: args.thread.projectId,
      threadId: args.thread.id,
    },
  };
}

function queueActiveParentSystemMessageInTransaction(
  tx: DbTransaction,
  args: QueueActiveParentSystemMessageInTransactionArgs,
): QueueActiveParentSystemMessageResult {
  const currentThread = getThread(tx, args.thread.id);
  if (
    !currentThread ||
    currentThread.environmentId !== args.environment.id ||
    currentThread.status !== "active" ||
    currentThread.archivedAt !== null ||
    currentThread.deletedAt !== null
  ) {
    return { command: null, queued: false };
  }

  const expectedSteerTurnId = getActiveTurnId({ db: tx }, args.thread.id);
  const request = appendClientTurnEventInTransaction(tx, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    type: "client/turn/requested",
    input: args.input,
    execution: args.execution,
    initiator: "system",
    senderThreadId: null,
    systemMessageKind: args.systemMessageKind,
    systemMessageSubject: args.systemMessageSubject,
    requestMethod: "turn/start",
    source: PARENT_SYSTEM_MESSAGE_SOURCE,
    target: {
      kind: "auto",
      expectedTurnId: expectedSteerTurnId,
    },
  });
  return {
    command: addRequestIdToTurnSubmitCommandPayload({
      requestId: request.requestId,
      preparedCommand: {
        ...args.preparedCommand,
        target: {
          mode: "auto",
          expectedTurnId: expectedSteerTurnId,
        },
      },
    }),
    queued: true,
  };
}

async function queueActiveParentSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueReadyParentSystemMessageArgs,
): Promise<ParentSystemMessageDeliveryOutcome> {
  const expectedSteerTurnId = getActiveTurnId(deps, args.thread.id);
  const permissionEscalation = resolvePermissionEscalation({
    thread: args.thread,
    initiator: "system",
  });
  const session = await ensureHostSessionReadyForWork(deps, {
    hostId: args.environment.hostId,
  });
  const preparedCommand = await prepareTurnSubmitCommandPayload(deps, {
    thread: args.thread,
    input: args.input,
    execution: args.execution,
    permissionEscalation,
    target: {
      mode: "auto",
      expectedTurnId: expectedSteerTurnId,
    },
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      status: args.environment.status,
      workspaceProvisionType: args.environment.workspaceProvisionType,
    },
    // Internal parent-agent delivery must not be rejectable by plugins.
    turnDispatch: null,
  });

  const queued = deps.db.transaction(
    (tx) =>
      queueActiveParentSystemMessageInTransaction(tx, {
        ...args,
        preparedCommand,
        sessionId: session.id,
      }),
    { behavior: "immediate" },
  );
  if (!queued.queued || !queued.command) {
    // The thread moved (or its environment changed) between the pre-check and
    // this transaction. Retryable, not a failure.
    return { status: "deferred", reason: "status-changed" };
  }

  deps.hub.notifyThread(args.thread.id, ["events-appended"], {
    eventTypes: ["client/turn/requested"],
  });
  startLiveHostCommand(deps, {
    command: queued.command,
    hostId: args.environment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    onError: ({ error }) => {
      deps.logger.warn(
        { err: error, threadId: args.thread.id },
        "Live active parent system message command failed",
      );
    },
  });
  return PARENT_SYSTEM_MESSAGE_DELIVERED;
}

async function queueReadyParentSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueReadyParentSystemMessageArgs,
): Promise<ParentSystemMessageDeliveryOutcome> {
  if (args.thread.status === "active") {
    return queueActiveParentSystemMessage(deps, args);
  }

  const permissionEscalation = resolvePermissionEscalation({
    thread: args.thread,
    initiator: "system",
  });
  const requestId = createClientTurnRequestId();

  const command = await prepareReadyThreadTurnCommand(deps, {
    thread: args.thread,
    // A parent system message targets an already-started thread; forking only
    // happens at create time.
    fork: null,
    input: args.input,
    requestId,
    execution: args.execution,
    permissionEscalation,
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      status: args.environment.status,
      workspaceProvisionType: args.environment.workspaceProvisionType,
    },
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    syncGeneratedTitle: false,
    // Internal parent-agent delivery must not be rejectable by plugins.
    turnDispatch: null,
  });
  let transitioned = false;
  deps.db.transaction(
    (tx) => {
      ensureThreadCanStartRequest(args.thread);
      appendPreparedClientTurnRequestedEventInTransaction(tx, {
        threadId: args.thread.id,
        environmentId: args.environment.id,
        type: "client/turn/requested",
        input: args.input,
        execution: args.execution,
        initiator: "system",
        senderThreadId: null,
        systemMessageKind: args.systemMessageKind,
        systemMessageSubject: args.systemMessageSubject,
        requestMethod: "turn/start",
        source: PARENT_SYSTEM_MESSAGE_SOURCE,
        target: { kind: "new-turn" },
        requestId,
      });
      const dispatchKind = prepareReadyThreadTurnDispatch({
        command,
        thread: args.thread,
      });
      if (dispatchKind === "turn.submit") {
        requireThreadLifecycleEventApplied(
          applyLoggedThreadLifecycleEventInTransaction(
            { db: tx, logger: deps.logger },
            { event: { type: "run.started" }, threadId: args.thread.id },
          ),
        );
        transitioned = true;
      }
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(args.thread.id, ["events-appended"], {
    eventTypes: ["client/turn/requested"],
  });
  startLiveHostCommand(deps, {
    command: command.command,
    hostId: args.environment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    onError: ({ error }) => {
      deps.logger.warn(
        { err: error, threadId: args.thread.id },
        "Live parent system message command failed",
      );
    },
  });
  if (transitioned) {
    deps.hub.notifyThread(args.thread.id, ["status-changed"], {
      projectId: args.thread.projectId,
    });
  }
  return PARENT_SYSTEM_MESSAGE_DELIVERED;
}

export async function queueParentSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueParentSystemMessageArgs,
): Promise<ParentSystemMessageDeliveryOutcome> {
  const parentThread = getThread(deps.db, args.parentThreadId);
  if (!parentThread) {
    return { status: "undeliverable", reason: "thread-missing" };
  }
  if (parentThread.deletedAt !== null) {
    return { status: "undeliverable", reason: "thread-deleted" };
  }
  if (parentThread.archivedAt !== null) {
    return { status: "undeliverable", reason: "thread-archived" };
  }
  if (deps.pendingInteractions.hasPendingThreadInteraction(parentThread.id)) {
    // The parent is blocked on the user. Delivering now would be rejected, so
    // the announcement waits for the interaction to resolve instead.
    return { status: "deferred", reason: "pending-interaction" };
  }

  const { environment } = requireThreadEnvironment(
    deps.db,
    args.parentThreadId,
  );
  const execution = await buildExecutionOptions(
    deps,
    {},
    {
      threadId: parentThread.id,
    },
    "client/turn/requested",
  );
  if (
    await dispatchTurnDuringReprovision({
      deps,
      environment,
      execution,
      initiator: "system",
      input: args.input,
      senderThreadId: null,
      systemMessageKind: args.systemMessageKind,
      systemMessageSubject: args.systemMessageSubject,
      thread: parentThread,
    })
  ) {
    return PARENT_SYSTEM_MESSAGE_DELIVERED;
  }

  const readyEnvironment = requireReadyThreadEnvironment(
    getEnvironment(deps.db, environment.id) ?? environment,
  );
  return await queueReadyParentSystemMessage(deps, {
    thread: parentThread,
    input: args.input,
    execution,
    environment: readyEnvironment,
    systemMessageKind: args.systemMessageKind,
    systemMessageSubject: args.systemMessageSubject,
  });
}
