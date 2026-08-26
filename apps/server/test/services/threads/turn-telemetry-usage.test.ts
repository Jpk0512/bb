import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { events, getThreadTurnRecord, upsertThreadTurnRecord } from "@bb/db";
import type { ThreadTurnRecord } from "@bb/domain";
import { turnScope } from "@bb/domain";
import { buildThreadTurnRecord } from "../../../src/services/threads/turn-telemetry.js";
import { appendThreadEvent } from "../../../src/services/threads/thread-events.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";
import type { TestAppHarness } from "../../helpers/test-app.js";

async function seedTelemetryThread(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
  });
  return { environment, project, thread };
}

function priorRootTurnRecord(args: {
  threadId: string;
  turnId: string;
}): ThreadTurnRecord {
  return {
    threadId: args.threadId,
    turnId: args.turnId,
    projectId: "project-telemetry-usage",
    providerId: "codex",
    model: "gpt-5",
    modelSource: "turn-request",
    reasoningLevel: "high",
    serviceTier: "default",
    parentToolCallId: null,
    isRoot: true,
    initiator: "user",
    startedAt: 1_000,
    completedAt: 1_500,
    durationMs: 500,
    status: "completed",
    errorMessage: null,
    counts: {
      toolCalls: 0,
      commands: 0,
      fileChanges: 0,
      delegations: 0,
      subagentSpans: 0,
      errors: 0,
      interrupted: false,
    },
    usage: {
      totalTokens: 1_000,
      inputTokens: 700,
      cachedInputTokens: 100,
      outputTokens: 300,
      reasoningOutputTokens: 50,
      modelContextWindow: 128_000,
      source: "provider-turn-delta",
      costUsd: null,
    },
    sourceSeqStart: 1,
    sourceSeqEnd: 3,
    spans: [],
    spansTruncated: false,
  };
}

