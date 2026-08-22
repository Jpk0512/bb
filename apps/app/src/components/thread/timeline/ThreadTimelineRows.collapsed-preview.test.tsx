// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type {
  TimelineChildSessionWorkRow,
  ThreadTurnResponse,
} from "@bb/server-contract";
import { threadTurnsQueryKey } from "@/hooks/queries/query-keys";
import { turnRow } from "@/test/fixtures/thread-timeline-rows";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

const THREAD_ID = "thread-1";
const CHILD_THREAD_ID = "child-1";
const TURN_ID = "turn-1";

const CHILD_SESSION_ROW: TimelineChildSessionWorkRow = {
  id: `${THREAD_ID}:child-session:${CHILD_THREAD_ID}`,
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 1,
  sourceSeqEnd: 1,
  startedAt: 1,
  createdAt: 1,
  kind: "work",
  status: "pending",
  workKind: "child-session",
  childThreadId: CHILD_THREAD_ID,
  childKind: "dispatch:worker",
  title: "Research worker",
  providerId: "codex",
  model: "gpt-5.4",
  childStatus: "running",
  statusReason: null,
  outputExcerpt: null,
  completedAt: null,
};

const TURN_RESPONSE: ThreadTurnResponse = {
  threadId: THREAD_ID,
  turnId: TURN_ID,
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
  status: "completed",
  errorMessage: null,
  counts: {
    toolCalls: 2,
    commands: 0,
    fileChanges: 0,
    delegations: 0,
    subagentSpans: 0,
    errors: 0,
    interrupted: false,
  },
  usage: {
    totalTokens: 12_345,
    inputTokens: 10_000,
    cachedInputTokens: null,
    outputTokens: 2_345,
    reasoningOutputTokens: null,
    modelContextWindow: null,
    source: "provider-turn-delta",
    costUsd: null,
  },
  sourceSeqStart: 10,
  sourceSeqEnd: 20,
  spansTruncated: false,
};

afterEach(() => {
  cleanup();
});

describe("timeline collapsed previews", () => {
  // Child-session and turn rows each own a collapsed preview. They are wired
  // through the same `collapsedPreview` prop, so a regression that keeps one
  // branch drops the other silently.
  it("renders the child-session preview and the turn telemetry strip together", async () => {
    const { queryClient, wrapper: QueryClientTestWrapper } =
      createQueryClientTestHarness();
    queryClient.setQueryData(
      threadTurnsQueryKey({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        includeSpans: false,
      }),
      { turns: [TURN_RESPONSE] },
    );

    render(
      <QueryClientTestWrapper>
        <MemoryRouter>
          <ThreadTimelineRows
            threadId={THREAD_ID}
            timelineRows={[
              CHILD_SESSION_ROW,
              turnRow({
                id: "turn-1-segment-0",
                turnId: TURN_ID,
                threadId: THREAD_ID,
              }),
            ]}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
          />
        </MemoryRouter>
      </QueryClientTestWrapper>,
    );

    expect(
      await screen.findByTestId(`child-session-preview-${CHILD_THREAD_ID}`),
    ).toBeTruthy();
    expect(await screen.findByTestId("turn-telemetry-strip")).toBeTruthy();
  });
});
