import { and, eq } from "drizzle-orm";
import {
  countPendingParentNotifications,
  events,
  listNotifications,
  threads,
} from "@bb/db";
import { turnRequestEventDataSchema } from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import {
  deliverDueParentNotifications,
  queueChildThreadTurnNotificationBestEffort,
} from "../../src/services/threads/child-thread-notifications.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  withTestHarness,
} from "../helpers/test-app.js";

type TestHarness = Awaited<ReturnType<typeof createTestAppHarness>>;

function seedParentFixture(harness: TestHarness, hostId: string) {
  const { host } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/${hostId}-environment`,
  });
  const parent = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    title: "Orchestrator",
  });
  seedThreadRuntimeState(harness.deps, {
    threadId: parent.id,
    environmentId: environment.id,
    providerThreadId: `provider-${hostId}`,
    inputText: "Orchestrate things",
    model: "fake-model",
  });
  return { parentThreadId: parent.id, projectId: project.id };
}

function countParentSystemMessages(
  harness: TestHarness,
  parentThreadId: string,
): number {
  return harness.db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, parentThreadId),
        eq(events.type, "client/turn/requested"),
      ),
    )
    .all()
    .filter((row) => {
      const data = turnRequestEventDataSchema.parse(JSON.parse(row.data));
      return data.initiator === "system";
    }).length;
}

describe("durable parent child-outcome notifications", () => {
  it("holds the announcement while the parent is blocked on an interaction, then delivers it", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-blocked-parent");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });

      // The orchestrator is sitting on an unanswered permission prompt: the
      // exact case that used to drop the child's completion permanently.
      const blocked = vi
        .spyOn(harness.deps.pendingInteractions, "hasPendingThreadInteraction")
        .mockReturnValue(true);

      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnStatus: "completed",
      });

      await deliverDueParentNotifications(harness.deps, Date.now() + 10_000);

      expect(countParentSystemMessages(harness, fixture.parentThreadId)).toBe(0);
      // Retained, not dropped.
      expect(
        countPendingParentNotifications(harness.db, fixture.parentThreadId),
      ).toBe(1);
      // The human is told immediately even though the agent could not be.
      const inbox = listNotifications(harness.db, {
        threadId: fixture.parentThreadId,
      });
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.category).toBe("worker-finished");

      // The user answers the prompt; the next sweep delivers.
      blocked.mockReturnValue(false);
      await deliverDueParentNotifications(harness.deps, Date.now() + 20_000);

      expect(countParentSystemMessages(harness, fixture.parentThreadId)).toBe(1);
      expect(
        countPendingParentNotifications(harness.db, fixture.parentThreadId),
      ).toBe(0);
      // Still exactly one inbox row: redelivery must not double-post.
      expect(
        listNotifications(harness.db, { threadId: fixture.parentThreadId }),
      ).toHaveLength(1);
    });
  });

  it("delivers a notification whose in-process flush timer never ran", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-restart-parent");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });

      // Simulates a server restart inside the coalescing window: the row is on
      // disk, the timer that would have flushed it is gone.
      const timers = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((() => ({ unref() {} })) as never);
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnStatus: "completed",
      });
      timers.mockRestore();

      expect(countParentSystemMessages(harness, fixture.parentThreadId)).toBe(0);

      await deliverDueParentNotifications(harness.deps, Date.now() + 10_000);

      expect(countParentSystemMessages(harness, fixture.parentThreadId)).toBe(1);
      expect(
        countPendingParentNotifications(harness.db, fixture.parentThreadId),
      ).toBe(0);
    });
  });

  it("discards the announcement when the parent thread is archived", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedParentFixture(harness, "host-archived-parent");
      const child = seedThread(harness.deps, {
        projectId: fixture.projectId,
        title: "Worker",
        parentThreadId: fixture.parentThreadId,
      });

      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: fixture.parentThreadId,
        turnStatus: "completed",
      });
      harness.deps.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, fixture.parentThreadId))
        .run();

      await deliverDueParentNotifications(harness.deps, Date.now() + 10_000);

      // Undeliverable is terminal: the row is discharged rather than retried
      // forever, but the human still got told.
      expect(
        countPendingParentNotifications(harness.db, fixture.parentThreadId),
      ).toBe(0);
      expect(
        listNotifications(harness.db, { threadId: fixture.parentThreadId }),
      ).toHaveLength(1);
    });
  });
});
