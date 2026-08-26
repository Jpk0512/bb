import {
  getPreviousRootTurnUsage,
  getStoredTurnRequestEventForTurn,
  getThread,
  listStoredEventRowsForTurn,
} from "@bb/db";
import type { DbConnection, StoredEventRow } from "@bb/db";
import {
  parseStoredThreadEvent,
  threadScope,
  turnRequestEventDataSchema,
  turnScope,
  type ThreadEvent,
  type ThreadEventItem,
  type ThreadTurnRecord,
  type ThreadTurnSpan,
  type ThreadTurnSpanKind,
  type ThreadTurnSpanStatus,
  type ThreadTurnUsage,
} from "@bb/domain";
import { isDelegationToolName } from "@bb/thread-view";

const MAX_TURN_SPANS = 250;

interface BuildThreadTurnRecordArgs {
  threadId: string;
  turnId: string;
}

interface ItemLifecycle {
  completed: Extract<ThreadEvent, { type: "item/completed" }> | null;
  completedAt: number | null;
  started: Extract<ThreadEvent, { type: "item/started" }>;
  startedAt: number;
}

function decodeStoredTurnEvent(row: StoredEventRow): ThreadEvent {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  return parseStoredThreadEvent({
    data,
    providerThreadId: row.providerThreadId,
    scope:
      row.scopeKind === "turn" && row.turnId !== null
        ? turnScope(row.turnId)
        : threadScope(),
    threadId: row.threadId,
    type: row.type,
  });
}

function spanKindForItem(item: ThreadEventItem): ThreadTurnSpanKind {
  switch (item.type) {
    case "toolCall":
      return isDelegationToolName(item.tool) ? "delegation" : "tool";
    case "commandExecution":
      return "command";
    case "fileChange":
      return "file-change";
    case "webSearch":
      return "web-search";
    case "webFetch":
      return "web-fetch";
    case "imageView":
      return "image-view";
    case "reasoning":
      return "reasoning";
    case "agentMessage":
    case "userMessage":
    case "plan":
      return "message";
    case "contextCompaction":
      return "compaction";
    case "backgroundTask":
      return "background-task";
  }
}

function spanNameForItem(item: ThreadEventItem): string {
  switch (item.type) {
    case "toolCall":
      return item.tool;
    case "commandExecution":
      return item.command;
    case "fileChange":
      return "File change";
    case "webSearch":
      return item.queries.join(", ");
    case "webFetch":
      return item.url;
    case "imageView":
      return item.path;
    case "reasoning":
      return "Reasoning";
    case "agentMessage":
      return "Assistant message";
    case "userMessage":
      return "User message";
    case "plan":
      return "Plan";
    case "contextCompaction":
      return "Context compaction";
    case "backgroundTask":
      return item.description;
  }
}

function spanDetailForItem(item: ThreadEventItem): string | null {
  switch (item.type) {
    case "agentMessage":
      return item.text;
    case "commandExecution":
      return item.aggregatedOutput ?? null;
    case "fileChange":
      return item.changes.map((change) => change.path).join("\n") || null;
    case "reasoning":
      return [...item.summary, ...item.content].join("\n") || null;
    case "plan":
      return item.text;
    case "toolCall":
      return item.error ?? null;
    case "backgroundTask":
      return item.summary ?? item.error ?? null;
    default:
      return null;
  }
}

function providerDurationMs(item: ThreadEventItem): number | null {
  if (
    (item.type === "commandExecution" || item.type === "toolCall") &&
    item.durationMs !== undefined
  ) {
    return item.durationMs;
  }
  return null;
}

function errorForItem(item: ThreadEventItem): string | null {
  if (item.type === "toolCall") return item.error ?? null;
  if (item.type === "backgroundTask") return item.error ?? null;
  return null;
}

function statusForItem(item: ThreadEventItem): ThreadTurnSpanStatus {
  switch (item.type) {
    case "toolCall":
    case "commandExecution":
    case "fileChange":
    case "backgroundTask":
      return item.status;
    default:
      return null;
  }
}

function parentItemId(item: ThreadEventItem): string | null {
  return item.parentToolCallId ?? null;
}

