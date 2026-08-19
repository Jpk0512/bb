import { describe, expect, it, vi } from "vitest";
import {
  onClientSocketMessage,
  onClientSocketOpen,
} from "../../src/ws/client-protocol.js";
import { NotificationHub } from "../../src/ws/hub.js";
import { PluginRealtimeCoordinator } from "../../src/ws/plugin-realtime.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

function createProtocolDeps(hub: NotificationHub) {
  return {
    hub,
    watchInterests: {
      releaseSocket: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    },
    // The real coordinator, not a stub: the interesting behaviour here is that
    // it OWNS plugin-channel targets and calls the hub itself.
    pluginRealtime: new PluginRealtimeCoordinator({ hub }),
  };
}

describe("client websocket protocol", () => {
  it("subscribes valid client messages parsed through the shared schema", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
        target: { kind: "thread-detail", threadId: "thread-1" },
      }),
    );
    hub.notifyThread("thread-1", ["events-appended"]);

    expect(socket.closed).toHaveLength(0);
    expect(socket.messages).toHaveLength(1);
    expect(JSON.parse(socket.messages[0])).toMatchObject({
      type: "changed",
      entity: "thread",
      id: "thread-1",
      changes: ["events-appended"],
    });
  });

  it("rejects subscribe messages whose target id is not a string", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
        target: { kind: "thread-detail", threadId: 123 },
      }),
    );
    hub.notifyThread("thread-1", ["events-appended"]);

    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
    expect(socket.messages).toHaveLength(0);
  });

  it("removes subscriptions after unsubscribe messages", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
        target: { kind: "thread-detail", threadId: "thread-1" },
      }),
    );
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "unsubscribe",
        target: { kind: "thread-detail", threadId: "thread-1" },
      }),
    );
    hub.notifyThread("thread-1", ["events-appended"]);

    expect(socket.closed).toHaveLength(0);
    expect(socket.messages).toHaveLength(0);
  });

  it("rejects subscribe messages for unknown targets", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
        target: { kind: "bogus" },
      }),
    );

    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
    expect(socket.messages).toHaveLength(0);
  });

  it("rejects client messages with missing required fields", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
      }),
    );

    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
    expect(socket.messages).toHaveLength(0);
  });

  it("closes the socket instead of throwing on malformed JSON", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);

    expect(() => onClientSocketMessage(deps, socket, "{")).not.toThrow();
    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
  });

  it("updates watch interests from subscribe and unsubscribe messages", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
        target: { kind: "environment-detail", environmentId: "env-1" },
      }),
    );
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "unsubscribe",
        target: { kind: "environment-detail", environmentId: "env-1" },
      }),
    );

    expect(deps.watchInterests.subscribe).toHaveBeenCalledWith(socket, {
      kind: "environment-detail",
      environmentId: "env-1",
    });
    expect(deps.watchInterests.unsubscribe).toHaveBeenCalledWith(socket, {
      kind: "environment-detail",
      environmentId: "env-1",
    });
  });

  it("rejects direct watch messages", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "watch.acquire",
        target: {
          kind: "environment-workspace",
          environmentId: "env-1",
        },
      }),
    );

    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
    expect(deps.watchInterests.subscribe).not.toHaveBeenCalled();
  });

  // BBF-4. An unauthorized plugin-channel subscribe must be ignored, never
  // fatal: one plugin's bad subscribe would otherwise kill the shared
  // connection the whole window (and every other plugin panel) depends on.
  it("ignores an undeclared cross-plugin subscribe without closing the socket", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
        target: {
          kind: "plugin-channel",
          pluginId: "tasks",
          channel: "task",
          scope: null,
          as: "board",
        },
      }),
    );
    hub.notifyPluginSignal("tasks", "task", { id: "task_1" });

    expect(socket.closed).toHaveLength(0);
    expect(socket.messages).toHaveLength(0);

    // …and the request is remembered, so the publisher declaring later starts
    // delivery with no client action.
    deps.pluginRealtime.replaceDeclarationsForOwner("tasks", [
      { channel: "task", label: "Task changes", scoped: true },
    ]);
    hub.notifyPluginSignal("tasks", "task", { id: "task_1" });

    expect(socket.messages).toHaveLength(1);
  });

  it("routes a plugin's own channel subscribe to the hub with no declaration", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
        target: {
          kind: "plugin-channel",
          pluginId: "recall",
          channel: "recall",
          scope: null,
          as: "recall",
        },
      }),
    );
    hub.notifyPluginSignal("recall", "recall", { reason: "saved" });

    expect(socket.messages).toHaveLength(1);

    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "unsubscribe",
        target: {
          kind: "plugin-channel",
          pluginId: "recall",
          channel: "recall",
          scope: null,
          as: "recall",
        },
      }),
    );
    hub.notifyPluginSignal("recall", "recall", { reason: "saved" });

    expect(socket.messages).toHaveLength(1);
  });
});
