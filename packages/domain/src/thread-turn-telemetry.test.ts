import { describe, expect, it } from "vitest";
import { threadTurnRecordSchema } from "./thread-turn-telemetry.js";

function recordFixture() {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    projectId: "project-1",
    providerId: "codex",
    model: "gpt-5",
    modelSource: "turn-request" as const,
    reasoningLevel: "high" as const,
    serviceTier: "default" as const,
    parentToolCallId: null,
    isRoot: true,
    initiator: "user" as const,
    startedAt: 1_000,
    completedAt: 1_400,
    durationMs: 400,
    status: "completed" as const,
    errorMessage: null,
    counts: {
      toolCalls: 1,
      commands: 0,
      fileChanges: 0,
      delegations: 0,
      subagentSpans: 0,
      errors: 0,
      interrupted: false,
    },
    usage: {
      totalTokens: 42,
      inputTokens: 21,
      cachedInputTokens: 0,
      outputTokens: 21,
      reasoningOutputTokens: 0,
      modelContextWindow: 128_000,
      source: "provider-turn-delta" as const,
      costUsd: null,
    },
    sourceSeqStart: 3,
    sourceSeqEnd: 8,
    spans: [
      {
        id: "span-tool-1",
        itemId: "tool-1",
        parentItemId: null,
        kind: "tool" as const,
        name: "Read",
        status: "completed" as const,
        startedAt: 1_100,
        completedAt: 1_200,
        durationMs: 100,
        durationSource: "provider" as const,
        detail: null,
        error: null,
        children: [
          {
            id: "span-message-1",
            itemId: "message-1",
            parentItemId: "tool-1",
            kind: "message" as const,
            name: "Result",
            status: "completed" as const,
            startedAt: 1_150,
            completedAt: 1_180,
            durationMs: 30,
            durationSource: "event-clock" as const,
            detail: "Read result",
            error: null,
            children: [],
          },
        ],
      },
    ],
    spansTruncated: false,
  };
}

describe("thread turn telemetry contract", () => {
  it("supports nested span trees while keeping cost explicitly unavailable", () => {
    const record = threadTurnRecordSchema.parse(recordFixture());

    expect(record.spans[0]?.children[0]?.kind).toBe("message");
    expect(record.usage.costUsd).toBeNull();
  });

  it("rejects price guesses and invalid materialized counts", () => {
    const pricedRecord = {
      ...recordFixture(),
      usage: { ...recordFixture().usage, costUsd: 0.12 },
    };
    expect(() => threadTurnRecordSchema.parse(pricedRecord)).toThrow();

    const negativeCountRecord = recordFixture();
    negativeCountRecord.counts.errors = -1;
    expect(() => threadTurnRecordSchema.parse(negativeCountRecord)).toThrow();
  });
});
