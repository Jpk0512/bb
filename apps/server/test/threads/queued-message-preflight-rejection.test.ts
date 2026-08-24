import {
  getQueuedThreadMessage,
  listEvents,
  listQueuedThreadMessages,
  updateQueuedThreadMessage,
} from "@bb/db";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "@bb/domain";
import { setPluginAgentContributions } from "../../src/services/plugins/plugin-agent-contributions.js";
import {
  runQueuedMessageAutoSendSweep,
  sendQueuedMessage,
} from "../../src/services/threads/queued-messages.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

/** Ready environment + warm idle thread, so the drain takes the idle-provider
 * fast path where a plugin preflight rejection is observed. */
function seedWarmIdleThread(harness: TestAppHarness, value: number): Thread {
  const { host } = seedHostSession(harness.deps, {
    id: `host-preflight-reject-${value}`,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/preflight-reject-${value}`,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/preflight-reject-${value}`,
    status: "ready",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-preflight-reject-${value}`,
    threadId: thread.id,
  });
  return thread;
}

function installRejectingPreflight(
  codeForCall: (calls: number) => string = () => "not-now",
): { calls: () => number } {
  let calls = 0;
  setPluginAgentContributions({
    runTurnPreflight() {
      calls += 1;
      return Promise.resolve({
        timedOut: false,
        decisions: [
          {
            pluginId: "gatekeeper",
            decision: {
              kind: "reject",
              code: codeForCall(calls),
              message: "Gatekeeper rejected the turn",
            },
          },
        ],
      });
    },
  });
  return { calls: () => calls };
}

function listRejectionEvents(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (event) => event.type === "client/turn/rejected",
  );
}

afterEach(() => {
  setPluginAgentContributions(undefined);
});

describe("queued message auto-send under a persistent plugin rejection", () => {
  it("stops re-attempting after its budget and appends one event per outcome", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedWarmIdleThread(harness, 1);
      const queued = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("blocked by the gatekeeper"),
      });
      const preflight = installRejectingPreflight();

      for (let tick = 0; tick < 6; tick += 1) {
        await runQueuedMessageAutoSendSweep(harness.deps);
      }

      // Without a budget every sweep tick re-claims the same message, runs
      // preflight again, and appends another durable rejection.
      expect(preflight.calls()).toBe(3);
      const rejections = listRejectionEvents(harness, thread.id);
      expect(rejections).toHaveLength(2);
      expect(JSON.parse(rejections[0]!.data)).toMatchObject({
        reason: "plugin:gatekeeper:not-now",
        message: "Gatekeeper rejected the turn",
      });
      expect(JSON.parse(rejections[1]!.data)).toMatchObject({
        reason: "plugin:gatekeeper:not-now",
        message: expect.stringContaining("Automatic sending stopped"),
      });

      // The message stays queued and unclaimed: the user can still edit or
      // send it, and nothing was dispatched to the host.
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map(
          (queuedMessage) => queuedMessage.id,
        ),
      ).toEqual([queued.id]);
      expect(getQueuedThreadMessage(harness.db, queued.id)).toMatchObject({
        claimedAt: null,
        claimToken: null,
      });
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(0);
    });
  });

  it("grants a fresh budget once the queued message is edited", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedWarmIdleThread(harness, 2);
      const queued = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("blocked by the gatekeeper"),
      });
      const preflight = installRejectingPreflight();

      for (let tick = 0; tick < 4; tick += 1) {
        await runQueuedMessageAutoSendSweep(harness.deps);
      }
      expect(preflight.calls()).toBe(3);

      const before = getQueuedThreadMessage(harness.db, queued.id);
      expect(before).not.toBeNull();
      expect(
        updateQueuedThreadMessage(harness.db, harness.hub, {
          content: textInput("edited so the gatekeeper can admit it"),
          expectedUpdatedAt: before!.updatedAt,
          id: queued.id,
          threadId: thread.id,
        }).kind,
      ).toBe("updated");

      await runQueuedMessageAutoSendSweep(harness.deps);
      expect(preflight.calls()).toBe(4);
    });
  });

  it("spends the budget even when the rejection code changes between attempts", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedWarmIdleThread(harness, 4);
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("blocked by the gatekeeper"),
      });
      // A budget keyed on the rejection reason would be reset by every code
      // change, leaving the sweep re-claiming this message forever.
      const preflight = installRejectingPreflight(
        (calls) => `not-now-${calls % 2}`,
      );

      for (let tick = 0; tick < 8; tick += 1) {
        await runQueuedMessageAutoSendSweep(harness.deps);
      }

      expect(preflight.calls()).toBe(3);
    });
  });

  it("keeps a user-initiated send's rejection durable after the drain recorded one", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedWarmIdleThread(harness, 3);
      const queued = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("blocked by the gatekeeper"),
      });
      const preflight = installRejectingPreflight();

      await runQueuedMessageAutoSendSweep(harness.deps);
      expect(preflight.calls()).toBe(1);
      expect(listRejectionEvents(harness, thread.id)).toHaveLength(1);

      // "Send now" reaches the same idle-provider fast path with mode "auto".
      // Nothing else records its outcome, so the drain's event-dedup must not
      // swallow it.
      await expect(
        sendQueuedMessage(harness.deps, {
          mode: "auto",
          queuedMessageId: queued.id,
          threadId: thread.id,
        }),
      ).rejects.toThrow("Gatekeeper rejected the turn");
      expect(preflight.calls()).toBe(2);
      const rejections = listRejectionEvents(harness, thread.id);
      expect(rejections).toHaveLength(2);
      expect(JSON.parse(rejections[1]!.data)).toMatchObject({
        reason: "plugin:gatekeeper:not-now",
        message: "Gatekeeper rejected the turn",
      });
      // The manual attempt is not charged to the drain's budget.
      expect(getQueuedThreadMessage(harness.db, queued.id)).toMatchObject({
        claimedAt: null,
        claimToken: null,
      });
      await runQueuedMessageAutoSendSweep(harness.deps);
      expect(preflight.calls()).toBe(3);
    });
  });
});
