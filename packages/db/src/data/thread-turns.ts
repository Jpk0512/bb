import { and, desc, eq, lt } from "drizzle-orm";
import type { ThreadTurnRecord, ThreadTurnUsage } from "@bb/domain";
import { threadTurnRecordSchema, threadTurnSpanSchema } from "@bb/domain";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import { threadTurns } from "../schema.js";

type ThreadTurnWriteConnection = DbConnection | DbTransaction;
type ThreadTurnRow = typeof threadTurns.$inferSelect;

export interface ThreadTurnKey {
  threadId: string;
  turnId: string;
}

export interface ListThreadTurnRecordsArgs {
  beforeCompletedAt?: number;
  limit?: number;
  threadId: string;
}

export interface GetPreviousRootTurnUsageArgs {
  beforeStartedAt: number;
  threadId: string;
}

function recordFromThreadTurnRow(row: ThreadTurnRow): ThreadTurnRecord {
  const spans =
    row.spansJson === null
      ? []
      : threadTurnSpanSchema.array().parse(JSON.parse(row.spansJson));

  return threadTurnRecordSchema.parse({
    threadId: row.threadId,
    turnId: row.turnId,
    projectId: row.projectId,
    providerId: row.providerId,
    model: row.model,
    modelSource: row.modelSource,
    reasoningLevel: row.reasoningLevel,
    serviceTier: row.serviceTier,
    parentToolCallId: row.parentToolCallId,
    isRoot: row.isRoot,
    initiator: row.initiator,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
    status: row.status,
    errorMessage: row.errorMessage,
    counts: {
      toolCalls: row.countToolCalls,
      commands: row.countCommands,
      fileChanges: row.countFileChanges,
      delegations: row.countDelegations,
      subagentSpans: row.countSubagentSpans,
      errors: row.countErrors,
      interrupted: row.countInterrupted,
    },
    usage: {
      totalTokens: row.usageTotalTokens,
      inputTokens: row.usageInputTokens,
      cachedInputTokens: row.usageCachedInputTokens,
      outputTokens: row.usageOutputTokens,
      reasoningOutputTokens: row.usageReasoningOutputTokens,
      modelContextWindow: row.usageModelContextWindow,
      source: row.usageSource,
      costUsd: row.usageCostUsd,
    },
    sourceSeqStart: row.sourceSeqStart,
    sourceSeqEnd: row.sourceSeqEnd,
    spans,
    spansTruncated: row.spansTruncated,
  });
}

/**
 * Inserts or refreshes the materialized record for one completed turn.
 *
 * The `(thread_id, turn_id)` conflict target makes a redelivered completion
 * safe: telemetry remains one logical record while preserving the latest
 * builder result if an operator retries a failed write.
 */
