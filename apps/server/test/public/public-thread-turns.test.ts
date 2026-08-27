import { deleteProject, upsertThreadTurnRecord } from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import type { ThreadTurnRecord, ThreadTurnSpan } from "@bb/domain";
import {
  apiErrorSchema,
  threadTurnsResponseSchema,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";
import { THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT } from "../../src/services/threads/timeline.js";
import { DEFAULT_MAX_INLINE_OUTPUT_CHARS } from "../../src/services/threads/timeline-output-truncation.js";

const SAMPLE_SPAN: ThreadTurnSpan = {
  id: "span-1",
  itemId: "call-1",
  parentItemId: null,
  kind: "tool",
  name: "Bash",
  status: "completed",
  startedAt: 1_000,
  completedAt: 1_500,
  durationMs: 500,
  durationSource: "event-clock",
  detail: null,
  error: null,
  children: [],
};

function turnRecordFixture(args: {
  completedAt: number;
  projectId: string;
  spans?: ThreadTurnSpan[];
  startedAt?: number;
  threadId: string;
  turnId: string;
}): ThreadTurnRecord {
  return {
    threadId: args.threadId,
    turnId: args.turnId,
    projectId: args.projectId,
    providerId: "codex",
    model: "gpt-5",
    modelSource: "turn-request",
    reasoningLevel: "medium",
    serviceTier: "default",
    parentToolCallId: null,
    isRoot: true,
    initiator: "user",
    startedAt: args.startedAt ?? args.completedAt - 500,
    completedAt: args.completedAt,
    durationMs: 500,
    status: "completed",
    errorMessage: null,
    counts: {
      toolCalls: args.spans?.length ?? 0,
      commands: 0,
      fileChanges: 0,
      delegations: 0,
      subagentSpans: 0,
      errors: 0,
      interrupted: false,
    },
    usage: {
      totalTokens: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      modelContextWindow: null,
      source: "none",
      costUsd: null,
    },
    sourceSeqStart: 1,
    sourceSeqEnd: 2,
    spans: args.spans ?? [],
    spansTruncated: false,
  };
}

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

describe("public thread turns route", () => {
  it("returns every materialized turn even when the count exceeds the timeline's segment limit", async () => {
    await withTestHarness(async (harness) => {
      const { thread, project } = await seedTelemetryThread(harness);
      const turnCount = THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT + 5;
      for (let index = 0; index < turnCount; index += 1) {
        upsertThreadTurnRecord(
          harness.db,
          turnRecordFixture({
            threadId: thread.id,
            turnId: `turn-${index}`,
            projectId: project.id,
            completedAt: 1_000 + index,
          }),
        );
      }

      const response = await harness.app.request(`/api/v1/threads/${thread.id}/turns`);
      expect(response.status).toBe(200);
      const body = threadTurnsResponseSchema.parse(await readJson(response));
      expect(body.turns).toHaveLength(turnCount);
      expect(turnCount).toBeGreaterThan(THREAD_TIMELINE_DEFAULT_SEGMENT_LIMIT);
    });
  });

  it("omits spans by default and includes them only when includeSpans=true", async () => {
    await withTestHarness(async (harness) => {
      const { thread, project } = await seedTelemetryThread(harness);
      upsertThreadTurnRecord(
        harness.db,
        turnRecordFixture({
          threadId: thread.id,
          turnId: "turn-with-spans",
          projectId: project.id,
          completedAt: 1_000,
          spans: [SAMPLE_SPAN],
        }),
      );

      const defaultResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/turns`,
      );
      const defaultBody = (await readJson(defaultResponse)) as {
        turns: Array<Record<string, unknown>>;
      };
      expect(defaultBody.turns).toHaveLength(1);
      expect(Object.hasOwn(defaultBody.turns[0] ?? {}, "spans")).toBe(false);

      const withSpansResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/turns?includeSpans=true`,
      );
      const withSpansBody = threadTurnsResponseSchema.parse(
        await readJson(withSpansResponse),
      );
      expect(withSpansBody.turns[0]?.spans).toEqual([SAMPLE_SPAN]);

      const explicitFalseResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/turns?includeSpans=false`,
      );
      const explicitFalseBody = (await readJson(explicitFalseResponse)) as {
        turns: Array<Record<string, unknown>>;
      };
      expect(Object.hasOwn(explicitFalseBody.turns[0] ?? {}, "spans")).toBe(false);
    });
  });

  it("returns unclipped message text from item/completed events, not truncated storage", async () => {
    await withTestHarness(async (harness) => {
      const { thread, project, environment } = await seedTelemetryThread(harness);
      const turnId = "turn-messages";
      const longText = "x".repeat(DEFAULT_MAX_INLINE_OUTPUT_CHARS + 5_000);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "item/completed",
        scope: turnScope(turnId),
        data: {
          providerThreadId: "provider-1",
          item: { id: "agent-1", type: "agentMessage", text: longText },
        },
      });
      upsertThreadTurnRecord(
        harness.db,
        turnRecordFixture({
          threadId: thread.id,
          turnId,
          projectId: project.id,
          completedAt: 1_000,
        }),
      );

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/turns?include=messages`,
      );
      expect(response.status).toBe(200);
      const body = threadTurnsResponseSchema.parse(await readJson(response));
      const messages = body.turns[0]?.messages;
      expect(messages).toHaveLength(1);
      expect(messages?.[0]?.text).toHaveLength(longText.length);
      expect(messages?.[0]?.text).toBe(longText);
    });
  });

  it("recovers the user prompt from client/turn/requested when a turn has no userMessage item", async () => {
    await withTestHarness(async (harness) => {
      const { thread, project, environment } = await seedTelemetryThread(harness);
      const turnId = "turn-prompt";
      const requestId = encodeClientTurnRequestIdNumber({ value: 1 });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId,
          input: [
            { type: "text", text: "why is the build red?" },
            {
              type: "text",
              text: "injected context the user never typed",
              visibility: "agent-only",
            },
          ],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: { method: "turn/start", params: {} },
          source: "tell",
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-1",
        sequence: 2,
        type: "turn/input/accepted",
        scope: turnScope(turnId),
        data: { providerThreadId: "provider-1", clientRequestId: requestId },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 3,
        type: "item/completed",
        scope: turnScope(turnId),
        data: {
          providerThreadId: "provider-1",
          item: { id: "agent-1", type: "agentMessage", text: "the linker step" },
        },
      });
      upsertThreadTurnRecord(
        harness.db,
        turnRecordFixture({
          threadId: thread.id,
          turnId,
          projectId: project.id,
          completedAt: 1_000,
        }),
      );

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/turns?include=messages`,
      );
      expect(response.status).toBe(200);
      const body = threadTurnsResponseSchema.parse(await readJson(response));
      const messages = body.turns[0]?.messages;
      expect(messages?.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(messages?.[0]?.text).toBe("why is the build red?");
    });
  });

  it("returns a historical turn by turnId even when limit would otherwise keep only the newest", async () => {
    await withTestHarness(async (harness) => {
      const { thread, project } = await seedTelemetryThread(harness);
      upsertThreadTurnRecord(
        harness.db,
        turnRecordFixture({
          threadId: thread.id,
          turnId: "turn-older",
          projectId: project.id,
          completedAt: 1_000,
        }),
      );
      upsertThreadTurnRecord(
        harness.db,
        turnRecordFixture({
          threadId: thread.id,
          turnId: "turn-newest",
          projectId: project.id,
          completedAt: 2_000,
        }),
      );

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/turns?turnId=turn-older&limit=1`,
      );
      expect(response.status).toBe(200);
      const body = threadTurnsResponseSchema.parse(await readJson(response));
      expect(body.turns).toHaveLength(1);
      expect(body.turns[0]?.turnId).toBe("turn-older");
    });
  });

  it("404s for a thread whose project no longer exists", async () => {
    await withTestHarness(async (harness) => {
      const { thread, project } = await seedTelemetryThread(harness);
      upsertThreadTurnRecord(
        harness.db,
        turnRecordFixture({
          threadId: thread.id,
          turnId: "turn-isolated",
          projectId: project.id,
          completedAt: 1_000,
        }),
      );

      expect(deleteProject(harness.db, harness.hub, project.id)).toBe(true);

      const response = await harness.app.request(`/api/v1/threads/${thread.id}/turns`);
      expect(response.status).toBe(404);
      expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
        code: "thread_not_found",
      });
    });
  });
});
