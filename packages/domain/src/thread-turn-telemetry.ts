import { z } from "zod";
import { reasoningLevelSchema, serviceTierSchema } from "./shared-types.js";
import {
  threadEventItemStatusSchema,
  threadEventTurnStatusSchema,
} from "./provider-event.js";

export const threadTurnSpanKindValues = [
  "tool",
  "command",
  "file-change",
  "delegation",
  "web-search",
  "web-fetch",
  "image-view",
  "reasoning",
  "message",
  "compaction",
  "background-task",
] as const;

export const threadTurnSpanKindSchema = z.enum(threadTurnSpanKindValues);
export type ThreadTurnSpanKind = z.infer<typeof threadTurnSpanKindSchema>;

export const threadTurnSpanStatusSchema = threadEventItemStatusSchema.nullable();
export type ThreadTurnSpanStatus = z.infer<typeof threadTurnSpanStatusSchema>;

export const threadTurnSpanSchema = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1).nullable(),
  parentItemId: z.string().min(1).nullable(),
  kind: threadTurnSpanKindSchema,
  name: z.string().min(1),
  status: threadTurnSpanStatusSchema,
  startedAt: z.number(),
  completedAt: z.number().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  durationSource: z.enum(["provider", "event-clock"]).nullable(),
  detail: z.string().nullable(),
  error: z.string().nullable(),
  children: z.lazy(() => z.array(threadTurnSpanSchema)),
});
export type ThreadTurnSpan = z.infer<typeof threadTurnSpanSchema>;

export const threadTurnUsageSchema = z.object({
  totalTokens: z.number().int().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable(),
  modelContextWindow: z.number().int().positive().nullable(),
  source: z.enum(["provider-turn-delta", "provider-last", "none"]),
  // Kept present so a future price table can populate it without a contract
  // migration. No provider-specific pricing policy belongs in telemetry v1.
  costUsd: z.null(),
});
export type ThreadTurnUsage = z.infer<typeof threadTurnUsageSchema>;

export const threadTurnCountsSchema = z.object({
  toolCalls: z.number().int().nonnegative(),
  commands: z.number().int().nonnegative(),
  fileChanges: z.number().int().nonnegative(),
  delegations: z.number().int().nonnegative(),
  subagentSpans: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  interrupted: z.boolean(),
});
export type ThreadTurnCounts = z.infer<typeof threadTurnCountsSchema>;

/**
 * Durable telemetry for exactly one provider turn. It is materialized at
 * turn completion before prunable usage events are discarded.
 */
export const threadTurnRecordSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1).nullable(),
  modelSource: z.enum(["turn-request", "thread-default"]).nullable(),
  reasoningLevel: reasoningLevelSchema.nullable(),
  serviceTier: serviceTierSchema.nullable(),
  parentToolCallId: z.string().min(1).nullable(),
  isRoot: z.boolean(),
  // This intentionally remains broader than the current client-turn enum:
  // provider and plugin-originated completions can be synthesized without a
  // client/turn/requested row, and telemetry must retain that provenance.
  initiator: z.string().min(1).nullable(),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  status: threadEventTurnStatusSchema,
  errorMessage: z.string().min(1).nullable(),
  counts: threadTurnCountsSchema,
  usage: threadTurnUsageSchema,
  sourceSeqStart: z.number().int().nonnegative().nullable(),
  sourceSeqEnd: z.number().int().nonnegative().nullable(),
  spans: z.array(threadTurnSpanSchema),
  spansTruncated: z.boolean(),
});
export type ThreadTurnRecord = z.infer<typeof threadTurnRecordSchema>;
