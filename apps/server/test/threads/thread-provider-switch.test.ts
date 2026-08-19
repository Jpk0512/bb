import { archiveThread, getThread, listEvents } from "@bb/db";
import { describe, expect, it } from "vitest";
import { switchThreadProvider } from "../../src/services/threads/thread-provider-switch.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import {
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

/**
 * A thread on a host with NO live daemon session. The release of the old
 * provider session is a no-op against an unreachable host — it holds no
 * runtime to release — which is exactly the case `runAwaitedThreadStopCommand`
 * swallows by design, so the switch proceeds without a daemon in the loop.
 */
function seedSwitchableThread(harness: TestAppHarness, value: number) {
  const host = seedHost(harness.deps, { id: `host-switch-${value}` });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/switch-${value}`,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/switch-${value}`,
    status: "ready",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `codex-session-${value}`,
    threadId: thread.id,
  });
  return { environment, project, thread };
}

/** The same fixture with a live daemon session, for the release round trip. */
function seedConnectedSwitchableThread(harness: TestAppHarness, value: number) {
  const { host } = seedHostSession(harness.deps, {
    id: `host-switch-${value}`,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/switch-${value}`,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/switch-${value}`,
    status: "ready",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `codex-session-${value}`,
    threadId: thread.id,
  });
  return { environment, project, thread };
}