describe("buildThreadTurnRecord usage resolution", () => {
  it("subtracts the prior root turn's usage to produce a provider-turn-delta", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedTelemetryThread(harness);
      const previous = upsertThreadTurnRecord(
        harness.db,
        priorRootTurnRecord({ threadId: thread.id, turnId: "root-turn-1" }),
      );
      expect(previous.usage.totalTokens).toBe(1_000);

      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/started",
        scope: turnScope("root-turn-2"),
        data: { providerThreadId: "provider-1" },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "thread/tokenUsage/updated",
        scope: turnScope("root-turn-2"),
        data: {
          providerThreadId: "provider-1",
          tokenUsage: {
            total: {
              totalTokens: 1_800,
              inputTokens: 1_200,
              cachedInputTokens: 150,
              outputTokens: 500,
              reasoningOutputTokens: 100,
            },
            last: {
              totalTokens: 800,
              inputTokens: 500,
              cachedInputTokens: 50,
              outputTokens: 200,
              reasoningOutputTokens: 50,
            },
            modelContextWindow: 128_000,
          },
        },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/completed",
        scope: turnScope("root-turn-2"),
        data: { providerThreadId: "provider-1", status: "completed" },
      });

      const record = buildThreadTurnRecord(harness.db, {
        threadId: thread.id,
        turnId: "root-turn-2",
      });
      expect(record.usage).toEqual({
        totalTokens: 800,
        inputTokens: 500,
        cachedInputTokens: 50,
        outputTokens: 200,
        reasoningOutputTokens: 50,
        modelContextWindow: 128_000,
        source: "provider-turn-delta",
        costUsd: null,
      });
    });
  });

  it("falls back to provider-last when a component delta goes negative", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedTelemetryThread(harness);
      upsertThreadTurnRecord(
        harness.db,
        priorRootTurnRecord({ threadId: thread.id, turnId: "root-turn-1" }),
      );

      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/started",
        scope: turnScope("root-turn-2"),
        data: { providerThreadId: "provider-1" },
      });
      // Cumulative input shrank below the prior turn's 700 (the provider
      // re-bucketed input into cachedInput) while the total still grew — the
      // per-component delta math would yield inputTokens: -200.
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "thread/tokenUsage/updated",
        scope: turnScope("root-turn-2"),
        data: {
          providerThreadId: "provider-1",
          tokenUsage: {
            total: {
              totalTokens: 2_000,
              inputTokens: 500,
              cachedInputTokens: 1_100,
              outputTokens: 400,
              reasoningOutputTokens: 100,
            },
            last: {
              totalTokens: 1_000,
              inputTokens: 400,
              cachedInputTokens: 400,
              outputTokens: 200,
              reasoningOutputTokens: 50,
            },
            modelContextWindow: 128_000,
          },
        },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/completed",
        scope: turnScope("root-turn-2"),
        data: { providerThreadId: "provider-1", status: "completed" },
      });

      const record = buildThreadTurnRecord(harness.db, {
        threadId: thread.id,
        turnId: "root-turn-2",
      });
      expect(record.usage).toEqual({
        totalTokens: 1_000,
        inputTokens: 400,
        cachedInputTokens: 400,
        outputTokens: 200,
        reasoningOutputTokens: 50,
        modelContextWindow: 128_000,
        source: "provider-last",
        costUsd: null,
      });
    });
  });

  it("refuses to persist an out-of-contract record instead of poisoning the row", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedTelemetryThread(harness);
      const record = priorRootTurnRecord({
        threadId: thread.id,
        turnId: "root-turn-poison",
      });
      record.usage = { ...record.usage, inputTokens: -2_934 };

      expect(() => upsertThreadTurnRecord(harness.db, record)).toThrow();
      expect(
        getThreadTurnRecord(harness.db, {
          threadId: thread.id,
          turnId: "root-turn-poison",
        }),
      ).toBeNull();
    });
  });

  it("falls back to provider-last usage for the first root turn in a thread", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedTelemetryThread(harness);

      // No previous root turn is seeded here at all: getPreviousRootTurnUsage
      // must return null and usageForTurn must not crash on it. This
      // regression-guards a prior bug where `previous?.source !== "none"`
      // threw/misbehaved on a null previous value instead of short-circuiting.
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/started",
        scope: turnScope("root-turn-first"),
        data: { providerThreadId: "provider-1" },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "thread/tokenUsage/updated",
        scope: turnScope("root-turn-first"),
        data: {
          providerThreadId: "provider-1",
          tokenUsage: {
            total: {
              totalTokens: 400,
              inputTokens: 300,
              cachedInputTokens: 0,
              outputTokens: 100,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 400,
              inputTokens: 300,
              cachedInputTokens: 0,
              outputTokens: 100,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 128_000,
          },
        },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/completed",
        scope: turnScope("root-turn-first"),
        data: { providerThreadId: "provider-1", status: "completed" },
      });

      const record = buildThreadTurnRecord(harness.db, {
        threadId: thread.id,
        turnId: "root-turn-first",
      });
      expect(record.usage.source).toBe("provider-last");
      expect(record.usage.totalTokens).toBe(400);
    });
  });

  it("reports source none with null token fields when the provider never reports usage", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedTelemetryThread(harness);

      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/started",
        scope: turnScope("turn-no-usage"),
        data: { providerThreadId: "provider-1" },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/completed",
        scope: turnScope("turn-no-usage"),
        data: { providerThreadId: "provider-1", status: "completed" },
      });

      const record = buildThreadTurnRecord(harness.db, {
        threadId: thread.id,
        turnId: "turn-no-usage",
      });
      expect(record.usage).toEqual({
        totalTokens: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
        modelContextWindow: null,
        source: "none",
        costUsd: null,
      });
    });
  });

  it("keeps materialized usage durable after the source events are pruned away", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedTelemetryThread(harness);
      const turnId = "turn-durable-usage";

      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/started",
        scope: turnScope(turnId),
        data: { providerThreadId: "provider-1" },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "thread/tokenUsage/updated",
        scope: turnScope(turnId),
        data: {
          providerThreadId: "provider-1",
          tokenUsage: {
            total: {
              totalTokens: 250,
              inputTokens: 200,
              cachedInputTokens: 0,
              outputTokens: 50,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 250,
              inputTokens: 200,
              cachedInputTokens: 0,
              outputTokens: 50,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 64_000,
          },
        },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/completed",
        scope: turnScope(turnId),
        data: { providerThreadId: "provider-1", status: "completed" },
      });

      const built = buildThreadTurnRecord(harness.db, { threadId: thread.id, turnId });
      const persisted = upsertThreadTurnRecord(harness.db, built);
      expect(persisted.usage.totalTokens).toBe(250);

      // Simulate idle-history pruning discarding the turn's underlying event
      // rows entirely. The materialized record must be unaffected because it
      // no longer depends on the event log being queryable.
      harness.db.delete(events).where(eq(events.threadId, thread.id)).run();

      const reread = getThreadTurnRecord(harness.db, { threadId: thread.id, turnId });
      expect(reread).toEqual(persisted);
      expect(reread?.usage).toEqual({
        totalTokens: 250,
        inputTokens: 200,
        cachedInputTokens: 0,
        outputTokens: 50,
        reasoningOutputTokens: 0,
        modelContextWindow: 64_000,
        source: "provider-last",
        costUsd: null,
      });
    });
  });
});
