// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadTurnResponse } from "@bb/server-contract";
import { threadTurnsQueryKey } from "@/hooks/queries/query-keys";
import { turnRow } from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

const THREAD_ID = "thread-1";

interface MakeTurnResponseArgs {
  countsErrors?: number;
  status?: ThreadTurnResponse["status"];
  turnId: string;
  usageSource?: ThreadTurnResponse["usage"]["source"];
}

function makeTurnResponse({
  countsErrors = 0,
  status = "completed",
  turnId,
  usageSource = "provider-turn-delta",
}: MakeTurnResponseArgs): ThreadTurnResponse {
  return {
    threadId: THREAD_ID,
    turnId,
    projectId: "project-1",
    providerId: "anthropic",
    model: "claude",
    modelSource: "turn-request",
    reasoningLevel: null,
    serviceTier: null,
    parentToolCallId: null,
    isRoot: true,
    initiator: "user",
    startedAt: 1_000,
    completedAt: 5_000,
    durationMs: 4_000,
    status,
    errorMessage: status === "failed" ? "Something went wrong." : null,
    counts: {
      toolCalls: 2,
      commands: 0,
      fileChanges: 0,
      delegations: 0,
      subagentSpans: 0,
      errors: countsErrors,
      interrupted: status === "interrupted",
    },
    usage: {
      totalTokens: usageSource === "none" ? null : 12_345,
      inputTokens: usageSource === "none" ? null : 10_000,
      cachedInputTokens: null,
      outputTokens: usageSource === "none" ? null : 2_345,
      reasoningOutputTokens: null,
      modelContextWindow: null,
      source: usageSource,
      costUsd: null,
    },
    sourceSeqStart: 10,
    sourceSeqEnd: 20,
    spansTruncated: false,
  };
}

function renderTimeline(
  queryClient: QueryClient,
  rows: Parameters<typeof ThreadTimelineRows>[0]["timelineRows"],
) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ThreadTimelineRows
          threadId={THREAD_ID}
          timelineRows={rows}
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("TurnTelemetryStrip", () => {
  it("renders exactly one strip for a steered turn split across multiple segments", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      threadTurnsQueryKey({
        threadId: THREAD_ID,
        turnId: "turn-1",
        includeSpans: false,
      }),
      { turns: [makeTurnResponse({ turnId: "turn-1" })] },
    );

    renderTimeline(queryClient, [
      turnRow({
        id: "turn-1-segment-0",
        turnId: "turn-1",
        threadId: THREAD_ID,
        sourceSeqStart: 10,
        sourceSeqEnd: 12,
      }),
      turnRow({
        id: "turn-1-segment-1",
        turnId: "turn-1",
        threadId: THREAD_ID,
        sourceSeqStart: 13,
        sourceSeqEnd: 16,
      }),
      turnRow({
        id: "turn-1-segment-2",
        turnId: "turn-1",
        threadId: THREAD_ID,
        sourceSeqStart: 17,
        sourceSeqEnd: 20,
      }),
    ]);

    const strips = await screen.findAllByTestId("turn-telemetry-strip");
    expect(strips).toHaveLength(1);
  });

  it("hides the token usage chip when usage.source is \"none\"", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      threadTurnsQueryKey({
        threadId: THREAD_ID,
        turnId: "turn-no-usage",
        includeSpans: false,
      }),
      {
        turns: [
          makeTurnResponse({ turnId: "turn-no-usage", usageSource: "none" }),
        ],
      },
    );

    renderTimeline(queryClient, [
      turnRow({
        id: "turn-no-usage-row",
        turnId: "turn-no-usage",
        threadId: THREAD_ID,
      }),
    ]);

    await screen.findByTestId("turn-telemetry-strip");
    expect(screen.queryByText(/tokens/i)).toBeNull();
  });

  it("shows an error indicator when the turn recorded errors", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      threadTurnsQueryKey({
        threadId: THREAD_ID,
        turnId: "turn-with-errors",
        includeSpans: false,
      }),
      {
        turns: [
          makeTurnResponse({ turnId: "turn-with-errors", countsErrors: 2 }),
        ],
      },
    );

    renderTimeline(queryClient, [
      turnRow({
        id: "turn-with-errors-row",
        turnId: "turn-with-errors",
        threadId: THREAD_ID,
      }),
    ]);

    await screen.findByTestId("turn-telemetry-strip");
    expect(screen.getByText("2 errors")).toBeTruthy();
  });

  it("shows an error indicator when the turn failed even with no per-tool errors", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      threadTurnsQueryKey({
        threadId: THREAD_ID,
        turnId: "turn-failed",
        includeSpans: false,
      }),
      {
        turns: [makeTurnResponse({ turnId: "turn-failed", status: "failed" })],
      },
    );

    renderTimeline(queryClient, [
      turnRow({
        id: "turn-failed-row",
        turnId: "turn-failed",
        threadId: THREAD_ID,
        status: "error",
      }),
    ]);

    await screen.findByTestId("turn-telemetry-strip");
    expect(screen.getByText("Failed")).toBeTruthy();
  });
});
