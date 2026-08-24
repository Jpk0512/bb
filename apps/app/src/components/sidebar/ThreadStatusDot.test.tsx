// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadListEntry } from "@bb/domain";
import {
  resolveThreadStatusDotKind,
  ThreadStatusDot,
} from "./ThreadStatusDot";

afterEach(() => {
  cleanup();
});

type BaseThread = Pick<
  ThreadListEntry,
  | "activity"
  | "hasPendingInteraction"
  | "lastReadAt"
  | "latestAttentionAt"
  | "runtime"
>;

const NO_ACTIVITY: ThreadListEntry["activity"] = {
  activeWorkflowCount: 0,
  activeBackgroundAgentCount: 0,
  activeBackgroundCommandCount: 0,
  activePlanModeCount: 0,
  activeGoalCount: 0,
};

function makeThread(overrides: Partial<BaseThread> = {}): BaseThread {
  return {
    activity: NO_ACTIVITY,
    hasPendingInteraction: false,
    lastReadAt: 100,
    latestAttentionAt: 50,
    runtime: { displayStatus: "idle" } as BaseThread["runtime"],
    ...overrides,
  };
}

function busyRuntime(): BaseThread["runtime"] {
  return { displayStatus: "active" } as BaseThread["runtime"];
}

describe("resolveThreadStatusDotKind", () => {
  it("returns none for an idle, read thread", () => {
    expect(resolveThreadStatusDotKind(makeThread())).toBe("none");
  });

  it("returns unread when unread and otherwise idle", () => {
    const thread = makeThread({ lastReadAt: null, latestAttentionAt: 50 });
    expect(resolveThreadStatusDotKind(thread)).toBe("unread");
  });

  it("returns background-work when a background agent is active", () => {
    const thread = makeThread({
      activity: { ...NO_ACTIVITY, activeBackgroundAgentCount: 1 },
    });
    expect(resolveThreadStatusDotKind(thread)).toBe("background-work");
  });

  it("returns needs-input when pending interaction is set", () => {
    const thread = makeThread({ hasPendingInteraction: true });
    expect(resolveThreadStatusDotKind(thread)).toBe("needs-input");
  });

  it("returns running when the runtime is busy", () => {
    const thread = makeThread({ runtime: busyRuntime() });
    expect(resolveThreadStatusDotKind(thread)).toBe("running");
  });

  it("running outranks unread", () => {
    const thread = makeThread({
      runtime: busyRuntime(),
      lastReadAt: null,
      latestAttentionAt: 50,
    });
    expect(resolveThreadStatusDotKind(thread)).toBe("running");
  });

  it("running outranks needs-input and background work", () => {
    const thread = makeThread({
      runtime: busyRuntime(),
      hasPendingInteraction: true,
      activity: { ...NO_ACTIVITY, activeBackgroundAgentCount: 1 },
    });
    expect(resolveThreadStatusDotKind(thread)).toBe("running");
  });

  it("needs-input outranks background work and unread", () => {
    const thread = makeThread({
      hasPendingInteraction: true,
      activity: { ...NO_ACTIVITY, activeWorkflowCount: 1 },
      lastReadAt: null,
      latestAttentionAt: 50,
    });
    expect(resolveThreadStatusDotKind(thread)).toBe("needs-input");
  });

  it("background work outranks unread", () => {
    const thread = makeThread({
      activity: { ...NO_ACTIVITY, activeWorkflowCount: 1 },
      lastReadAt: null,
      latestAttentionAt: 50,
    });
    expect(resolveThreadStatusDotKind(thread)).toBe("background-work");
  });
});

describe("ThreadStatusDot", () => {
  it("renders nothing for an idle, read thread", () => {
    const { container } = render(<ThreadStatusDot thread={makeThread()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a labeled dot for a running thread", () => {
    render(
      <ThreadStatusDot thread={makeThread({ runtime: busyRuntime() })} />,
    );
    expect(screen.getByLabelText("Thread running")).not.toBeNull();
  });

  it("renders a hollow dot for needs-input", () => {
    render(
      <ThreadStatusDot
        thread={makeThread({ hasPendingInteraction: true })}
      />,
    );
    const dot = screen.getByLabelText("Thread needs input");
    expect(dot.className).toContain("border-warning");
    expect(dot.className).not.toContain("bg-attention");
  });
});
