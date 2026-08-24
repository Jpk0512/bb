// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Notification } from "@bb/domain";
import { InboxView } from "./InboxView";

const mocks = vi.hoisted(() => ({
  dismiss: vi.fn(),
  open: vi.fn(),
  refetch: vi.fn(),
  notifications: [] as Notification[],
  unreadCount: 0,
  isLoading: false,
  isError: false,
}));

vi.mock("@/hooks/queries/notification-queries", () => ({
  useNotificationList: () => ({
    data: {
      notifications: mocks.notifications,
      unreadCount: mocks.unreadCount,
    },
    isLoading: mocks.isLoading,
    isError: mocks.isError,
    refetch: mocks.refetch,
  }),
  useDismissNotification: () => ({
    isPending: false,
    mutateAsync: mocks.dismiss,
  }),
  useOpenNotification: () => ({
    isPending: false,
    mutateAsync: mocks.open,
  }),
}));

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "note-1",
    threadId: "thread-1",
    projectId: "project-1",
    sourceKind: "plugin",
    pluginId: "board",
    category: "review-ready",
    title: "Review ready",
    body: "Two findings need attention.",
    payload: {},
    rendererId: null,
    dedupeKey: null,
    attention: true,
    createdAt: Date.now() - 60_000,
    readAt: null,
    dismissedAt: null,
    target: {
      threadId: "thread-1",
      title: "Fix the regression",
      titleFallback: null,
      visibility: "visible",
      archivedAt: null,
    },
    ...overrides,
  };
}

describe("InboxView", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.dismiss.mockReset();
    mocks.open.mockReset();
    mocks.refetch.mockReset();
    mocks.isLoading = false;
    mocks.isError = false;
    mocks.dismiss.mockResolvedValue(notification());
    mocks.open.mockResolvedValue({
      outcome: "focused",
      threadId: "thread-1",
      redirectedFromThreadId: null,
      restored: { unhidden: false, unarchived: false },
    });
    mocks.notifications = [
      notification(),
      notification({ id: "note-2", title: "Follow-up ready", readAt: 1 }),
    ];
    mocks.unreadCount = 1;
  });

  it("groups notifications by thread and exposes native Open and Dismiss actions", () => {
    render(<InboxView />);

    expect(
      screen.getByRole("heading", { name: "Fix the regression" }),
    ).toBeDefined();
    expect(screen.getAllByText("Visible thread")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
    expect(mocks.dismiss).toHaveBeenCalledWith("note-1");
  });

  it("states when a notification target is unavailable", () => {
    mocks.notifications = [notification({ target: null })];
    render(<InboxView />);

    expect(screen.getByText("Thread unavailable")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Open" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("renders a distinct loading state", () => {
    mocks.isLoading = true;
    render(<InboxView />);

    expect(screen.getByRole("status").textContent).toBe("Loading inbox");
    expect(screen.queryByText("Unable to load inbox.")).toBeNull();
  });

  it("renders a distinct error state with retry", () => {
    mocks.isError = true;
    render(<InboxView />);

    expect(screen.getByText("Unable to load inbox.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetch).toHaveBeenCalled();
  });
});
