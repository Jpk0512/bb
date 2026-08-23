import type {
  NotificationCategory,
  PromptInput,
  SystemMessageSubject,
  ThreadEventTurnStatus,
} from "@bb/domain";
import {
  claimDueParentNotifications,
  createNotification,
  createPendingParentNotificationId,
  deferPendingParentNotifications,
  deletePendingParentNotifications,
  insertPendingParentNotification,
  listActiveBackgroundTaskCountsByThreadIds,
  listParentThreadIdsWithDueNotifications,
  markParentNotificationsInboxEmitted,
  type PendingParentNotificationRow,
} from "@bb/db";
import { renderTemplate } from "@bb/templates";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  buildParentSystemInputFromTemplateSlot,
  buildParentSystemThreadMention,
  parentSystemThreadLabel,
  queueParentSystemMessage,
  type ParentSystemMessageDeliveryOutcome,
  type ParentSystemInputSegment,
  type ParentSystemMessageTaxonomy,
  type ParentSystemRenderedMention,
  type ParentSystemThreadMentionSource,
} from "./parent-system-messages.js";
import {
  childOutcomeSystemMessageKind,
  systemMessageKindForTemplate,
} from "./system-message-kind.js";
import { getLastThreadOutput } from "./thread-data.js";

export type ChildThreadNotificationSource = ParentSystemThreadMentionSource;

export interface ChildThreadTurnNotificationBatchItem {
  activeWorkflowCount: number;
  childThread: ChildThreadNotificationSource;
  terminalOutput: string | null;
  turnStatus: ThreadEventTurnStatus;
}

interface PendingParentNotificationDelivery {
  item: ChildThreadTurnNotificationBatchItem;
  row: PendingParentNotificationRow;
}

interface RenderChildThreadTurnStatusBatchMessageArgs {
  items: ChildThreadTurnNotificationBatchItem[];
}

interface ChildThreadTurnStatusBatchLine {
  item: ChildThreadTurnNotificationBatchItem;
  mention: ParentSystemRenderedMention;
}

interface RenderChildThreadTurnStatusBatchTextArgs {
  lines: ChildThreadTurnStatusBatchLine[];
}

interface FormatChildThreadTurnStatusLineArgs {
  line: ChildThreadTurnStatusBatchLine;
}

interface BuildChildThreadTurnStatusBatchInputArgs {
  items: ChildThreadTurnNotificationBatchItem[];
}

interface BuildChildThreadNeedsAttentionInputArgs {
  blockerSummary: string | null;
  childThread: ChildThreadNotificationSource;
}

interface QueueChildThreadTurnNotificationArgs {
  childThread: ChildThreadNotificationSource;
  parentThreadId: string;
  turnStatus: ThreadEventTurnStatus;
}

interface QueueChildThreadNeedsAttentionNotificationArgs {
  blockerSummary: string | null;
  childThread: ChildThreadNotificationSource;
  parentThreadId: string;
}

const CHILD_THREAD_TURN_NOTIFICATION_BATCH_DELAY_MS = 2_000;
const CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT =
  "__BB_CHILD_THREAD_OUTCOME_BATCH_UPDATES__";
const CHILD_THREAD_MENTION_SLOT = "__BB_CHILD_THREAD_MENTION__";
const CHILD_THREAD_TERMINAL_OUTPUT_EXCERPT_CHAR_LIMIT = 4_000;
const CHILD_THREAD_OUTPUT_TRUNCATION_MARKER = "\n\n[... output truncated ...]";
const CHILD_THREAD_INSPECTION_GUIDANCE =
  "Review the thread before deciding next steps.";
const CHILD_THREAD_INTERRUPTED_GUIDANCE =
  "If the user stopped it manually, do not resume, restart, retry, replace, or continue the work unless the user explicitly asks.";
const CHILD_THREAD_BATCH_INTERRUPTED_GUIDANCE =
  "If the user stopped any interrupted thread manually, do not resume, restart, retry, replace, or continue the work unless the user explicitly asks.";
const CHILD_THREAD_NEEDS_ATTENTION_FALLBACK_SUMMARY =
  "It is blocked on a pending interaction.";
const CHILD_THREAD_RUNNING_WORKFLOW_GUIDANCE =
  "A workflow it started is still running, so this output is not its final result. The thread will report again when the workflow finishes.";
const CHILD_THREAD_BATCH_RUNNING_WORKFLOW_GUIDANCE =
  "Threads with a workflow still running have not finished; they will report again when their workflow does.";
