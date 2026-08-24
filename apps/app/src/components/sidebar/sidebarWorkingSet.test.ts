import type { ThreadListEntry } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  buildSidebarWorkingSet,
  summarizeWorkingSetsByProject,
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
      "active",
      "needs-input",
      "running",
      "recent",
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

  it("never caps active work, including background activity on idle threads", () => {
    const recentThreads = Array.from(
      { length: SIDEBAR_WORKING_SET_LIMIT + 2 },
      (_, index) =>
        createThread({
          id: `recent-${index}`,
          updatedAt: now,
        }),
    );
    const result = buildSidebarWorkingSet({
      now,
      mode: "working",
      threads: [
        ...recentThreads,
        createThread({ id: "needs-input", hasPendingInteraction: true }),
        createThread({
          id: "background",
          activity: {
            activeWorkflowCount: 0,
            activeBackgroundAgentCount: 1,
            activeBackgroundCommandCount: 0,
            activePlanModeCount: 0,
            activeGoalCount: 0,
          },
        }),
      ],
    });

    expect(result.threads.map((thread) => thread.id)).toEqual(
      expect.arrayContaining(["needs-input", "background"]),
    );
    expect(result.threads).toHaveLength(SIDEBAR_WORKING_SET_LIMIT);
  });

  it("retains pinned descendants before applying the recent cap", () => {
    const result = buildSidebarWorkingSet({
      now,
      mode: "working",
      pinnedThreadIds: new Set(["pinned-root", "pinned-child"]),
      threads: [
        createThread({ id: "pinned-root", pinnedAt: 1 }),
        createThread({ id: "pinned-child", parentThreadId: "pinned-root" }),
        ...Array.from({ length: SIDEBAR_WORKING_SET_LIMIT }, (_, index) =>
          createThread({ id: `recent-${index}`, updatedAt: now }),
        ),
      ],
    });

    expect(result.threads.map((thread) => thread.id)).toEqual(
      expect.arrayContaining(["pinned-root", "pinned-child"]),
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

  it("reports older counts independently per project",
    () => {
      const result = summarizeWorkingSetsByProject({
        modesByProject: {},
        now,
        threads: [
          ...Array.from({ length: SIDEBAR_WORKING_SET_LIMIT + 1 }, (_, index) =>
            createThread({
              id: `a-${index}`,
              projectId: "proj_a",
              updatedAt: now,
            }),
          ),
          ...Array.from({ length: 2 }, (_, index) =>
            createThread({
              id: `b-${index}`,
              projectId: "proj_b",
              updatedAt: now,
            }),
          ),
        ],
      });
      expect(result.olderByProject).toEqual([
        { projectId: "proj_a", count: 1 },
      ]);
      expect(result.olderThreadCount).toBe(1);
    },
  );
});
