// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpandableTimelineRow } from "./ExpandableTimelineRow.js";
import {
  ChildSessionCollapsedPreview,
  ChildSessionRowBody,
  type ChildSessionWorkRow,
} from "./rows/ChildSession.js";

const mocks = vi.hoisted(() => ({
  childThread: {
    hasPendingInteraction: false,
    runtime: { displayStatus: "active" },
    status: "active",
  },
  stopThreadMutate: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({ data: mocks.childThread }),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useStopThread: () => ({
    isPending: false,
    mutate: mocks.stopThreadMutate,
    variables: undefined,
  }),
}));

vi.mock("@/lib/ws", () => ({
  wsManager: {
    subscribe: mocks.subscribe,
    unsubscribe: mocks.unsubscribe,
  },
}));

vi.mock("./ThreadTimelinePanelContent.js", () => ({
  ThreadTimelinePanelContent: ({ threadId }: { threadId: string }) => (
    <div data-testid={`child-transcript-${threadId}`}>Child transcript</div>
  ),
}));

const CHILD_SESSION_ROW: ChildSessionWorkRow = {
  id: "parent:child-session:child-1",
  threadId: "parent",
  turnId: null,
  sourceSeqStart: 1,
  sourceSeqEnd: 1,
  startedAt: 1,
  createdAt: 1,
  kind: "work",
  status: "pending",
  workKind: "child-session",
  childThreadId: "child-1",
  childKind: "dispatch:worker",
  title: "Research worker",
  providerId: "codex",
  model: "gpt-5.4",
  childStatus: "running",
  statusReason: null,
  outputExcerpt: null,
  completedAt: null,
};

function renderChildSession(row: ChildSessionWorkRow = CHILD_SESSION_ROW) {
  return render(
    <ExpandableTimelineRow
      title={{
        segments: [
          {
            text: "Codex worker · ",
            em: false,
            shimmer: false,
            truncate: false,
          },
          { text: row.title, em: true, shimmer: false, truncate: true },
        ],
        decorations: [],
        tone: "default",
        action: null,
        plain: `Codex worker · ${row.title}`,
      }}
      collapsedPreview={<ChildSessionCollapsedPreview row={row} />}
      renderBody={() => <ChildSessionRowBody row={row} />}
    />,
  );
}

afterEach(() => {
  cleanup();
  mocks.childThread = {
    hasPendingInteraction: false,
    runtime: { displayStatus: "active" },
    status: "active",
  };
  mocks.stopThreadMutate.mockReset();
  mocks.subscribe.mockReset();
  mocks.unsubscribe.mockReset();
});

describe("ChildSession", () => {
  it("stays collapsed until manually expanded, then mounts and unsubscribes the child transcript", async () => {
    renderChildSession();

    expect(screen.queryByTestId("child-transcript-child-1")).toBeNull();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(screen.getByText("codex · gpt-5.4")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();

    const [header] = screen.getAllByRole("button");
    fireEvent.click(header);

    expect(await screen.findByTestId("child-transcript-child-1")).toBeTruthy();
    expect(mocks.subscribe).toHaveBeenCalledWith({
      kind: "thread-detail",
      threadId: "child-1",
    });

    fireEvent.click(header);

    await waitFor(() => {
      expect(mocks.unsubscribe).toHaveBeenCalledWith({
        kind: "thread-detail",
        threadId: "child-1",
      });
    });
  });

  it("stops a non-terminal child", () => {
    renderChildSession();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(mocks.stopThreadMutate).toHaveBeenCalledWith("child-1");
  });

  it("hides Stop after the child reaches a terminal status", () => {
    mocks.childThread = {
      hasPendingInteraction: false,
      runtime: { displayStatus: "idle" },
      status: "idle",
    };

    renderChildSession({ ...CHILD_SESSION_ROW, childStatus: "completed" });

    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByText("Completed")).toBeTruthy();
  });
});
