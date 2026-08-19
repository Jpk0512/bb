import { describe, expect, it, vi } from "vitest";
import { WebSocketManager } from "./ws";

describe("WebSocketManager plugin-signal routing", () => {
  it("dispatches plugin-signal messages to onPluginSignal subscribers", () => {
    const manager = new WebSocketManager();
    const received = vi.fn();
    manager.onPluginSignal(received);

    manager.handleIncomingMessage(
      JSON.stringify({
        type: "plugin-signal",
        pluginId: "linear",
        channel: "issues",
        payload: { count: 2 },
      }),
    );

    expect(received).toHaveBeenCalledWith({
      type: "plugin-signal",
      pluginId: "linear",
      channel: "issues",
      scope: null,
      payload: { count: 2 },
    });
  });

  it("carries the scope of a scoped publish through to subscribers", () => {
    const manager = new WebSocketManager();
    const received = vi.fn();
    manager.onPluginSignal(received);

    manager.handleIncomingMessage(
      JSON.stringify({
        type: "plugin-signal",
        pluginId: "telemetry",
        channel: "turn",
        scope: "thr_1",
        payload: { reason: "completed" },
      }),
    );

    expect(received.mock.calls[0]?.[0]).toMatchObject({ scope: "thr_1" });
  });

  it("defaults a pre-BBF-4 server's scope-less signal to null instead of dropping it", () => {
    // Skew rule: an older server sends no `scope` field at all. Dropping those
    // frames would leave every plugin panel dead against an older server.
    const manager = new WebSocketManager();
    const received = vi.fn();
    manager.onPluginSignal(received);

    manager.handleIncomingMessage(
      JSON.stringify({
        type: "plugin-signal",
        pluginId: "linear",
        channel: "issues",
        payload: null,
      }),
    );

    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0]?.[0]).toMatchObject({ scope: null });
  });

  it("strips unknown fields from a newer server instead of dropping", () => {
    const manager = new WebSocketManager();
    const received = vi.fn();
    manager.onPluginSignal(received);

    manager.handleIncomingMessage(
      JSON.stringify({
        type: "plugin-signal",
        pluginId: "linear",
        channel: "issues",
        payload: null,
        futureField: "ignored",
      }),
    );

    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0]?.[0]).not.toHaveProperty("futureField");
  });

  it("does not misroute other message types to plugin subscribers", () => {
    const manager = new WebSocketManager();
    const pluginSignals = vi.fn();
    const changed = vi.fn();
    manager.onPluginSignal(pluginSignals);
    manager.onChanged(changed);

    manager.handleIncomingMessage(
      JSON.stringify({
        type: "changed",
        entity: "system",
        changes: ["plugins-changed"],
      }),
    );

    expect(pluginSignals).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