function buildSpans(rows: readonly StoredEventRow[]): {
  spans: ThreadTurnSpan[];
  spansTruncated: boolean;
} {
  const lifecycles = new Map<string, ItemLifecycle>();
  for (const row of rows) {
    const event = decodeStoredTurnEvent(row);
    if (event.type === "item/started") {
      lifecycles.set(event.item.id, {
        completed: null,
        completedAt: null,
        started: event,
        startedAt: row.createdAt,
      });
    } else if (event.type === "item/completed") {
      const lifecycle = lifecycles.get(event.item.id);
      if (lifecycle) {
        lifecycle.completed = event;
        lifecycle.completedAt = row.createdAt;
      }
    }
  }

  const retained = [...lifecycles.values()].slice(0, MAX_TURN_SPANS);
  const spansTruncated = lifecycles.size > retained.length;
  const byItemId = new Map<string, ThreadTurnSpan>();
  for (const lifecycle of retained) {
    const completedItem = lifecycle.completed?.item;
    const item = completedItem ?? lifecycle.started.item;
    const providerMs = completedItem ? providerDurationMs(completedItem) : null;
    const eventClockMs =
      lifecycle.completedAt === null
        ? null
        : Math.max(0, lifecycle.completedAt - lifecycle.startedAt);
    const durationMs = providerMs ?? eventClockMs;
    byItemId.set(item.id, {
      id: item.id,
      itemId: item.id,
      parentItemId: parentItemId(item),
      kind: spanKindForItem(item),
      name: spanNameForItem(item),
      status: completedItem ? statusForItem(completedItem) : null,
      startedAt: lifecycle.startedAt,
      completedAt: lifecycle.completedAt,
      durationMs,
      durationSource:
        durationMs === null ? null : providerMs === null ? "event-clock" : "provider",
      detail: spanDetailForItem(item),
      error: errorForItem(item),
      children: [],
    });
  }

  const roots: ThreadTurnSpan[] = [];
  for (const span of byItemId.values()) {
    const parent = span.parentItemId
      ? byItemId.get(span.parentItemId)
      : undefined;
    if (parent) {
      parent.children.push(span);
    } else {
      roots.push(span);
    }
  }
  return { spans: roots, spansTruncated };
}

function usageFromNone(): ThreadTurnUsage {
  return {
    totalTokens: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    modelContextWindow: null,
    source: "none",
    costUsd: null,
  };
}

function usageFromBreakdown(args: {
  breakdown: {
    cachedInputTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  };
  modelContextWindow: number | null;
  source: ThreadTurnUsage["source"];
}): ThreadTurnUsage {
  return { ...args.breakdown, modelContextWindow: args.modelContextWindow, source: args.source, costUsd: null };
}

function usageForTurn(args: {
  db: DbConnection;
  isRoot: boolean;
  rows: readonly StoredEventRow[];
  startedAt: number;
  threadId: string;
}): ThreadTurnUsage {
  let latest: Extract<ThreadEvent, { type: "thread/tokenUsage/updated" }> | null = null;
  for (const row of args.rows) {
    const event = decodeStoredTurnEvent(row);
    if (event.type === "thread/tokenUsage/updated") latest = event;
  }
  if (!latest) return usageFromNone();

  const previous = args.isRoot
    ? getPreviousRootTurnUsage(args.db, {
        beforeStartedAt: args.startedAt,
        threadId: args.threadId,
      })
    : null;
  if (
    previous !== null &&
    previous.source !== "none" &&
    previous.totalTokens !== null &&
    latest.tokenUsage.total.totalTokens >= previous.totalTokens
  ) {
    const total = latest.tokenUsage.total;
    const breakdown = {
      totalTokens: total.totalTokens - previous.totalTokens,
      inputTokens:
        previous.inputTokens === null ? total.inputTokens : total.inputTokens - previous.inputTokens,
      cachedInputTokens:
        previous.cachedInputTokens === null ? total.cachedInputTokens : total.cachedInputTokens - previous.cachedInputTokens,
      outputTokens:
        previous.outputTokens === null ? total.outputTokens : total.outputTokens - previous.outputTokens,
      reasoningOutputTokens:
        previous.reasoningOutputTokens === null
          ? total.reasoningOutputTokens
          : total.reasoningOutputTokens - previous.reasoningOutputTokens,
    };
    // A provider can re-bucket cumulative components between turns (pi moves
    // input into cachedInput), driving a per-component delta negative while the
    // total still grows. Such deltas are meaningless per component, and a
    // negative value violates the record contract downstream.
    const deltasValid = Object.values(breakdown).every(
      (value) => value === null || value >= 0,
    );
    if (deltasValid) {
      return usageFromBreakdown({
        breakdown,
        modelContextWindow: latest.tokenUsage.modelContextWindow,
        source: "provider-turn-delta",
      });
    }
  }
  return usageFromBreakdown({
    breakdown: latest.tokenUsage.last,
    modelContextWindow: latest.tokenUsage.modelContextWindow,
    source: "provider-last",
  });
}

