import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/connection.js";
import {
  countUnreadNotificationsByThread,
  createNotification,
  dismissNotification,
  getNotification,
  listNotifications,
  markNotificationRead,
} from "../../src/data/notifications.js";
import { createProject } from "../../src/data/projects.js";
import {
  createThread,
  deleteThread,
  getThread,
  listThreadsWithPendingInteractionState,
} from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "notification-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "notification-project",
    source: {
      type: "local_path",
      hostId: host.id,
      path: "/tmp/notifications",
    },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, project, thread };
}

describe("notifications data", () => {
  it("creates idempotently by plugin and dedupe key", () => {
    const { db, thread } = setup();
    const first = createNotification(db, noopNotifier, {
      pluginId: "board",
      threadId: thread.id,
      category: "review-ready",
      title: "Review ready",
      payload: { runId: "run-1" },
      dedupeKey: "run-1",
    });
    const retried = createNotification(db, noopNotifier, {
      pluginId: "board",
      threadId: thread.id,
      category: "review-ready",
      title: "Changed retry title",
      payload: { runId: "run-1", retry: true },
      dedupeKey: "run-1",
    });

    expect(first?.created).toBe(true);
    expect(retried).toEqual({
      created: false,
      notification: first?.notification,
    });
    expect(listNotifications(db)).toHaveLength(1);
  });

  it("marks attention in the creation transaction only when requested", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project, thread } = setup();
      vi.setSystemTime(2_000);
      createNotification(db, noopNotifier, {
        attention: false,
        pluginId: "board",
        threadId: thread.id,
        category: "info",
        title: "Quiet update",
      });
      expect(getThread(db, thread.id)?.latestAttentionAt).toBe(1_000);

      vi.setSystemTime(3_000);
      createNotification(db, noopNotifier, {
        pluginId: "board",
        threadId: thread.id,
        category: "approval-needed",
        title: "Needs approval",
      });
      expect(getThread(db, thread.id)?.latestAttentionAt).toBe(3_000);
      expect(
        listThreadsWithPendingInteractionState(db, {
          projectId: project.id,
        })[0]?.unreadNotificationCount,
      ).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps read and dismissal independent and dismissal terminal", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, thread } = setup();
      const created = createNotification(db, noopNotifier, {
        pluginId: "board",
        threadId: thread.id,
        category: "worker-finished",
        title: "Worker finished",
      });
      const id = created?.notification.id;
      if (!id) throw new Error("Expected notification creation");

      expect(countUnreadNotificationsByThread(db, thread.id)).toBe(1);
      vi.setSystemTime(2_000);
      expect(markNotificationRead(db, noopNotifier, id)?.readAt).toBe(2_000);
      expect(listNotifications(db)).toHaveLength(1);
      expect(countUnreadNotificationsByThread(db, thread.id)).toBe(0);

      vi.setSystemTime(3_000);
      expect(dismissNotification(db, noopNotifier, id)?.dismissedAt).toBe(
        3_000,
      );
      expect(listNotifications(db, { state: "open" })).toEqual([]);
      expect(listNotifications(db, { state: "all" })).toHaveLength(1);

      vi.setSystemTime(4_000);
      expect(dismissNotification(db, noopNotifier, id)?.dismissedAt).toBe(
        3_000,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cascades hard-deleted thread notifications", () => {
    const { db, thread } = setup();
    const created = createNotification(db, noopNotifier, {
      pluginId: "board",
      threadId: thread.id,
      category: "info",
      title: "Temporary",
    });
    const id = created?.notification.id;
    if (!id) throw new Error("Expected notification creation");

    expect(deleteThread(db, noopNotifier, thread.id)).toBe(true);
    expect(getNotification(db, id)).toBeNull();
  });
});