export function upsertThreadTurnRecord(
  db: ThreadTurnWriteConnection,
  record: ThreadTurnRecord,
): ThreadTurnRecord {
  const now = Date.now();
  const spansJson = record.spans.length === 0 ? null : JSON.stringify(record.spans);
  const persisted = db
    .insert(threadTurns)
    .values({
      threadId: record.threadId,
      turnId: record.turnId,
      projectId: record.projectId,
      providerId: record.providerId,
      model: record.model,
      modelSource: record.modelSource,
      reasoningLevel: record.reasoningLevel,
      serviceTier: record.serviceTier,
      parentToolCallId: record.parentToolCallId,
      isRoot: record.isRoot,
      initiator: record.initiator,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      durationMs: record.durationMs,
      status: record.status,
      errorMessage: record.errorMessage,
      countToolCalls: record.counts.toolCalls,
      countCommands: record.counts.commands,
      countFileChanges: record.counts.fileChanges,
      countDelegations: record.counts.delegations,
      countSubagentSpans: record.counts.subagentSpans,
      countErrors: record.counts.errors,
      countInterrupted: record.counts.interrupted,
      usageTotalTokens: record.usage.totalTokens,
      usageInputTokens: record.usage.inputTokens,
      usageCachedInputTokens: record.usage.cachedInputTokens,
      usageOutputTokens: record.usage.outputTokens,
      usageReasoningOutputTokens: record.usage.reasoningOutputTokens,
      usageModelContextWindow: record.usage.modelContextWindow,
      usageSource: record.usage.source,
      usageCostUsd: record.usage.costUsd,
      sourceSeqStart: record.sourceSeqStart,
      sourceSeqEnd: record.sourceSeqEnd,
      spansJson,
      spansTruncated: record.spansTruncated,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [threadTurns.threadId, threadTurns.turnId],
      set: {
        projectId: record.projectId,
        providerId: record.providerId,
        model: record.model,
        modelSource: record.modelSource,
        reasoningLevel: record.reasoningLevel,
        serviceTier: record.serviceTier,
        parentToolCallId: record.parentToolCallId,
        isRoot: record.isRoot,
        initiator: record.initiator,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        durationMs: record.durationMs,
        status: record.status,
        errorMessage: record.errorMessage,
        countToolCalls: record.counts.toolCalls,
        countCommands: record.counts.commands,
        countFileChanges: record.counts.fileChanges,
        countDelegations: record.counts.delegations,
        countSubagentSpans: record.counts.subagentSpans,
        countErrors: record.counts.errors,
        countInterrupted: record.counts.interrupted,
        usageTotalTokens: record.usage.totalTokens,
        usageInputTokens: record.usage.inputTokens,
        usageCachedInputTokens: record.usage.cachedInputTokens,
        usageOutputTokens: record.usage.outputTokens,
        usageReasoningOutputTokens: record.usage.reasoningOutputTokens,
        usageModelContextWindow: record.usage.modelContextWindow,
        usageSource: record.usage.source,
        usageCostUsd: record.usage.costUsd,
        sourceSeqStart: record.sourceSeqStart,
        sourceSeqEnd: record.sourceSeqEnd,
        spansJson,
        spansTruncated: record.spansTruncated,
        updatedAt: now,
      },
    })
    .returning()
    .get();

  return recordFromThreadTurnRow(persisted);
}

export function getThreadTurnRecord(
  db: DbQueryConnection,
  args: ThreadTurnKey,
): ThreadTurnRecord | null {
  const row = db
    .select()
    .from(threadTurns)
    .where(
      and(
        eq(threadTurns.threadId, args.threadId),
        eq(threadTurns.turnId, args.turnId),
      ),
    )
    .get();
  return row ? recordFromThreadTurnRow(row) : null;
}

export function listThreadTurnRecords(
  db: DbQueryConnection,
  args: ListThreadTurnRecordsArgs,
): ThreadTurnRecord[] {
  return db
    .select()
    .from(threadTurns)
    .where(
      and(
        eq(threadTurns.threadId, args.threadId),
        args.beforeCompletedAt === undefined
          ? undefined
          : lt(threadTurns.completedAt, args.beforeCompletedAt),
      ),
    )
    .orderBy(desc(threadTurns.completedAt), desc(threadTurns.turnId))
    .limit(args.limit ?? Number.MAX_SAFE_INTEGER)
    .all()
    .map(recordFromThreadTurnRow);
}

/**
 * Finds the prior root turn's materialized usage so the current turn can store
 * a delta without relying on usage events that history pruning may remove.
 */
export function getPreviousRootTurnUsage(
  db: DbQueryConnection,
  args: GetPreviousRootTurnUsageArgs,
): ThreadTurnUsage | null {
  const row = db
    .select()
    .from(threadTurns)
    .where(
      and(
        eq(threadTurns.threadId, args.threadId),
        eq(threadTurns.isRoot, true),
        lt(threadTurns.startedAt, args.beforeStartedAt),
      ),
    )
    .orderBy(desc(threadTurns.startedAt), desc(threadTurns.turnId))
    .limit(1)
    .get();
  return row ? recordFromThreadTurnRow(row).usage : null;
}