/** Ceiling for error backoff, so a repeatedly failing parent still gets swept. */
const CHILD_THREAD_NOTIFICATION_MAX_RETRY_DELAY_MS = 60_000;
/**
 * Recheck cadence while a parent is blocked on an unanswered interaction. Kept
 * at roughly the sweep interval so answering the prompt resumes the parent
 * promptly rather than after an inflated backoff.
 */
const CHILD_THREAD_NOTIFICATION_BLOCKED_RECHECK_MS = 5_000;
/**
 * A claim older than this is assumed dead (the server died mid-delivery) and
 * may be taken over. Comfortably longer than one delivery attempt.
 */
const CHILD_THREAD_NOTIFICATION_STALE_CLAIM_MS = 120_000;
const CHILD_THREAD_NOTIFICATION_SWEEP_PARENT_LIMIT = 50;

/**
 * In-process timers are a latency optimization only: they collapse several
 * children settling at once into one system message without waiting for the
 * next sweep tick. Every timer's work is also reachable from the sweep, so
 * losing the map (restart, reload) delays an announcement but never drops it.
 */
const childThreadNotificationFlushTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

function childThreadTurnStatusLabel(turnStatus: ThreadEventTurnStatus): string {
  switch (turnStatus) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "was interrupted";
    default: {
      const exhaustiveCheck: never = turnStatus;
      return exhaustiveCheck;
    }
  }
}

function truncateChildThreadOutput(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  const retainedLength = Math.max(
    0,
    limit - CHILD_THREAD_OUTPUT_TRUNCATION_MARKER.length,
  );
  if (retainedLength === 0) {
    return CHILD_THREAD_OUTPUT_TRUNCATION_MARKER.trimStart();
  }
  return `${text.slice(0, retainedLength).trimEnd()}${CHILD_THREAD_OUTPUT_TRUNCATION_MARKER}`;
}

function formatChildThreadCompletionOutputExcerpt(
  output: string | null,
): string {
  const trimmedOutput = output?.trim();
  if (!trimmedOutput) {
    return "No final output was recorded.";
  }
  return truncateChildThreadOutput(
    trimmedOutput,
    CHILD_THREAD_TERMINAL_OUTPUT_EXCERPT_CHAR_LIMIT,
  );
}

function formatChildThreadNeedsAttentionSummary(
  summary: string | null,
): string {
  const trimmedSummary = summary?.trim();
  if (!trimmedSummary) {
    return CHILD_THREAD_NEEDS_ATTENTION_FALLBACK_SUMMARY;
  }
  return trimmedSummary;
}

/**
 * A workflow keeps running after the turn that started it completes, so a
 * child thread can report an outcome while its workflow work is still in
 * flight. Say so, otherwise the parent reads the excerpt as the final result.
 */
function formatChildThreadRunningWorkflowClause(count: number): string {
  if (count < 1) {
    return "";
  }
  return count === 1
    ? ", with 1 workflow still running"
    : `, with ${count} workflows still running`;
}

function buildSingleChildThreadTurnStatusSegments(
  args: FormatChildThreadTurnStatusLineArgs,
): ParentSystemInputSegment[] {
  const { line } = args;
  switch (line.item.turnStatus) {
    case "completed": {
      const workflowClause = formatChildThreadRunningWorkflowClause(
        line.item.activeWorkflowCount,
      );
      const workflowGuidance =
        workflowClause === ""
          ? ""
          : `\n\n${CHILD_THREAD_RUNNING_WORKFLOW_GUIDANCE}`;
      return [
        { kind: "mention", mention: line.mention },
        {
          kind: "text",
          text: ` completed${workflowClause}:\n\n${formatChildThreadCompletionOutputExcerpt(line.item.terminalOutput)}${workflowGuidance}`,
        },
      ];
    }
    case "failed":
      return [
        { kind: "mention", mention: line.mention },
        {
          kind: "text",
          text: ` failed.\n\n${CHILD_THREAD_INSPECTION_GUIDANCE}`,
        },
      ];
    case "interrupted":
      return [
        { kind: "mention", mention: line.mention },
        {
          kind: "text",
          text: ` was interrupted.\n\n${CHILD_THREAD_INSPECTION_GUIDANCE}\n\n${CHILD_THREAD_INTERRUPTED_GUIDANCE}`,
        },
      ];
    default: {
      const exhaustiveCheck: never = line.item.turnStatus;
      return exhaustiveCheck;
    }
  }
}

