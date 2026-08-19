// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSignal, RealtimeSubscriptionTarget } from "@bb/server-contract";
import { PluginContext } from "@/components/plugin/plugin-context";

const wsState = vi.hoisted(() => {
  const subscribes: RealtimeSubscriptionTarget[] = [];
  const unsubscribes: RealtimeSubscriptionTarget[] = [];
  const listeners = new Set<(signal: PluginSignal) => void>();
  return { subscribes, unsubscribes, listeners };
});

vi.mock("@/lib/ws", () => ({
  wsManager: {
    subscribe: (target: RealtimeSubscriptionTarget) =>
      void wsState.subscribes.push(target),
    unsubscribe: (target: RealtimeSubscriptionTarget) =>
      void wsState.unsubscribes.push(target),
    onPluginSignal: (callback: (signal: PluginSignal) => void) => {
      wsState.listeners.add(callback);
      return () => wsState.listeners.delete(callback);
    },
  },
}));

const contributionsState = vi.hoisted(() => ({
  data: undefined as
    | undefined
    | {
        mentionProviders: unknown[];
        realtimeChannels: {
          pluginId: string;
          channel: string;
          label: string;
          scoped: boolean;
        }[];
      },
}));

vi.mock("@/hooks/queries/plugin-contribution-queries", () => ({
  usePluginContributions: () => ({ data: contributionsState.data }),
}));

import { useRealtime } from "./plugin-sdk-hooks";

function emit(signal: Partial<PluginSignal> & { pluginId: string; channel: string }) {
  const full: PluginSignal = {
    type: "plugin-signal",
    scope: null,
    payload: null,
    ...signal,
  };
  for (const listener of [...wsState.listeners]) listener(full);
}

function Subscriber(props: {
  channel: string;
  handler: (payload: unknown, meta: { scope: string | null }) => void;
  options?: { pluginId?: string; ids?: readonly string[] | null };
  onState?: (state: { publisher: string }) => void;
}) {
  const state = useRealtime(props.channel, props.handler, props.options);
  props.onState?.(state);
  return null;
}

function renderSubscriber(
  props: Parameters<typeof Subscriber>[0],
  pluginId = "board",
) {
  return render(
    <PluginContext.Provider value={pluginId}>
      <Subscriber {...props} />
    </PluginContext.Provider>,
  );
}

beforeEach(() => {
  wsState.subscribes.length = 0;
  wsState.unsubscribes.length = 0;
  wsState.listeners.clear();
  contributionsState.data = undefined;
});
afterEach(cleanup);

describe("useRealtime back-compat (two-argument form)", () => {
  // Already-installed plugin bundles call useRealtime(channel, handler). They
  // pick up this implementation with no rebuild because `bb plugin build` shims
  // @get-bb/plugin-sdk/app to globalThis.__bbPluginRuntime — which is the only
  // reason flipping the hub to strict routing does not break them.
  it("subscribes to its own plugin's unscoped channel and delivers payloads", () => {
    const handler = vi.fn();
    renderSubscriber({ channel: "recall", handler }, "recall");

    expect(wsState.subscribes).toEqual([
      {
        kind: "plugin-channel",
        pluginId: "recall",
        channel: "recall",
        scope: null,
        as: "recall",
      },
    ]);

    emit({ pluginId: "recall", channel: "recall", payload: { n: 1 } });
    expect(handler).toHaveBeenCalledWith({ n: 1 }, {
      scope: null,
      pluginId: "recall",
    });
  });

  it("still receives a scoped publish on the channel-wide subscription", () => {
    const handler = vi.fn();
    renderSubscriber({ channel: "turn", handler }, "telemetry");

    emit({
      pluginId: "telemetry",
      channel: "turn",
      scope: "thr_1",
      payload: { reason: "done" },
    });

    expect(handler).toHaveBeenCalledWith({ reason: "done" }, {
      scope: "thr_1",
      pluginId: "telemetry",
    });
  });

  it("ignores other plugins' and other channels' signals", () => {
    const handler = vi.fn();
    renderSubscriber({ channel: "recall", handler }, "recall");

    emit({ pluginId: "tasks", channel: "recall" });
    emit({ pluginId: "recall", channel: "other" });

    expect(handler).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", () => {
    const view = renderSubscriber({ channel: "recall", handler: vi.fn() }, "recall");
    view.unmount();

    expect(wsState.unsubscribes).toEqual(wsState.subscribes);
    expect(wsState.listeners.size).toBe(0);
  });
});

