import { describe, expect, it } from "vitest";
import { NotificationHub } from "../../src/ws/hub.js";
import {
  PluginRealtimeCoordinator,
  isValidPluginRealtimeChannelName,
} from "../../src/ws/plugin-realtime.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

const TASKS_TASK_CHANNEL = {
  channel: "task",
  label: "Task changes",
  scoped: true,
} as const;

function createCoordinator() {
  const hub = new NotificationHub();
  return { hub, coordinator: new PluginRealtimeCoordinator({ hub }) };
}

function boardWatchingTasks(scope: string | null = null) {
  return {
    kind: "plugin-channel",
    pluginId: "tasks",
    channel: "task",
    scope,
    as: "board",
  } as const;
}

describe("PluginRealtimeCoordinator authorization", () => {
  it("allows a plugin its own channel with no declaration", () => {
    const { hub, coordinator } = createCoordinator();
    const socket = createMockHubSocket();

    // Back-compat for every plugin that used useRealtime before BBF-4:
    // recall, telemetry, dispatch and board all subscribe to themselves and
    // must keep working unrebuilt and undeclared.
    expect(
      coordinator.subscribe(socket, {
        kind: "plugin-channel",
        pluginId: "recall",
        channel: "recall",
        scope: null,
        as: "recall",
      }),
    ).toBe(true);

    expect(hub.notifyPluginSignal("recall", "recall", { n: 1 })).toBe(1);
  });

  it("treats an absent `as` as the publisher's own subscription", () => {
    const { hub, coordinator } = createCoordinator();
    const socket = createMockHubSocket();

    coordinator.subscribe(socket, {
      kind: "plugin-channel",
      pluginId: "recall",
      channel: "recall",
      scope: null,
    });

    expect(hub.notifyPluginSignal("recall", "recall", { n: 1 })).toBe(1);
  });

  it("withholds an undeclared foreign channel and grants it on declare", () => {
    const { hub, coordinator } = createCoordinator();
    const socket = createMockHubSocket();

    coordinator.subscribe(socket, boardWatchingTasks());
    expect(coordinator.isSubscribable(boardWatchingTasks())).toBe(false);
    expect(hub.notifyPluginSignal("tasks", "task", { n: 1 })).toBe(0);

    coordinator.replaceDeclarationsForOwner("tasks", [TASKS_TASK_CHANNEL]);

    expect(coordinator.isSubscribable(boardWatchingTasks())).toBe(true);
    expect(hub.notifyPluginSignal("tasks", "task", { n: 1 })).toBe(1);
  });

  it("does not grant a declared publisher's OTHER channels", () => {
    const { hub, coordinator } = createCoordinator();
    const socket = createMockHubSocket();

    coordinator.replaceDeclarationsForOwner("tasks", [TASKS_TASK_CHANNEL]);
    coordinator.subscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "internal-sync",
      scope: null,
      as: "board",
    });

    expect(hub.notifyPluginSignal("tasks", "internal-sync", {})).toBe(0);
  });
});

describe("PluginRealtimeCoordinator publisher lifecycle", () => {
  it("revokes on disable and restores on reload with no client action", () => {
    const { hub, coordinator } = createCoordinator();
    const socket = createMockHubSocket();

    coordinator.replaceDeclarationsForOwner("tasks", [TASKS_TASK_CHANNEL]);
    coordinator.subscribe(socket, boardWatchingTasks("task_1"));
    expect(
      hub.notifyPluginSignal("tasks", "task", {}, { scope: "task_1" }),
    ).toBe(1);

    // Publisher disabled / disposed / crashed.
    coordinator.clearDeclarationsForOwner("tasks");
    expect(
      hub.notifyPluginSignal("tasks", "task", {}, { scope: "task_1" }),
    ).toBe(0);

    // Reload re-declares. The subscriber panel is still mounted and its effect
    // has already run, so nothing on the client would re-subscribe; the
    // coordinator has to restore this itself or the panel stays dead forever.
    coordinator.replaceDeclarationsForOwner("tasks", [TASKS_TASK_CHANNEL]);
    expect(
      hub.notifyPluginSignal("tasks", "task", {}, { scope: "task_1" }),
    ).toBe(1);
  });

  it("revokes a channel dropped from a narrowed declaration set", () => {
    const { hub, coordinator } = createCoordinator();
    const socket = createMockHubSocket();

    coordinator.replaceDeclarationsForOwner("tasks", [
      TASKS_TASK_CHANNEL,
      { channel: "board", label: "Board layout", scoped: false },
    ]);
    coordinator.subscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "board",
      scope: null,
      as: "board",
    });
    expect(hub.notifyPluginSignal("tasks", "board", {})).toBe(1);

    // A newer version of the publisher stops supporting "board".
    coordinator.replaceDeclarationsForOwner("tasks", [TASKS_TASK_CHANNEL]);
    expect(hub.notifyPluginSignal("tasks", "board", {})).toBe(0);
  });

  it("never revokes the publisher's own subscription", () => {
    const { hub, coordinator } = createCoordinator();
    const socket = createMockHubSocket();

    coordinator.replaceDeclarationsForOwner("tasks", [TASKS_TASK_CHANNEL]);
    coordinator.subscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "task",
      scope: null,
      as: "tasks",
    });

    coordinator.clearDeclarationsForOwner("tasks");

    expect(hub.notifyPluginSignal("tasks", "task", {})).toBe(1);
  });

  it("keeps the shared entry alive for the owner when a foreign subscriber is denied first", () => {
    const { hub, coordinator } = createCoordinator();
    const socket = createMockHubSocket();

    // Mount order must not decide who gets fed. `as` is excluded from the
    // subscription key, so both of these collapse to one hub entry; the
    // coordinator grants it because at least one claim is permitted.
    coordinator.subscribe(socket, boardWatchingTasks());
    coordinator.subscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "task",
      scope: null,
      as: "tasks",
    });

    expect(hub.notifyPluginSignal("tasks", "task", {})).toBe(1);

    // The publisher's own panel unmounts; the still-denied board must not keep
    // the entry alive.
    coordinator.unsubscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "task",
      scope: null,
      as: "tasks",
    });

    expect(hub.notifyPluginSignal("tasks", "task", {})).toBe(0);
  });
});