function buildChildThreadBatchStatusLineSegments(
  args: FormatChildThreadTurnStatusLineArgs,
): ParentSystemInputSegment[] {
  const { line } = args;
  const workflowClause = formatChildThreadRunningWorkflowClause(
    line.item.activeWorkflowCount,
  );
  return [
    { kind: "mention", mention: line.mention },
    {
      kind: "text",
      text: ` ${childThreadTurnStatusLabel(line.item.turnStatus)}${workflowClause}.`,
    },
  ];
}

function getChildThreadCompletionOutput(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): string | null {
  if (args.turnStatus !== "completed") {
    return null;
  }
  return getLastThreadOutput(deps.db, args.childThread.id);
}

/**
 * Read at queue time rather than at batch flush, so the count reflects the
 * moment the turn settled — the same instant the output excerpt is captured.
 */
function getChildThreadActiveWorkflowCount(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): number {
  const [activity] = listActiveBackgroundTaskCountsByThreadIds(deps.db, {
    threadIds: [args.childThread.id],
  });
  return activity?.activeWorkflowCount ?? 0;
}

function buildChildThreadTurnStatusBatchSegments(
  args: RenderChildThreadTurnStatusBatchTextArgs,
): ParentSystemInputSegment[] {
  if (args.lines.length === 1 && args.lines[0]) {
    return buildSingleChildThreadTurnStatusSegments({
      line: args.lines[0],
    });
  }

  const segments: ParentSystemInputSegment[] = [];
  segments.push({ kind: "text", text: "Child thread updates:" });
  args.lines.forEach((line, index) => {
    segments.push({ kind: "text", text: index === 0 ? "\n\n- " : "\n- " });
    segments.push(...buildChildThreadBatchStatusLineSegments({ line }));
  });
  if (args.lines.some((line) => line.item.turnStatus === "interrupted")) {
    segments.push({
      kind: "text",
      text: `\n\n${CHILD_THREAD_BATCH_INTERRUPTED_GUIDANCE}`,
    });
  }
  if (args.lines.some((line) => line.item.activeWorkflowCount > 0)) {
    segments.push({
      kind: "text",
      text: `\n\n${CHILD_THREAD_BATCH_RUNNING_WORKFLOW_GUIDANCE}`,
    });
  }
  return segments;
}

function parentSystemSegmentText(segment: ParentSystemInputSegment): string {
  switch (segment.kind) {
    case "text":
      return segment.text;
    case "mention":
      return segment.mention.serializedText;
    default: {
      const exhaustiveCheck: never = segment;
      return exhaustiveCheck;
    }
  }
}

function parentSystemSegmentsText(
  segments: readonly ParentSystemInputSegment[],
): string {
  return segments.map(parentSystemSegmentText).join("");
}

function buildChildThreadTurnStatusBatchLines(
  args: RenderChildThreadTurnStatusBatchMessageArgs,
): ChildThreadTurnStatusBatchLine[] {
  return args.items.map((item) => ({
    item,
    mention: buildParentSystemThreadMention({
      thread: item.childThread,
    }),
  }));
}

function renderChildThreadTurnStatusBatchText(
  args: RenderChildThreadTurnStatusBatchTextArgs,
): string {
  const updates = parentSystemSegmentsText(
    buildChildThreadTurnStatusBatchSegments(args),
  );
  return renderTemplate("systemMessageChildThreadOutcomeBatch", {
    updates,
  });
}

export function renderChildThreadTurnStatusBatchMessage(
  args: RenderChildThreadTurnStatusBatchMessageArgs,
): string {
  return renderChildThreadTurnStatusBatchText({
    lines: buildChildThreadTurnStatusBatchLines(args),
  });
}

function childThreadSubject(
  thread: ChildThreadNotificationSource,
): SystemMessageSubject {
  return {
    kind: "thread",
    threadId: thread.id,
    threadName: parentSystemThreadLabel(thread),
  };
}

// One child stamps its outcome kind (derived from turnStatus) and names that
// child; a multi-child batch stamps `child-outcome-batch` and carries only the
// count, since no single thread is the subject.
function childThreadTurnStatusBatchTaxonomy(
  items: ChildThreadTurnNotificationBatchItem[],
): ParentSystemMessageTaxonomy {
  const single = items.length === 1 ? items[0] : undefined;
  if (single) {
    return {
      systemMessageKind: childOutcomeSystemMessageKind(single.turnStatus),
      systemMessageSubject: childThreadSubject(single.childThread),
    };
  }
  return {
    systemMessageKind: "child-outcome-batch",
    systemMessageSubject: { kind: "thread-batch", count: items.length },
  };
}

