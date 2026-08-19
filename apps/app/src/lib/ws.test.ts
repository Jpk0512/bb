import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientMessageSchema, type ClientMessage } from "@bb/domain";
import type { RealtimeSubscriptionTarget } from "@bb/server-contract";

const fakeSocketState = vi.hoisted(() => {
  type CloseHandler = () => void;
  type MessageHandler = (event: MessageEvent) => void;
  type OpenHandler = () => void;

  class FakeReconnectingWebSocket {
    onclose: CloseHandler | null = null;
    onmessage: MessageHandler | null = null;
    onopen: OpenHandler | null = null;
    readyState = 1;
    readonly sentMessages: string[] = [];

    constructor() {
      instances.push(this);
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }

    open(): void {
      this.readyState = 1;
      this.onopen?.();
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }
  }

  const instances: FakeReconnectingWebSocket[] = [];

  return {
    FakeReconnectingWebSocket,
    instances,
  };
});

vi.mock("partysocket/ws", () => ({
  default: fakeSocketState.FakeReconnectingWebSocket,
}));

vi.mock("./dev-websocket-url", () => ({
  buildDevWebSocketUrl: () => "ws://bb.test/ws",
}));

import { WebSocketManager } from "./ws";

const THREAD_TARGET = {
  kind: "thread-detail",
  threadId: "thr_1",
} satisfies RealtimeSubscriptionTarget;
const PROJECT_TARGET = {
  kind: "project-list",
} satisfies RealtimeSubscriptionTarget;
// BBF-4 gate targets. `as` is deliberately excluded from the subscription key
// (see realtimeSubscriptionTargetKey), so these two share one refcount entry.
const PLUGIN_CHANNEL_TARGET = {
  kind: "plugin-channel",
  pluginId: "tasks",
  channel: "task",
  scope: null,
  as: "board",
} satisfies RealtimeSubscriptionTarget;
const PLUGIN_CHANNEL_SCOPED_TARGET = {
  kind: "plugin-channel",
  pluginId: "tasks",
  channel: "task",
  scope: "task_1",
  as: "board",
} satisfies RealtimeSubscriptionTarget;
const PLUGIN_CHANNEL_OTHER_SUBSCRIBER_TARGET = {
  kind: "plugin-channel",
  pluginId: "tasks",
  channel: "task",
  scope: null,
  as: "telemetry",
} satisfies RealtimeSubscriptionTarget;

interface ConnectedManager {
  manager: WebSocketManager;
  socket: FakeSocket;
}

interface FakeSocket {
  readonly sentMessages: string[];
  close: () => void;
  open: () => void;
}

function installOpenWebSocketConstructor(): void {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: {
      OPEN: 1,
    },
  });
}

function readClientMessages(socket: FakeSocket): readonly ClientMessage[] {
  return socket.sentMessages.map((message) =>
    clientMessageSchema.parse(JSON.parse(message)),
  );
}

function getOnlySocket(): FakeSocket {
  const socket = fakeSocketState.instances[0];
  if (!socket) {
    throw new Error("Expected websocket to be created");
  }
  return socket;
}

function createConnectedManager(): ConnectedManager {
  const manager = new WebSocketManager();
  manager.connect();
  const socket = getOnlySocket();
  socket.open();
  return { manager, socket };
}