describe("useRealtime cross-plugin and scoped subscriptions", () => {
  it("issues one subscribe per id, asserting the subscriber plugin", () => {
    renderSubscriber({
      channel: "task",
      handler: vi.fn(),
      options: { pluginId: "tasks", ids: ["task_1", "task_2"] },
    });

    expect(wsState.subscribes).toEqual([
      {
        kind: "plugin-channel",
        pluginId: "tasks",
        channel: "task",
        scope: "task_1",
        as: "board",
      },
      {
        kind: "plugin-channel",
        pluginId: "tasks",
        channel: "task",
        scope: "task_2",
        as: "board",
      },
    ]);
  });

  // The board's stated regression: it rebuilt on every unrelated change. A
  // signal for an id outside the subscribed set must not reach the handler even
  // when it arrives on this window's shared socket for another panel.
  it("drops a signal whose scope was not subscribed", () => {
    const handler = vi.fn();
    renderSubscriber({
      channel: "task",
      handler,
      options: { pluginId: "tasks", ids: ["task_1"] },
    });

    emit({ pluginId: "tasks", channel: "task", scope: "task_2" });
    expect(handler).not.toHaveBeenCalled();

    emit({ pluginId: "tasks", channel: "task", scope: "task_1" });
    expect(handler).toHaveBeenCalledTimes(1);

    // A scoped subscriber does not implicitly get the channel-wide stream.
    emit({ pluginId: "tasks", channel: "task", scope: null });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("subscribes to nothing for an empty id list", () => {
    const handler = vi.fn();
    renderSubscriber({
      channel: "task",
      handler,
      options: { pluginId: "tasks", ids: [] },
    });

    expect(wsState.subscribes).toEqual([]);
    emit({ pluginId: "tasks", channel: "task", scope: "task_1" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not resubscribe when the id array is a new literal with equal ids", () => {
    const view = renderSubscriber({
      channel: "task",
      handler: vi.fn(),
      options: { pluginId: "tasks", ids: ["b", "a"] },
    });
    const afterFirst = wsState.subscribes.length;

    view.rerender(
      <PluginContext.Provider value="board">
        <Subscriber
          channel="task"
          handler={vi.fn()}
          options={{ pluginId: "tasks", ids: ["a", "b"] }}
        />
      </PluginContext.Provider>,
    );

    expect(wsState.subscribes).toHaveLength(afterFirst);
    expect(wsState.unsubscribes).toHaveLength(0);
  });

  it("releases the old ids and takes the new ones when the set changes", () => {
    const view = renderSubscriber({
      channel: "task",
      handler: vi.fn(),
      options: { pluginId: "tasks", ids: ["task_1"] },
    });
    wsState.subscribes.length = 0;

    view.rerender(
      <PluginContext.Provider value="board">
        <Subscriber
          channel="task"
          handler={vi.fn()}
          options={{ pluginId: "tasks", ids: ["task_2"] }}
        />
      </PluginContext.Provider>,
    );

    expect(wsState.unsubscribes.map((t) => "scope" in t && t.scope)).toEqual([
      "task_1",
    ]);
    expect(wsState.subscribes.map((t) => "scope" in t && t.scope)).toEqual([
      "task_2",
    ]);
  });
});

describe("useRealtime publisher availability", () => {
  it("reports self for a plugin's own channel, with no contributions lookup", () => {
    const states: { publisher: string }[] = [];
    contributionsState.data = { mentionProviders: [], realtimeChannels: [] };
    renderSubscriber(
      { channel: "recall", handler: vi.fn(), onState: (s) => states.push(s) },
      "recall",
    );

    expect(states.at(-1)?.publisher).toBe("self");
  });

  it("reports live optimistically until the contributions query resolves", () => {
    const states: { publisher: string }[] = [];
    contributionsState.data = undefined;
    renderSubscriber({
      channel: "task",
      handler: vi.fn(),
      options: { pluginId: "tasks" },
      onState: (s) => states.push(s),
    });

    // A spurious "unavailable" on first paint would make every cross-plugin
    // panel flash an error banner on every reload.
    expect(states.at(-1)?.publisher).toBe("live");
  });

  it("reports live when the publisher declares the channel", () => {
    const states: { publisher: string }[] = [];
    contributionsState.data = {
      mentionProviders: [],
      realtimeChannels: [
        { pluginId: "tasks", channel: "task", label: "Task changes", scoped: true },
      ],
    };
    renderSubscriber({
      channel: "task",
      handler: vi.fn(),
      options: { pluginId: "tasks" },
      onState: (s) => states.push(s),
    });

    expect(states.at(-1)?.publisher).toBe("live");
  });

  it("reports unavailable when the publisher stops declaring the channel", () => {
    const states: { publisher: string }[] = [];
    contributionsState.data = {
      mentionProviders: [],
      realtimeChannels: [
        { pluginId: "tasks", channel: "other", label: "Other", scoped: false },
      ],
    };
    renderSubscriber({
      channel: "task",
      handler: vi.fn(),
      options: { pluginId: "tasks" },
      onState: (s) => states.push(s),
    });

    // Publisher disabled or reloading. The subscription itself is NOT torn
    // down: the server remembers it and re-grants on re-declare.
    expect(states.at(-1)?.publisher).toBe("unavailable");
    expect(wsState.unsubscribes).toEqual([]);
  });
});