export function buildChildThreadTurnStatusBatchInput(
  args: BuildChildThreadTurnStatusBatchInputArgs,
): PromptInput[] {
  const lines = buildChildThreadTurnStatusBatchLines(args);
  const renderedText = renderTemplate("systemMessageChildThreadOutcomeBatch", {
    updates: CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT,
  });
  return buildParentSystemInputFromTemplateSlot({
    renderedText,
    slot: CHILD_THREAD_OUTCOME_BATCH_UPDATES_SLOT,
    segments: buildChildThreadTurnStatusBatchSegments({ lines }),
  });
}

export function buildChildThreadNeedsAttentionInput(
  args: BuildChildThreadNeedsAttentionInputArgs,
): PromptInput[] {
  const mention = buildParentSystemThreadMention({
    thread: args.childThread,
  });
  const renderedText = renderTemplate(
    "systemMessageChildThreadNeedsAttention",
    {
      blockerSummary: formatChildThreadNeedsAttentionSummary(
        args.blockerSummary,
      ),
      threadMention: CHILD_THREAD_MENTION_SLOT,
    },
  );
  return buildParentSystemInputFromTemplateSlot({
    renderedText,
    slot: CHILD_THREAD_MENTION_SLOT,
    segments: [{ kind: "mention", mention }],
  });
}

function childThreadTurnNotificationLogMessage(
  turnStatus: ThreadEventTurnStatus,
): string {
  switch (turnStatus) {
    case "completed":
      return "Failed to queue parent completed-thread notification";
    case "failed":
      return "Failed to queue parent failed-thread notification";
    case "interrupted":
      return "Failed to queue parent interrupted-thread notification";
    default: {
      const exhaustiveCheck: never = turnStatus;
      return exhaustiveCheck;
    }
  }
}

function workerInboxTitle(
  childThread: ChildThreadNotificationSource,
  turnStatus: ThreadEventTurnStatus,
): string {
  const name = parentSystemThreadLabel(childThread);
  switch (turnStatus) {
    case "completed":
      return `${name} finished`;
    case "failed":
      return `${name} failed`;
    case "interrupted":
      return `${name} was interrupted`;
    default: {
      const exhaustiveCheck: never = turnStatus;
      return exhaustiveCheck;
    }
  }
}

function emitParentInboxNotification(args: {
  category: NotificationCategory;
  childThread: ChildThreadNotificationSource;
  deps: LoggedPendingInteractionWorkSessionDeps;
  parentThreadId: string;
  title: string;
  body: string;
  payload: Record<string, string>;
}): void {
  try {
    createNotification(args.deps.db, args.deps.hub, {
      sourceKind: "system",
      threadId: args.parentThreadId,
      category: args.category,
      title: args.title,
      body: args.body,
      payload: {
        childThreadId: args.childThread.id,
        ...args.payload,
      },
      attention: true,
    });
  } catch (error) {
    args.deps.logger.error(
      {
        err: error,
        childThreadId: args.childThread.id,
        parentThreadId: args.parentThreadId,
      },
      "Failed to create parent inbox notification for child thread",
    );
  }
}

function pendingParentNotificationItem(
  row: PendingParentNotificationRow,
): ChildThreadTurnNotificationBatchItem {
  return {
    activeWorkflowCount: row.activeWorkflowCount,
    childThread: {
      id: row.childThreadId,
      projectId: row.childProjectId,
      title: row.childTitle,
    },
    terminalOutput: row.terminalOutput,
    turnStatus: row.turnStatus,
  };
}

function childThreadNotificationRetryDelayMs(attempts: number): number {
  const exponential =
    CHILD_THREAD_TURN_NOTIFICATION_BATCH_DELAY_MS * 2 ** attempts;
  return Math.min(exponential, CHILD_THREAD_NOTIFICATION_MAX_RETRY_DELAY_MS);
}

/**
 * Announce to the human once per child outcome, on the first delivery attempt,
 * independent of whether the parent agent could accept its system message yet
 * (charter D3: the inbox is the human channel, the system message is the agent
 * channel). `inboxEmittedAt` makes a retried delivery idempotent here.
 */
