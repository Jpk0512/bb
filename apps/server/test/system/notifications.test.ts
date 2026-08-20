import {
  archiveThread,
  getNotification,
  getThread,
  markThreadDeleted,
  setThreadSupersededBy,
} from "@bb/db";
import { notificationSchema } from "@bb/domain";
import {
  notificationListResponseSchema,
  notificationOpenResponseSchema,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function createTestNotification(
  harness: TestAppHarness,
  threadId: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await harness.app.request("/api/v1/notifications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pluginId: "board",
      threadId,
      category: "review-ready",
      title: "Review ready",
      body: "Findings are available",
      payload: { runId: "run-1" },
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  return notificationSchema.parse(await readJson(response));
}

async function postNotificationAction(
  harness: TestAppHarness,
  notificationId: string,
  action: "dismiss" | "open" | "read",
): Promise<Response> {
  return harness.app.request(
    `/api/v1/notifications/${notificationId}/${action}`,
    { method: "POST" },
  );
}

describe("notifications", () => {
  it("restores a hidden archived user thread before focusing and marks read", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-notification-open",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/notification-open",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        visibility: "hidden",
      });
      archiveThread(harness.db, harness.deps.hub, thread.id);
      const notification = await createTestNotification(harness, thread.id);
      const socket = createMockHubSocket();
      harness.deps.hub.registerClient(socket);

      const response = await postNotificationAction(
        harness,
        notification.id,
        "open",
      );
      expect(response.status).toBe(200);
      expect(
        notificationOpenResponseSchema.parse(await readJson(response)),
      ).toEqual({
        outcome: "focused",
        threadId: thread.id,
        redirectedFromThreadId: null,
        restored: { unhidden: true, unarchived: true },
      });
      expect(getThread(harness.db, thread.id)).toMatchObject({
        visibility: "visible",
        archivedAt: null,
      });
      expect(
        getNotification(harness.db, notification.id)?.readAt,
      ).not.toBeNull();
      expect(
        socket.messages.some((message) => {
          const parsed = JSON.parse(message) as { type?: string };
          return parsed.type === "thread-open";
        }),
      ).toBe(true);
    });
  });

  it("restores with no client but never unhides a plugin-owned worker", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-notification-worker",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/notification-worker",
      });
      const thread = seedThread(harness.deps, {
        originKind: "fork",
        originPluginId: "dispatch",
        projectId: project.id,
        visibility: "hidden",
      });
      archiveThread(harness.db, harness.deps.hub, thread.id);
      const notification = await createTestNotification(harness, thread.id);

      const response = await postNotificationAction(
        harness,
        notification.id,
        "open",
      );
      expect(
        notificationOpenResponseSchema.parse(await readJson(response)),
      ).toEqual({
        outcome: "no-client",
        threadId: thread.id,
        redirectedFromThreadId: null,
        restored: { unhidden: false, unarchived: true },
      });
      expect(getThread(harness.db, thread.id)).toMatchObject({
        visibility: "hidden",
        archivedAt: null,
      });
    });
  });

  it("returns target-missing as a successful outcome for a soft-deleted thread", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-notification-missing",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/notification-missing",
      });
      const thread = seedThread(harness.deps, { projectId: project.id });
      const notification = await createTestNotification(harness, thread.id);
      markThreadDeleted(harness.db, harness.deps.hub, {
        threadId: thread.id,
      });

      const response = await postNotificationAction(
        harness,
        notification.id,
        "open",
      );
      expect(response.status).toBe(200);
      expect(
        notificationOpenResponseSchema.parse(await readJson(response)),
      ).toEqual({
        outcome: "target-missing",
        threadId: thread.id,
        redirectedFromThreadId: null,
        restored: { unhidden: false, unarchived: false },
      });
      expect(
        getNotification(harness.db, notification.id)?.readAt,
      ).not.toBeNull();
    });
  });

  it("resolves the lineage head before opening", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-notification-lineage",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/notification-lineage",
      });
      const source = seedThread(harness.deps, { projectId: project.id });
      const successor = seedThread(harness.deps, { projectId: project.id });
      setThreadSupersededBy(harness.db, harness.deps.hub, {
        threadId: source.id,
        supersededByThreadId: successor.id,
      });
      const notification = await createTestNotification(harness, source.id);

      const response = await postNotificationAction(
        harness,
        notification.id,
        "open",
      );
      expect(
        notificationOpenResponseSchema.parse(await readJson(response)),
      ).toMatchObject({
        outcome: "no-client",
        threadId: successor.id,
        redirectedFromThreadId: source.id,
      });
    });
  });

  it("invalidates inbox rows when a target changes disposition", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-notification-target-change",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/notification-target-change",
      });
      const thread = seedThread(harness.deps, { projectId: project.id });
      const socket = createMockHubSocket();
      harness.deps.hub.registerClient(socket);
      harness.deps.hub.subscribe(socket, { kind: "system" });
      await createTestNotification(harness, thread.id);
      socket.messages.length = 0;

      archiveThread(harness.db, harness.deps.hub, thread.id);

      expect(
        socket.messages.some((message) => {
          const parsed = JSON.parse(message) as {
            type?: string;
            changes?: string[];
          };
          return (
            parsed.type === "changed" &&
            parsed.changes?.includes("notifications-changed") === true
          );
        }),
      ).toBe(true);
    });
  });

  it("filters by project, keeps dismissed rows only in all, and broadcasts payload-free changes", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-notification-list",
      });
      const firstProject = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/notification-list-a",
      }).project;
      const secondProject = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/notification-list-b",
      }).project;
      const firstThread = seedThread(harness.deps, {
        projectId: firstProject.id,
      });
      const secondThread = seedThread(harness.deps, {
        projectId: secondProject.id,
      });
      const socket = createMockHubSocket();
      harness.deps.hub.registerClient(socket);
      harness.deps.hub.subscribe(socket, {
        kind: "thread-detail",
        threadId: firstThread.id,
      });
      harness.deps.hub.subscribe(socket, { kind: "system" });
      const first = await createTestNotification(harness, firstThread.id, {
        dedupeKey: "first",
      });
      await createTestNotification(harness, secondThread.id, {
        dedupeKey: "second",
      });

      const changed = socket.messages
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .filter((message) => message.type === "changed");
      expect(
        changed.some(
          (message) =>
            Array.isArray(message.changes) &&
            message.changes.includes("notifications-changed"),
        ),
      ).toBe(true);
      expect(
        changed.every(
          (message) =>
            !("title" in message) &&
            !("body" in message) &&
            !("payload" in message),
        ),
      ).toBe(true);

      const listResponse = await harness.app.request(
        `/api/v1/notifications?projectId=${firstProject.id}`,
      );
      const listed = notificationListResponseSchema.parse(
        await readJson(listResponse),
      );
      expect(listed.notifications.map((row) => row.id)).toEqual([first.id]);

      await postNotificationAction(harness, first.id, "dismiss");
      const open = notificationListResponseSchema.parse(
        await readJson(
          await harness.app.request(
            `/api/v1/notifications?projectId=${firstProject.id}`,
          ),
        ),
      );
      expect(open.notifications).toEqual([]);
      const all = notificationListResponseSchema.parse(
        await readJson(
          await harness.app.request(
            `/api/v1/notifications?projectId=${firstProject.id}&state=all`,
          ),
        ),
      );
      expect(all.notifications.map((row) => row.id)).toEqual([first.id]);
    });
  });
});
