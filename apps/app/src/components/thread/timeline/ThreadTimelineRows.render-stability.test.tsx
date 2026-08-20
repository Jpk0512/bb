// @vitest-environment jsdom

import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineChildSessionWorkRow } from "@bb/server-contract";
import { threadsQueryKey } from "@/hooks/queries/query-keys";
import { makeThreadListEntry } from "@/test/fixtures/thread-list-entries";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({
    data: {
      hasPendingInteraction: false,
      runtime: { displayStatus: "active" },
      status: "active",
    },
  }),
  useThreadTimelineTurnSummaryDetails: () => ({
    data: undefined,
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useStopThread: () => ({
    isPending: false,
    mutate: vi.fn(),
    variables: undefined,
  }),
}));

// The query cache notifies through notifyManager's scheduler (a macrotask),
// so cache writes only reach subscribers after a timer tick.
function flushCacheNotifications(): Promise<void> {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
}

function timelineRowsFixture() {
  const rows = [
    conversationRow({
      id: "agent_sourced_message",
      role: "user",
      initiator: "agent",
      senderThreadId: "thr_sender",
      text: "Message from the sender thread.",
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      threadId: "thr_main",
    }),
  ];
  for (let index = 0; index < 20; index += 1) {
    rows.push(
      conversationRow({
        id: `assistant_message_${index}`,
        role: "assistant",
        text: `Assistant answer number ${index}.`,
        sourceSeqStart: 10 + index,
        sourceSeqEnd: 10 + index,
        threadId: "thr_main",
      }),
    );
  }
  return rows;
}

function childSessionRow(): TimelineChildSessionWorkRow {
  return {
    id: "child-session-1",
    threadId: "thr_main",
    turnId: null,
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 1,
    createdAt: 1,
    kind: "work",
    status: "pending",
    workKind: "child-session",
    childThreadId: "thr_child",
    childKind: "dispatch:worker",
    title: "Worker",
    providerId: "codex",
    model: null,
    childStatus: "running",
    statusReason: null,
    outputExcerpt: null,
    completedAt: null,
  };
}

function renderProfiledTimeline(queryClient: QueryClient) {
  const commits: { phase: string }[] = [];
  const onRender: ProfilerOnRenderCallback = (_id, phase) => {
    commits.push({ phase });
  };
  const view = render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Profiler id="timeline" onRender={onRender}>
          <ThreadTimelineRows
            threadId="thr_main"
            timelineRows={timelineRowsFixture()}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
          />
        </Profiler>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { commits, view };
}

afterEach(() => {
  cleanup();
});

describe("ThreadTimelineRows render stability", () => {
  it("does not re-render the timeline when cache events carry equal thread metadata", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(threadsQueryKey(), [
      makeThreadListEntry({ id: "thr_sender", title: "Sender thread" }),
    ]);
    const { commits, view } = renderProfiledTimeline(queryClient);
    expect(view.getByText("Sender thread")).toBeTruthy();
    await flushCacheNotifications();
    const settledCommitCount = commits.length;

    // Realtime events refetch thread lists constantly; each success dispatches
    // an "updated" cache event with fresh array identity but equal values.
    // None of them may commit the timeline again — before the stable-reference
    // fix, every event re-rendered all rows past React.memo.
    for (let round = 0; round < 10; round += 1) {
      await act(async () => {
        queryClient.setQueryData(threadsQueryKey(), [
          makeThreadListEntry({ id: "thr_sender", title: "Sender thread" }),
        ]);
      });
    }
    await flushCacheNotifications();

    expect(commits.length).toBe(settledCommitCount);
  });

  it("re-renders and shows the new sender title when metadata actually changes", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(threadsQueryKey(), [
      makeThreadListEntry({ id: "thr_sender", title: null }),
    ]);
    const { view } = renderProfiledTimeline(queryClient);
    expect(view.getByText("Agent")).toBeTruthy();

    await act(async () => {
      queryClient.setQueryData(threadsQueryKey(), [
        makeThreadListEntry({ id: "thr_sender", title: "Sender thread" }),
      ]);
    });

    await waitFor(() => {
      expect(view.getByText("Sender thread")).toBeTruthy();
    });
  });

  it("does not remount an unchanged child session when the parent timeline updates", () => {
    const queryClient = new QueryClient();
    const childSession = childSessionRow();
    const { getByTestId, rerender } = render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <ThreadTimelineRows
            threadId="thr_main"
            timelineRows={[childSession]}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const beforeUpdate = getByTestId("child-session-preview-thr_child");

    rerender(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <ThreadTimelineRows
            threadId="thr_main"
            timelineRows={[
              childSession,
              conversationRow({
                id: "parent-update",
                role: "assistant",
                text: "Parent timeline updated.",
                sourceSeqStart: 2,
                sourceSeqEnd: 2,
                threadId: "thr_main",
              }),
            ]}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(getByTestId("child-session-preview-thr_child")).toBe(beforeUpdate);
  });
});