function emitPendingParentInboxNotifications(
  deps: LoggedPendingInteractionWorkSessionDeps,
  parentThreadId: string,
  deliveries: PendingParentNotificationDelivery[],
  now: number,
): void {
  const emitted: string[] = [];
  for (const delivery of deliveries) {
    if (delivery.row.inboxEmittedAt !== null) {
      continue;
    }
    emitParentInboxNotification({
      category: "worker-finished",
      childThread: delivery.item.childThread,
      deps,
      parentThreadId,
      title: workerInboxTitle(
        delivery.item.childThread,
        delivery.item.turnStatus,
      ),
      body:
        delivery.item.turnStatus === "completed"
          ? "Open the worker thread to read its result."
          : CHILD_THREAD_INSPECTION_GUIDANCE,
      payload: { turnStatus: delivery.item.turnStatus },
    });
    emitted.push(delivery.row.id);
  }
  if (emitted.length > 0) {
    markParentNotificationsInboxEmitted(deps.db, { ids: emitted, now });
  }
}

/**
 * Attempt delivery of everything currently owed to one parent. Called from the
 * post-settle fast path, from the periodic sweep, and when a parent's blocking
 * interaction resolves. Claiming makes concurrent callers safe.
 */
export async function deliverPendingParentNotifications(
  deps: LoggedPendingInteractionWorkSessionDeps,
  parentThreadId: string,
  // The sweep's clock, so "due" is evaluated against the same instant used to
  // select the work. Defaults to now for the post-settle fast path.
  now: number = Date.now(),
): Promise<void> {
  const rows = claimDueParentNotifications(deps.db, {
    parentThreadId,
    now,
    staleClaimBefore: now - CHILD_THREAD_NOTIFICATION_STALE_CLAIM_MS,
  });
  if (rows.length === 0) {
    return;
  }
  const deliveries = rows.map((row) => ({
    item: pendingParentNotificationItem(row),
    row,
  }));
  const ids = rows.map((row) => row.id);

  emitPendingParentInboxNotifications(deps, parentThreadId, deliveries, now);

  let outcome: ParentSystemMessageDeliveryOutcome;
  try {
    outcome = await queueParentSystemMessage(deps, {
      input: buildChildThreadTurnStatusBatchInput({
        items: deliveries.map((delivery) => delivery.item),
      }),
      parentThreadId,
      ...childThreadTurnStatusBatchTaxonomy(
        deliveries.map((delivery) => delivery.item),
      ),
    });
  } catch (error) {
    // Preparing or dispatching the turn threw (host unreachable, thread moved
    // to a state that rejects a new request). Retry rather than lose the
    // announcement.
    const attempts = Math.max(...rows.map((row) => row.attempts));
    deferPendingParentNotifications(deps.db, {
      ids,
      deliverAfter: now + childThreadNotificationRetryDelayMs(attempts),
      lastError: error instanceof Error ? error.message : String(error),
      countsAsAttempt: true,
      now,
    });
    deps.logger.error(
      {
        err: error,
        parentThreadId,
        childThreads: deliveries.map((delivery) => ({
          childThreadId: delivery.item.childThread.id,
          turnStatus: delivery.item.turnStatus,
        })),
      },
      "Deferred batched parent turn notifications after delivery error",
    );
    return;
  }

  if (outcome.status === "deferred") {
    // Waiting on the user is not a failed attempt: keep a short fixed retry so
    // the orchestrator resumes on the next sweep after the prompt is answered.
    const waitingOnUser = outcome.reason === "pending-interaction";
    const attempts = Math.max(...rows.map((row) => row.attempts));
    deferPendingParentNotifications(deps.db, {
      ids,
      deliverAfter:
        now +
        (waitingOnUser
          ? CHILD_THREAD_NOTIFICATION_BLOCKED_RECHECK_MS
          : childThreadNotificationRetryDelayMs(attempts)),
      lastError: outcome.reason,
      countsAsAttempt: !waitingOnUser,
      now,
    });
    deps.logger.debug(
      { parentThreadId, reason: outcome.reason, count: ids.length },
      "Deferred parent turn notifications; parent cannot accept a turn yet",
    );
    return;
  }

  if (outcome.status === "undeliverable") {
    deps.logger.info(
      { parentThreadId, reason: outcome.reason, count: ids.length },
      "Discarded parent turn notifications; parent thread is gone",
    );
  }
  deletePendingParentNotifications(deps.db, ids);
}

