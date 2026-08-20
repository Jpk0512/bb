import { describe, expect, it } from "vitest";
import { setThreadExecutionOverride } from "@bb/db";
import { turnScope } from "@bb/domain";
import { buildThreadTurnRecord } from "../../../src/services/threads/turn-telemetry.js";
import {
  appendClientTurnEvent,
  appendThreadEvent,
} from "../../../src/services/threads/thread-events.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import { textInput } from "../../helpers/prompt-input.js";
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

describe("buildThreadTurnRecord", () => {
  it("attributes a nested delegation span to the root turn and marks the child turn non-root", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedTelemetryThread(harness);

      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/started",
        scope: turnScope("root-turn"),
        data: { providerThreadId: "provider-1" },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "item/started",
        scope: turnScope("root-turn"),
        data: {
          providerThreadId: "provider-1",
          item: {
            type: "toolCall",
            id: "call-delegate",
            tool: "Task",
            status: "pending",
          },
        },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "item/completed",
        scope: turnScope("root-turn"),
        data: {
          providerThreadId: "provider-1",
          item: {
            type: "toolCall",
            id: "call-delegate",
            tool: "Task",
            status: "completed",
          },
        },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/started",
        scope: turnScope("child-turn"),
        data: {
          providerThreadId: "provider-1",
          parentToolCallId: "call-delegate",
        },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "item/started",
        scope: turnScope("child-turn"),
        data: {
          providerThreadId: "provider-1",
          item: { type: "toolCall", id: "call-child-1", tool: "Read", status: "pending" },
        },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "item/completed",
        scope: turnScope("child-turn"),
        data: {
          providerThreadId: "provider-1",
          item: { type: "toolCall", id: "call-child-1", tool: "Read", status: "completed" },
        },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/completed",
        scope: turnScope("child-turn"),
        data: { providerThreadId: "provider-1", status: "completed" },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/completed",
        scope: turnScope("root-turn"),
        data: { providerThreadId: "provider-1", status: "completed" },
      });

      const root = buildThreadTurnRecord(harness.db, {
        threadId: thread.id,
        turnId: "root-turn",
      });
      expect(root.isRoot).toBe(true);
      expect(root.parentToolCallId).toBeNull();
      expect(root.counts.delegations).toBe(1);
      expect(root.counts.subagentSpans).toBe(1);
      expect(root.spans).toHaveLength(1);
      expect(root.spans[0]).toMatchObject({ kind: "delegation", itemId: "call-delegate" });

      const child = buildThreadTurnRecord(harness.db, {
        threadId: thread.id,
        turnId: "child-turn",
      });
      expect(child.isRoot).toBe(false);
      expect(child.parentToolCallId).toBe("call-delegate");
    });
  });

  it("records the error message and error count for a failed turn", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedTelemetryThread(harness);

      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/started",
        scope: turnScope("turn-fail"),
        data: { providerThreadId: "provider-1" },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/completed",
        scope: turnScope("turn-fail"),
        data: {
          providerThreadId: "provider-1",
          status: "failed",
          error: { message: "Provider returned a fatal error" },
        },
      });

      const record = buildThreadTurnRecord(harness.db, {
        threadId: thread.id,
        turnId: "turn-fail",
      });
      expect(record.status).toBe("failed");
      expect(record.errorMessage).toBe("Provider returned a fatal error");
      expect(record.counts.errors).toBe(1);
    });
  });

  it("prefers a provider-reported duration over the event-clock duration", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = await seedTelemetryThread(harness);
      const turnId = "turn-duration";
      let sequence = 0;
      const startedAt = 10_000;

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: ++sequence,
        createdAt: startedAt,
        type: "turn/started",
        scope: turnScope(turnId),
        data: { providerThreadId: "provider-1" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: ++sequence,
        createdAt: startedAt,
        type: "item/started",
        scope: turnScope(turnId),
        data: {
          providerThreadId: "provider-1",
          item: { type: "toolCall", id: "call-1", tool: "Bash", status: "pending" },
        },
      });
      // Five seconds pass on the event clock, but the provider reports the
      // tool call itself only took 42ms.
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: ++sequence,
        createdAt: startedAt + 5_000,
        type: "item/completed",
        scope: turnScope(turnId),
        data: {
          providerThreadId: "provider-1",
          item: {
            type: "toolCall",
            id: "call-1",
            tool: "Bash",
            status: "completed",
            durationMs: 42,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: ++sequence,
        createdAt: startedAt + 5_100,
        type: "turn/completed",
        scope: turnScope(turnId),
        data: { providerThreadId: "provider-1", status: "completed" },
      });

      const record = buildThreadTurnRecord(harness.db, { threadId: thread.id, turnId });
      expect(record.spans).toHaveLength(1);
      expect(record.spans[0]?.durationMs).toBe(42);
      expect(record.spans[0]?.durationSource).toBe("provider");
    });
  });

  it("produces exactly one record for a steered turn with multiple item pairs under one turnId", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedTelemetryThread(harness);
      const turnId = "turn-steered";

      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/started",
        scope: turnScope(turnId),
        data: { providerThreadId: "provider-1" },
      });
      for (const callId of ["call-1", "call-2"]) {
        appendThreadEvent(harness.deps, {
          threadId: thread.id,
          type: "item/started",
          scope: turnScope(turnId),
          data: {
            providerThreadId: "provider-1",
            item: { type: "toolCall", id: callId, tool: "Bash", status: "pending" },
          },
        });
        appendThreadEvent(harness.deps, {
          threadId: thread.id,
          type: "item/completed",
          scope: turnScope(turnId),
          data: {
            providerThreadId: "provider-1",
            item: { type: "toolCall", id: callId, tool: "Bash", status: "completed" },
          },
        });
      }
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/completed",
        scope: turnScope(turnId),
        data: { providerThreadId: "provider-1", status: "completed" },
      });

      const record = buildThreadTurnRecord(harness.db, { threadId: thread.id, turnId });
      expect(record.turnId).toBe(turnId);
      expect(record.spans).toHaveLength(2);
      expect(record.counts.toolCalls).toBe(2);
    });
  });

  it("resolves the model from the turn's own client/turn/requested event, not the thread default", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedTelemetryThread(harness);
      const turnId = "turn-model";

      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        modelOverride: "thread-default-model",
      });

      const request = appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: null,
        type: "client/turn/requested",
        input: textInput("Do the thing"),
        target: { kind: "new-turn" },
        execution: {
          model: "turn-specific-model",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        initiator: "user",
        senderThreadId: null,
        requestMethod: "turn/start",
        source: "tell",
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/started",
        scope: turnScope(turnId),
        data: { providerThreadId: "provider-1" },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/input/accepted",
        scope: turnScope(turnId),
        data: { providerThreadId: "provider-1", clientRequestId: request.requestId },
      });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        type: "turn/completed",
        scope: turnScope(turnId),
        data: { providerThreadId: "provider-1", status: "completed" },
      });

      const record = buildThreadTurnRecord(harness.db, { threadId: thread.id, turnId });
      expect(record.model).toBe("turn-specific-model");
      expect(record.modelSource).toBe("turn-request");
    });
  });
});