describe("switchThreadProvider", () => {
  it("rebinds the thread in place and keeps its id and event history", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedSwitchableThread(harness, 1);
      const eventsBefore = listEvents(harness.db, { threadId: thread.id }).length;
      expect(eventsBefore).toBeGreaterThan(0);

      const updated = await switchThreadProvider(harness.deps, {
        thread,
        providerId: "claude-code",
      });

      // Same thread. This is the whole point: nothing was spawned.
      expect(updated.id).toBe(thread.id);
      expect(updated.providerId).toBe("claude-code");
      expect(updated.providerGeneration).toBe(1);
      expect(updated.archivedAt).toBeNull();
      expect(updated.visibility).toBe("visible");
      expect(updated.supersededByThreadId).toBeNull();

      // The timeline is intact and gained exactly one durable marker.
      const events = listEvents(harness.db, { threadId: thread.id });
      expect(events).toHaveLength(eventsBefore + 1);
      const marker = events.at(-1);
      expect(marker?.type).toBe("system/operation");
      expect(JSON.parse(marker?.data ?? "{}")).toMatchObject({
        operation: "provider_change",
        status: "completed",
        metadata: {
          previousProviderId: "codex",
          nextProviderId: "claude-code",
          generation: 1,
        },
      });
    });
  });

  it("cold-starts the next turn on the new provider instead of resuming the retired session", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedConnectedSwitchableThread(harness, 2);

      const switching = switchThreadProvider(harness.deps, {
        thread,
        providerId: "claude-code",
      });
      // The release is awaited: the old provider session is let go before the
      // rebind lands, so the daemon has to answer before the switch resolves.
      const stop = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.stop" &&
          "threadId" in queued.command &&
          queued.command.threadId === thread.id,
      );
      expect(stop.command).toMatchObject({ intent: "release" });
      // The rebind has NOT happened yet — release strictly precedes the write.
      expect(getThread(harness.db, thread.id)?.providerId).toBe("codex");
      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });
      await switching;

      const rebound = getThread(harness.db, thread.id);
      if (!rebound) throw new Error("thread vanished");
      expect(rebound.providerId).toBe("claude-code");

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: textInput("first turn on the new provider"),
          mode: "start",
        },
        thread: rebound,
        trigger: "user",
      });

      // The payoff. Before the generation boundary this dispatched
      // `turn.submit` against codex's session id.
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          "threadId" in queued.command &&
          queued.command.threadId === thread.id,
      );
      const starts = listQueuedThreadCommands(
        harness,
        "thread.start",
        thread.id,
      );
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(0);
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        providerId: "claude-code",
        threadId: thread.id,
      });
    });
  });

  it("keeps resuming a thread that never switched", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedConnectedSwitchableThread(harness, 3);

      await sendThreadMessage(harness.deps, {
        environment,
        payload: { input: textInput("next turn"), mode: "start" },
        thread,
        trigger: "user",
      });

      // The mirror image: generation 0 is every pre-existing thread, and its
      // dispatch must be unchanged.
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "turn.submit" &&
          "threadId" in queued.command &&
          queued.command.threadId === thread.id,
      );
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toHaveLength(0);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(1);
    });
  });

  it("leaves the thread on its old provider when the release fails", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedConnectedSwitchableThread(harness, 9);

      // Attach the rejection handler before awaiting anything else: the
      // release rejects as soon as the daemon reports the error.
      const settled = switchThreadProvider(harness.deps, {
        thread,
        providerId: "claude-code",
      }).then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      const stop = await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.stop" &&
          "threadId" in queued.command &&
          queued.command.threadId === thread.id,
      );
      await reportQueuedCommandError(harness, stop, {
        errorCode: "internal_error",
        errorMessage: "release failed",
      });

      expect(await settled).not.toBe("resolved");
      // A thread whose old session could not be released must not be rebound:
      // a turn could still land on the provider that still holds it.
      const after = getThread(harness.db, thread.id);
      expect(after?.providerId).toBe("codex");
      expect(after?.providerGeneration).toBe(0);
    });
  });

  it("refuses a switch to the provider the thread already runs on", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedSwitchableThread(harness, 4);
      await expect(
        switchThreadProvider(harness.deps, { thread, providerId: "codex" }),
      ).rejects.toMatchObject({ status: 400 });
      expect(getThread(harness.db, thread.id)?.providerGeneration).toBe(0);
    });
  });

  it("refuses a switch on an archived thread", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedSwitchableThread(harness, 5);
      archiveThread(harness.db, harness.hub, thread.id);
      const archived = getThread(harness.db, thread.id);
      if (!archived) throw new Error("thread vanished");

      await expect(
        switchThreadProvider(harness.deps, {
          thread: archived,
          providerId: "claude-code",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(getThread(harness.db, thread.id)?.providerId).toBe("codex");
    });
  });

  it("refuses a target provider with no registered bridge before touching state", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedSwitchableThread(harness, 6);
      await expect(
        switchThreadProvider(harness.deps, {
          thread,
          providerId: "not-a-provider",
        }),
      ).rejects.toMatchObject({ status: 409 });

      // Nothing moved: no generation bump, no marker event, no rebind.
      const after = getThread(harness.db, thread.id);
      expect(after?.providerId).toBe("codex");
      expect(after?.providerGeneration).toBe(0);
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) => event.type === "system/operation",
        ),
      ).toHaveLength(0);
    });
  });

  it("validates the model against the TARGET provider's catalog", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedSwitchableThread(harness, 7);
      await expect(
        switchThreadProvider(harness.deps, {
          thread,
          providerId: "claude-code",
          model: "definitely-not-a-claude-model",
        }),
      ).rejects.toMatchObject({ status: expect.any(Number) });
      expect(getThread(harness.db, thread.id)?.providerId).toBe("codex");
    });
  });

  it("replaces the execution override that named the retired provider's catalog", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedSwitchableThread(harness, 8);
      harness.db
        .$client!.prepare(
          "UPDATE threads SET model_override = ?, reasoning_level_override = ? WHERE id = ?",
        )
        .run("gpt-5", "high", thread.id);
      expect(getThread(harness.db, thread.id)?.modelOverride).toBe("gpt-5");

      await switchThreadProvider(harness.deps, {
        thread,
        providerId: "claude-code",
      });

      const after = getThread(harness.db, thread.id);
      expect(after?.modelOverride).toBeNull();
      expect(after?.reasoningLevelOverride).toBeNull();
    });
  });
});