function scheduleChildThreadNotificationFlush(
  deps: LoggedPendingInteractionWorkSessionDeps,
  parentThreadId: string,
): void {
  const existing = childThreadNotificationFlushTimers.get(parentThreadId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    childThreadNotificationFlushTimers.delete(parentThreadId);
    void deliverPendingParentNotifications(deps, parentThreadId).catch(
      (error: unknown) => {
        deps.logger.error(
          { err: error, parentThreadId },
          "Parent notification fast-path flush failed",
        );
      },
    );
  }, CHILD_THREAD_TURN_NOTIFICATION_BATCH_DELAY_MS);
  timer.unref?.();
  childThreadNotificationFlushTimers.set(parentThreadId, timer);
}

/**
 * Records a parent-facing notification for a child thread turn outcome.
 * Normal turn-completion event side effects pass the actual terminal status;
 * command-result failures pass `failed` because no terminal turn event exists.
 *
 * The row is written synchronously; delivery is asynchronous and retried. Only
 * writing the row is best-effort here, and a write failure is loud.
 */
export async function queueChildThreadTurnNotificationBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadTurnNotificationArgs,
): Promise<void> {
  try {
    const now = Date.now();
    insertPendingParentNotification(deps.db, {
      id: createPendingParentNotificationId(),
      parentThreadId: args.parentThreadId,
      childThreadId: args.childThread.id,
      childProjectId: args.childThread.projectId,
      childTitle: args.childThread.title,
      turnStatus: args.turnStatus,
      activeWorkflowCount: getChildThreadActiveWorkflowCount(deps, args),
      terminalOutput: getChildThreadCompletionOutput(deps, args),
      deliverAfter: now + CHILD_THREAD_TURN_NOTIFICATION_BATCH_DELAY_MS,
      now,
    });
    scheduleChildThreadNotificationFlush(deps, args.parentThreadId);
  } catch (error) {
    deps.logger.error(
      {
        childThreadId: args.childThread.id,
        parentThreadId: args.parentThreadId,
        turnStatus: args.turnStatus,
        err: error,
      },
      childThreadTurnNotificationLogMessage(args.turnStatus),
    );
  }
}

/**
 * Sweep entry point: deliver every parent notification that is due. This is
 * the guarantee behind the fast path — a lost timer, a restart, or a parent
 * that was blocked at settle time all still converge here.
 */
export async function deliverDueParentNotifications(
  deps: LoggedPendingInteractionWorkSessionDeps,
  now: number,
): Promise<void> {
  const parentThreadIds = listParentThreadIdsWithDueNotifications(deps.db, {
    now,
    limit: CHILD_THREAD_NOTIFICATION_SWEEP_PARENT_LIMIT,
    staleClaimBefore: now - CHILD_THREAD_NOTIFICATION_STALE_CLAIM_MS,
  });
  for (const parentThreadId of parentThreadIds) {
    try {
      await deliverPendingParentNotifications(deps, parentThreadId, now);
    } catch (error) {
      deps.logger.error(
        { err: error, parentThreadId },
        "Parent notification delivery sweep failed for parent thread",
      );
    }
  }
}

export async function queueChildThreadNeedsAttentionNotificationBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueChildThreadNeedsAttentionNotificationArgs,
): Promise<void> {
  try {
    await queueParentSystemMessage(deps, {
      input: buildChildThreadNeedsAttentionInput({
        blockerSummary: args.blockerSummary,
        childThread: args.childThread,
      }),
      parentThreadId: args.parentThreadId,
      systemMessageKind: systemMessageKindForTemplate(
        "systemMessageChildThreadNeedsAttention",
      ),
      systemMessageSubject: childThreadSubject(args.childThread),
    });
  } catch (error) {
    deps.logger.error(
      {
        childThreadId: args.childThread.id,
        parentThreadId: args.parentThreadId,
        err: error,
      },
      "Failed to queue parent needs-attention notification",
    );
  }

  emitParentInboxNotification({
    category: "approval-needed",
    childThread: args.childThread,
    deps,
    parentThreadId: args.parentThreadId,
    title: `${parentSystemThreadLabel(args.childThread)} needs attention`,
    body:
      args.blockerSummary?.trim() ||
      CHILD_THREAD_NEEDS_ATTENTION_FALLBACK_SUMMARY,
    payload: { kind: "needs-attention" },
  });
}