function countSpans(spans: readonly ThreadTurnSpan[]): ThreadTurnRecord["counts"] {
  const all = spans.flatMap(function flatten(span): ThreadTurnSpan[] {
    return [span, ...span.children.flatMap(flatten)];
  });
  return {
    toolCalls: all.filter((span) => span.kind === "tool").length,
    commands: all.filter((span) => span.kind === "command").length,
    fileChanges: all.filter((span) => span.kind === "file-change").length,
    delegations: all.filter((span) => span.kind === "delegation").length,
    subagentSpans: all.filter((span) => span.kind === "delegation").length,
    errors: all.filter((span) => span.status === "failed" || span.error !== null).length,
    interrupted: all.some((span) => span.status === "interrupted"),
  };
}

/**
 * Materialize one completed provider turn strictly from its durable event rows.
 * This deliberately never consults the presentation timeline, whose windows
 * can split a steered turn and truncate output.
 */
export function buildThreadTurnRecord(
  db: DbConnection,
  args: BuildThreadTurnRecordArgs,
): ThreadTurnRecord {
  const thread = getThread(db, args.threadId);
  if (!thread) throw new Error(`Thread ${args.threadId} does not exist`);
  const rows = listStoredEventRowsForTurn(db, {
    maxInlineOutputChars: null,
    threadId: args.threadId,
    turnId: args.turnId,
  });
  const decoded = rows.map((row) => ({ event: decodeStoredTurnEvent(row), row }));
  const started = decoded.find((entry) => entry.event.type === "turn/started");
  const completed = decoded.find((entry) => entry.event.type === "turn/completed");
  if (!completed || completed.event.type !== "turn/completed") {
    throw new Error(`Turn ${args.turnId} has no durable completion event`);
  }
  const startedAt = started?.row.createdAt ?? completed.row.createdAt;
  const parentToolCallId =
    started?.event.type === "turn/started"
      ? started.event.parentToolCallId ?? null
      : null;
  const request = getStoredTurnRequestEventForTurn(db, args);
  const requestData = request
    ? turnRequestEventDataSchema.parse(JSON.parse(request.data))
    : null;
  const { spans, spansTruncated } = buildSpans(rows);
  const isRoot = parentToolCallId === null;
  const counts = countSpans(spans);
  if (completed.event.status === "failed") counts.errors += 1;
  if (completed.event.status === "interrupted") counts.interrupted = true;

  const model = requestData?.execution.model ?? thread.modelOverride ?? null;
  return {
    threadId: thread.id,
    turnId: args.turnId,
    projectId: thread.projectId,
    providerId: thread.providerId,
    model,
    modelSource: model === null ? null : requestData ? "turn-request" : "thread-default",
    reasoningLevel: requestData?.execution.reasoningLevel ?? thread.reasoningLevelOverride ?? null,
    serviceTier: requestData?.execution.serviceTier ?? null,
    parentToolCallId,
    isRoot,
    initiator: requestData?.initiator ?? null,
    startedAt,
    completedAt: completed.row.createdAt,
    durationMs: Math.max(0, completed.row.createdAt - startedAt),
    status: completed.event.status,
    errorMessage: completed.event.error?.message ?? null,
    counts,
    usage: usageForTurn({ db, isRoot, rows, startedAt, threadId: thread.id }),
    sourceSeqStart: rows[0]?.sequence ?? null,
    sourceSeqEnd: rows.at(-1)?.sequence ?? null,
    spans,
    spansTruncated,
  };
}
