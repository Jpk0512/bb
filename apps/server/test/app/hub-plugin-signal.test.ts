import { describe, expect, it } from "vitest";
import { NotificationHub } from "../../src/ws/hub.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

/**
 * BBF-4 inverted the contract this file used to pin. It previously asserted
 * that a plugin signal "reaches every client regardless of what they
 * subscribed to". That is now the bug, not the behaviour: broadcasting sent
 * every plugin's every payload across a `bb connect` tunnel to every client,
 * where a host-owned `if` in useRealtime threw it away. Treat the inversion as
 * the intended change, not a weakened test.
 */
describe("NotificationHub.notifyPluginSignal", () => {
  it("delivers only to sockets subscribed to that publisher channel", () => {
    const hub = new NotificationHub();
    const subscriber = createMockHubSocket();
    const bystander = createMockHubSocket();
    hub.subscribe(subscriber, {
      kind: "plugin-channel",
      pluginId: "linear",
      channel: "issues-updated",
      scope: null,
    });
    // Subscribed to something else entirely: it must hear nothing.
    hub.subscribe(bystander, { kind: "thread-detail", threadId: "thr_1" });

    const delivered = hub.notifyPluginSignal("linear", "issues-updated", {
      count: 42,
    });

    expect(delivered).toBe(1);
    expect(bystander.messages).toHaveLength(0);
    expect(subscriber.messages).toHaveLength(1);
    expect(JSON.parse(subscriber.messages[0])).toEqual({
      type: "plugin-signal",
      pluginId: "linear",
      channel: "issues-updated",
      scope: null,
      payload: { count: 42 },
    });
  });

  it("does not leak one publisher's channel to another publisher's subscriber", () => {
    const hub = new NotificationHub();
    const socket = createMockHubSocket();
    hub.subscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "task",
      scope: null,
    });

    expect(
      hub.notifyPluginSignal("telemetry", "task", { id: "x" }),
    ).toBe(0);
    expect(hub.notifyPluginSignal("tasks", "other", { id: "x" })).toBe(0);
    expect(socket.messages).toHaveLength(0);
  });

  it("gives a channel-wide subscriber both scoped and unscoped publishes", () => {
    const hub = new NotificationHub();
    const socket = createMockHubSocket();
    hub.subscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "task",
      scope: null,
    });

    hub.notifyPluginSignal("tasks", "task", { id: "task_1" }, {
      scope: "task_1",
    });
    hub.notifyPluginSignal("tasks", "task", { id: null });

    expect(socket.messages.map((raw) => JSON.parse(raw).scope)).toEqual([
      "task_1",
      null,
    ]);
  });

  it("gives a scoped subscriber only its own scope", () => {
    const hub = new NotificationHub();
    const socket = createMockHubSocket();
    hub.subscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "task",
      scope: "task_1",
    });

    // This is the board's stated regression: an edit to an unrelated entity
    // must not reach a panel that asked for specific ids.
    hub.notifyPluginSignal("tasks", "task", { id: "task_2" }, {
      scope: "task_2",
    });
    expect(socket.messages).toHaveLength(0);

    hub.notifyPluginSignal("tasks", "task", { id: "task_1" }, {
      scope: "task_1",
    });
    expect(socket.messages).toHaveLength(1);

    // The channel-wide stream is a separate subscription, not an implied one.
    hub.notifyPluginSignal("tasks", "task", { id: null });
    expect(socket.messages).toHaveLength(1);
  });

  it("sends one frame to a socket subscribed both channel-wide and scoped", () => {
    const hub = new NotificationHub();
    const socket = createMockHubSocket();
    hub.subscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "task",
      scope: null,
    });
    hub.subscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "task",
      scope: "task_1",
    });

    const delivered = hub.notifyPluginSignal(
      "tasks",
      "task",
      { id: "task_1" },
      { scope: "task_1" },
    );

    expect(delivered).toBe(1);
    expect(socket.messages).toHaveLength(1);
  });

  it("counts each recipient socket once and drops closed clients", () => {
    const hub = new NotificationHub();
    const first = createMockHubSocket();
    const second = createMockHubSocket();
    for (const socket of [first, second]) {
      hub.subscribe(socket, {
        kind: "plugin-channel",
        pluginId: "tasks",
        channel: "task",
        scope: null,
      });
    }

    expect(hub.notifyPluginSignal("tasks", "task", { id: "a" })).toBe(2);

    hub.unregisterClient(second);

    expect(hub.notifyPluginSignal("tasks", "task", { id: "b" })).toBe(1);
    expect(second.messages).toHaveLength(1);
  });

  it("ignores an unsubscribe for a scope the socket never held", () => {
    const hub = new NotificationHub();
    const socket = createMockHubSocket();
    hub.subscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "task",
      scope: "task_1",
    });
    hub.unsubscribe(socket, {
      kind: "plugin-channel",
      pluginId: "tasks",
      channel: "task",
      scope: "task_2",
    });

    expect(
      hub.notifyPluginSignal("tasks", "task", { id: "task_1" }, {
        scope: "task_1",
      }),
    ).toBe(1);
  });
});
