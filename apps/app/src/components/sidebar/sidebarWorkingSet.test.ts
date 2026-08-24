import type { ThreadListEntry } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  buildSidebarWorkingSet,
  SIDEBAR_WORKING_SET_LIMIT,
} from "./sidebarWorkingSet";

function createThread(
  overrides: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return {
    id: "thr_1",
    projectId: "proj_1",
    environmentId: null,
    providerId: "codex",
    title: "Thread",
    titleFallback: "Thread",
    sectionId: null,
    status: "idle",
    childKind: null,
    parentThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "visible",
    archivedAt: null,
    pinnedAt: null,
    pinSortKey: null,
    deletedAt: null,
    lastReadAt: 0,
    latestAttentionAt: 0,
    createdAt: 0,
    updatedAt: 0,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentName: null,
    environmentBranchName: null,
    environmentWorkspaceDisplayKind: "other",
    runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    ...overrides,
  };
}

describe("buildSidebarWorkingSet", () => {
  const now = 1_000_000_000;

  it("keeps pinned, active, needs-input, running, and recently touched threads", () => {
    const result = buildSidebarWorkingSet({
      now,
      mode: "working",
      threads: [
        createThread({ id: "pinned", pinnedAt: 2 }),
        createThread({ id: "active", status: "active" }),
        createThread({ id: "needs-input", hasPendingInteraction: true }),
        createThread({
          id: "running",
          runtime: {
            displayStatus: "active",
            hostReconnectGraceExpiresAt: null,
          },
        }),
        createThread({ id: "recent", updatedAt: now - 1 }),
        createThread({ id: "older", updatedAt: 0 }),
      ],
    });

    expect(result.threads.map((thread) => thread.id)).toEqual([
      "pinned",
      "recent",
      "active",
      "needs-input",
      "running",
    ]);
    expect(result.olderThreadCount).toBe(1);
  });

  it("caps the working set and reports the remaining eligible sessions", () => {
    const result = buildSidebarWorkingSet({
      now,
      mode: "working",
      threads: Array.from(
        { length: SIDEBAR_WORKING_SET_LIMIT + 2 },
        (_, index) =>
          createThread({
            id: `recent-${index}`,
            latestAttentionAt: index,
            updatedAt: now,
          }),
      ),
    });

    expect(result.threads).toHaveLength(SIDEBAR_WORKING_SET_LIMIT);
    expect(result.olderThreadCount).toBe(2);
    expect(result.threads[0]?.id).toBe(
      `recent-${SIDEBAR_WORKING_SET_LIMIT + 1}`,
    );
  });

  it("returns every session in Show all mode", () => {
    const threads = [
      createThread({ id: "old", updatedAt: 0 }),
      createThread({ id: "recent", updatedAt: now }),
    ];

    expect(buildSidebarWorkingSet({ now, mode: "all", threads })).toEqual({
      olderThreadCount: 0,
      threads,
    });
  });
});