describe("WebSocketManager subscriptions", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    fakeSocketState.instances.length = 0;
    installOpenWebSocketConstructor();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  });

  it("ref-counts duplicate subscriptions and unsubscribes only after the final cleanup", () => {
    const { manager, socket } = createConnectedManager();

    manager.subscribe(THREAD_TARGET);
    manager.subscribe(THREAD_TARGET);

    expect(readClientMessages(socket)).toEqual([
      {
        type: "subscribe",
        target: THREAD_TARGET,
      },
    ]);

    manager.unsubscribe(THREAD_TARGET);

    expect(readClientMessages(socket)).toEqual([
      {
        type: "subscribe",
        target: THREAD_TARGET,
      },
    ]);

    manager.unsubscribe(THREAD_TARGET);

    expect(readClientMessages(socket)).toEqual([
      {
        type: "subscribe",
        target: THREAD_TARGET,
      },
      {
        type: "unsubscribe",
        target: THREAD_TARGET,
      },
    ]);
  });

  it("resends active subscriptions when the websocket reconnects", () => {
    const { manager, socket } = createConnectedManager();

    manager.subscribe(THREAD_TARGET);
    manager.subscribe(PROJECT_TARGET);
    socket.sentMessages.length = 0;

    socket.close();
    socket.open();

    expect(readClientMessages(socket)).toEqual([
      {
        type: "subscribe",
        target: THREAD_TARGET,
      },
      {
        type: "subscribe",
        target: PROJECT_TARGET,
      },
    ]);
  });

  // ---------------------------------------------------------------------
  // BBF-4 hub-routing gate (phase-6 charter §2). Plugin signals stop being
  // broadcast and start being routed by subscription key, so a plugin panel
  // only stays alive while its `plugin-channel` subscription exists on the
  // server. bb is used remotely over a `bb connect` tunnel, and a tunnel drop
  // tears the socket down: if these targets are not replayed by onopen, every
  // remote plugin panel silently goes dead and stays dead with no error.
  // These three tests are the precondition for flipping hub routing.
  // ---------------------------------------------------------------------

  it("replays plugin-channel subscriptions when the websocket reconnects", () => {
    const { manager, socket } = createConnectedManager();

    manager.subscribe(PLUGIN_CHANNEL_TARGET);
    manager.subscribe(PLUGIN_CHANNEL_SCOPED_TARGET);
    manager.subscribe(THREAD_TARGET);
    socket.sentMessages.length = 0;

    // A `bb connect` tunnel drop looks exactly like this to the app.
    socket.close();
    socket.open();

    expect(readClientMessages(socket)).toEqual([
      { type: "subscribe", target: PLUGIN_CHANNEL_TARGET },
      { type: "subscribe", target: PLUGIN_CHANNEL_SCOPED_TARGET },
      { type: "subscribe", target: THREAD_TARGET },
    ]);
  });

  it("keeps replaying plugin-channel subscriptions across repeated drops", () => {
    const { manager, socket } = createConnectedManager();

    manager.subscribe(PLUGIN_CHANNEL_SCOPED_TARGET);

    for (let drop = 0; drop < 3; drop += 1) {
      socket.sentMessages.length = 0;
      socket.close();
      socket.open();
      expect(readClientMessages(socket)).toEqual([
        { type: "subscribe", target: PLUGIN_CHANNEL_SCOPED_TARGET },
      ]);
    }

    // And a target released while offline is not resurrected by the next open.
    manager.unsubscribe(PLUGIN_CHANNEL_SCOPED_TARGET);
    socket.sentMessages.length = 0;
    socket.close();
    socket.open();

    expect(readClientMessages(socket)).toEqual([]);
  });

  it("ref-counts plugin-channel targets per asserting subscriber and replays each", () => {
    const { manager, socket } = createConnectedManager();

    // Two different plugins watching the same publisher channel. They share one
    // hub fan-out entry (`as` is excluded from realtimeSubscriptionTargetKey),
    // but the server authorizes each claim separately, so each must reach it.
    // Deduping on the server key here would make mount order decide who gets
    // fed.
    manager.subscribe(PLUGIN_CHANNEL_TARGET);
    manager.subscribe(PLUGIN_CHANNEL_TARGET);
    manager.subscribe(PLUGIN_CHANNEL_OTHER_SUBSCRIBER_TARGET);

    expect(readClientMessages(socket)).toEqual([
      { type: "subscribe", target: PLUGIN_CHANNEL_TARGET },
      { type: "subscribe", target: PLUGIN_CHANNEL_OTHER_SUBSCRIBER_TARGET },
    ]);

    manager.unsubscribe(PLUGIN_CHANNEL_OTHER_SUBSCRIBER_TARGET);
    manager.unsubscribe(PLUGIN_CHANNEL_TARGET);
    socket.sentMessages.length = 0;
    socket.close();
    socket.open();

    // The still-held subscriber (refcount 2, released once) is re-established;
    // the released one is not.
    expect(readClientMessages(socket)).toEqual([
      { type: "subscribe", target: PLUGIN_CHANNEL_TARGET },
    ]);
  });
});

describe("WebSocketManager thread-open signals", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    fakeSocketState.instances.length = 0;
    installOpenWebSocketConstructor();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  });

  function dispatchRaw(payload: unknown): void {
    const instance = fakeSocketState.instances[0];
    if (!instance) {
      throw new Error("Expected websocket instance");
    }
    instance.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  it("notifies layout listeners and buffers an included file once", () => {
    const { manager } = createConnectedManager();
    const threadOpen = vi.fn();
    const changed = vi.fn();
    manager.onThreadOpen(threadOpen);
    manager.onChanged(changed);

    const signal = {
      type: "thread-open",
      projectId: "proj_1",
      threadId: "thr_1",
      split: "right",
      file: {
        source: "workspace",
        path: "src/index.ts",
        lineNumber: 7,
      },
    };
    dispatchRaw(signal);

    expect(threadOpen).toHaveBeenCalledWith(signal);
    expect(changed).not.toHaveBeenCalled();
    expect(manager.consumePendingOpenFile("thr_1")).toEqual(signal.file);
    // Consumed exactly once: a later visit does not re-open.
    expect(manager.consumePendingOpenFile("thr_1")).toBeNull();
  });

  it("still routes changed messages to onChanged", () => {
    const { manager } = createConnectedManager();
    const changed = vi.fn();
    const threadOpen = vi.fn();
    manager.onChanged(changed);
    manager.onThreadOpen(threadOpen);

    dispatchRaw({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["events-appended"],
    });

    expect(changed).toHaveBeenCalledTimes(1);
    expect(threadOpen).not.toHaveBeenCalled();
  });

  it("routes typed thread-pane actions separately", () => {
    const { manager } = createConnectedManager();
    const paneAction = vi.fn();
    const threadOpen = vi.fn();
    manager.onThreadPaneAction(paneAction);
    manager.onThreadOpen(threadOpen);

    const signal = {
      type: "thread-pane-action",
      projectId: "proj_1",
      threadId: "thr_1",
      action: "spotlight",
    } as const;
    dispatchRaw(signal);

    expect(paneAction).toHaveBeenCalledWith(signal);
    expect(threadOpen).not.toHaveBeenCalled();
  });
});