describe("PluginRealtimeCoordinator bookkeeping", () => {
  it("returns false for non-plugin-channel targets so the hub handles them", () => {
    const { coordinator } = createCoordinator();
    const socket = createMockHubSocket();

    expect(
      coordinator.subscribe(socket, { kind: "thread-detail", threadId: "t" }),
    ).toBe(false);
    expect(
      coordinator.unsubscribe(socket, { kind: "thread-list" }),
    ).toBe(false);
    expect(coordinator.isSubscribable({ kind: "thread-list" })).toBe(true);
  });

  it("drops every record for a released socket", () => {
    const { hub, coordinator } = createCoordinator();
    const socket = createMockHubSocket();

    coordinator.replaceDeclarationsForOwner("tasks", [TASKS_TASK_CHANNEL]);
    coordinator.subscribe(socket, boardWatchingTasks("task_1"));

    coordinator.releaseSocket(socket);
    hub.unregisterClient(socket);

    // Re-declaring must not resurrect a closed socket's subscription.
    coordinator.clearDeclarationsForOwner("tasks");
    coordinator.replaceDeclarationsForOwner("tasks", [TASKS_TASK_CHANNEL]);

    expect(
      hub.notifyPluginSignal("tasks", "task", {}, { scope: "task_1" }),
    ).toBe(0);
    expect(socket.messages).toHaveLength(0);
  });

  it("unsubscribes hub state even for a target it never recorded", () => {
    const { hub, coordinator } = createCoordinator();
    const socket = createMockHubSocket();

    // Subscribed straight through the hub (a pre-BBF-4 path or a replayed
    // frame the coordinator missed): an unsubscribe must still clear it.
    hub.subscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "task",
      scope: null,
    });
    coordinator.unsubscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "task",
      scope: null,
      as: "tasks",
    });

    expect(hub.notifyPluginSignal("tasks", "task", {})).toBe(0);
  });

  it("lists declared channels per publisher and across publishers", () => {
    const { coordinator } = createCoordinator();

    coordinator.replaceDeclarationsForOwner("telemetry", [
      { channel: "turn", label: "Turn activity", scoped: true },
    ]);
    coordinator.replaceDeclarationsForOwner("tasks", [TASKS_TASK_CHANNEL]);

    expect(coordinator.listChannelContributions()).toEqual([
      { pluginId: "tasks", channel: "task", label: "Task changes", scoped: true },
      {
        pluginId: "telemetry",
        channel: "turn",
        label: "Turn activity",
        scoped: true,
      },
    ]);
    expect(coordinator.listChannelsForPlugin("telemetry")).toEqual([
      { channel: "turn", label: "Turn activity", scoped: true },
    ]);
    expect(coordinator.listChannelsForPlugin("nope")).toEqual([]);

    coordinator.clearDeclarationsForOwner("tasks");
    expect(coordinator.listChannelContributions()).toHaveLength(1);
  });

  it("rejects channel names that would not survive a subscription key", () => {
    expect(isValidPluginRealtimeChannelName("task")).toBe(true);
    expect(isValidPluginRealtimeChannelName("turn.completed")).toBe(true);
    expect(isValidPluginRealtimeChannelName("")).toBe(false);
    expect(isValidPluginRealtimeChannelName("has space")).toBe(false);
    expect(isValidPluginRealtimeChannelName("#leading")).toBe(false);
    expect(isValidPluginRealtimeChannelName("a".repeat(65))).toBe(false);
  });
});
