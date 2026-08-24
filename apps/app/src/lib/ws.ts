import ReconnectingWebSocket from "partysocket/ws";
import {
  changedMessageLenientSchema,
  pluginSignalLenientSchema,
  realtimeSubscriptionTargetKey,
  threadOpenSignalLenientSchema,
  threadPaneActionSignalLenientSchema,
} from "@bb/server-contract";
import type {
  ClientMessage,
  ChangedMessage,
  PluginSignal,
  RealtimeSubscriptionTarget,
  ThreadOpenFile,
  ThreadOpenSignal,
  ThreadPaneActionSignal,
} from "@bb/server-contract";
import { buildDevWebSocketUrl } from "./dev-websocket-url";

type ChangeCallback = (message: ChangedMessage) => void;
type ThreadOpenCallback = (signal: ThreadOpenSignal) => void;
type ThreadPaneActionCallback = (signal: ThreadPaneActionSignal) => void;
type PluginSignalCallback = (signal: PluginSignal) => void;
type ConnectedCallback = (event: { reconnected: boolean }) => void;
type ConnectionStateCallback = () => void;
export type WebSocketConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting";

interface ActiveSubscription {
  count: number;
  target: RealtimeSubscriptionTarget;
}

/**
 * How long the socket may stay silent before realtime is treated as unproven.
 *
 * The server answers no application ping — an unrecognized client message is a
 * 1008 close (see onClientSocketMessage) — so liveness can only be inferred
 * from what the server sends. Silence is therefore not proof of a dead socket,
 * and this window is deliberately short: the only consumer is a mutation
 * success path that degrades to invalidating caches, so guessing "not live" on
 * an idle-but-healthy socket costs one refetch, while guessing "live" on a
 * TCP-dead socket that has not fired onclose yet loses the update entirely.
 */
const REALTIME_SILENCE_LIMIT_MS = 10_000;

/**
 * Close codes the server uses to reject something this client sent, as opposed
 * to a transport failure. Replaying the same subscription set into the next
 * socket reproduces them, so these need attribution rather than a retry.
 */
const SUBSCRIPTION_REJECTING_CLOSE_CODES = new Set([
  1002, 1003, 1007, 1008, 1009,
]);

/**
 * How long a socket must survive after a subscribe before the server counts as
 * having accepted it. The server acknowledges nothing on success, so staying
 * open is the only available signal.
 */
const SUBSCRIPTION_ACCEPTANCE_MS = 5_000;

export class WebSocketManager {
  private socket: ReconnectingWebSocket | null = null;
  private subscriptions = new Map<string, ActiveSubscription>();
  private callbacks = new Set<ChangeCallback>();
  private threadOpenCallbacks = new Set<ThreadOpenCallback>();
  private threadPaneActionCallbacks = new Set<ThreadPaneActionCallback>();
  private pluginSignalCallbacks = new Set<PluginSignalCallback>();
  // Ephemeral "open this file in the secondary panel" intents, keyed by thread.
  // Held in memory only (cleared on reload) so a thread that is not currently
  // viewed opens the file when it is next viewed. Last write wins per thread.
  private pendingOpenFileByThreadId = new Map<string, ThreadOpenFile>();
  private connectedCallbacks = new Set<ConnectedCallback>();
  private connectionStateCallbacks = new Set<ConnectionStateCallback>();
  private hasConnected = false;
  private connectionState: WebSocketConnectionState = "connecting";
  private lastServerMessageAt = 0;
  private acceptedSubscriptionKeys = new Set<string>();
  private rejectedSubscriptionKeys = new Set<string>();
  private unacceptedSubscriptionKeysSent: string[] = [];
  private acceptanceTimer: ReturnType<typeof setTimeout> | null = null;
  private stagingSubscriptionReplay = false;

  connect(): void {
    if (this.socket) return;

    // In dev mode, connect directly to the server to bypass Vite's WS proxy
    // which does not handle reconnection after backend restarts.
    // In production, use the same origin (server serves the app).
    const url =
      buildDevWebSocketUrl({ path: "/ws" }) ??
      `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;

    this.socket = new ReconnectingWebSocket(url, undefined, {
      minReconnectionDelay: 1000,
      maxReconnectionDelay: 30000,
      reconnectionDelayGrowFactor: 1.5,
      connectionTimeout: 10000,
      maxRetries: Infinity,
    });

    this.socket.onopen = () => {
      const reconnected = this.hasConnected;
      this.hasConnected = true;
      this.lastServerMessageAt = Date.now();
      this.clearSubscriptionAcceptance();
      this.setConnectionState("connected");
      this.replaySubscriptions();
      for (const callback of this.connectedCallbacks) {
        callback({ reconnected });
      }
    };

    this.socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      this.handleIncomingMessage(event.data);
    };

    this.socket.onclose = (event: CloseEvent) => {
      const suspects = this.unacceptedSubscriptionKeysSent;
      this.clearSubscriptionAcceptance();
      if (SUBSCRIPTION_REJECTING_CLOSE_CODES.has(event.code)) {
        this.attributeSubscriptionRejection(event, suspects);
      }
      this.setConnectionState(
        this.hasConnected ? "reconnecting" : "connecting",
      );
    };
  }

  /**
   * Re-establish the active subscriptions on a fresh socket. While a rejection
   * is being attributed, only one not-yet-accepted target goes out per socket
   * so a later close names exactly one suspect.
   */
  private replaySubscriptions(): void {
    let sentUnaccepted = false;
    for (const [key, subscription] of this.subscriptions) {
      if (this.rejectedSubscriptionKeys.has(key)) continue;
      if (!this.acceptedSubscriptionKeys.has(key)) {
        if (this.stagingSubscriptionReplay && sentUnaccepted) continue;
        sentUnaccepted = true;
      }
      this.sendSubscription(key, subscription.target);
    }
    if (!sentUnaccepted) {
      // Staging means exactly one candidate is being probed. With none left
      // (they were all accepted, quarantined, or unsubscribed) nothing can
      // clear the flag, and it would hold isRealtimeLive() at false forever.
      this.stagingSubscriptionReplay = false;
    }
  }

  private sendSubscription(
    key: string,
    target: RealtimeSubscriptionTarget,
  ): void {
    this.sendMessage({ type: "subscribe", target });
    if (this.acceptedSubscriptionKeys.has(key)) {
      return;
    }
    this.unacceptedSubscriptionKeysSent.push(key);
    this.clearAcceptanceTimer();
    this.acceptanceTimer = setTimeout(() => {
      this.acceptanceTimer = null;
      this.acceptOutstandingSubscriptions();
    }, SUBSCRIPTION_ACCEPTANCE_MS);
  }

  private acceptOutstandingSubscriptions(): void {
    this.clearAcceptanceTimer();
    for (const key of this.unacceptedSubscriptionKeysSent) {
      this.acceptedSubscriptionKeys.add(key);
    }
    this.unacceptedSubscriptionKeysSent = [];
    if (!this.stagingSubscriptionReplay) {
      return;
    }
    for (const [key, subscription] of this.subscriptions) {
      if (this.rejectedSubscriptionKeys.has(key)) continue;
      if (this.acceptedSubscriptionKeys.has(key)) continue;
      this.sendSubscription(key, subscription.target);
      return;
    }
    this.stagingSubscriptionReplay = false;
  }

  private clearAcceptanceTimer(): void {
    if (this.acceptanceTimer === null) {
      return;
    }
    clearTimeout(this.acceptanceTimer);
    this.acceptanceTimer = null;
  }

  private clearSubscriptionAcceptance(): void {
    this.clearAcceptanceTimer();
    this.unacceptedSubscriptionKeysSent = [];
  }

  private attributeSubscriptionRejection(
    event: CloseEvent,
    suspects: readonly string[],
  ): void {
    const [onlySuspect] = suspects;
    if (suspects.length === 1 && onlySuspect !== undefined) {
      this.rejectedSubscriptionKeys.add(onlySuspect);
      this.stagingSubscriptionReplay = false;
      console.error(
        `Server rejected realtime subscription ${onlySuspect} (close ${event.code} ${event.reason}). It will not be replayed; reload after upgrading the server.`,
      );
      return;
    }
    if (suspects.length === 0) {
      // Nothing was in flight, so the rejected target is one this client had
      // already recorded as accepted — acceptance proved something about a
      // server this one is not (an in-place downgrade, or a different instance
      // behind the same URL). Keeping that record replays the set verbatim and
      // the close repeats with no suspect to name: the invisible loop. Drop it
      // so the next sockets re-prove each target one at a time.
      if (this.acceptedSubscriptionKeys.size === 0) {
        return;
      }
      this.acceptedSubscriptionKeys.clear();
      this.stagingSubscriptionReplay = true;
      console.error(
        `Server closed the realtime socket (close ${event.code} ${event.reason}) with no subscribe outstanding, so a previously accepted target is no longer accepted. Re-establishing the set one at a time to identify it.`,
      );
      return;
    }
    this.stagingSubscriptionReplay = true;
    console.error(
      `Server closed the realtime socket (close ${event.code} ${event.reason}) while establishing ${suspects.length} subscriptions. Re-establishing them one at a time to identify the rejected target.`,
    );
  }

  /**
   * Parse and dispatch one raw server message. Public only so tests can
   * exercise the routing without a live socket.
   */
  handleIncomingMessage(data: string): void {
    // Any server traffic is the only liveness evidence available, and it also
    // proves the subscribes sent before it were accepted.
    this.lastServerMessageAt = Date.now();
    this.acceptOutstandingSubscriptions();

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Ignore malformed messages
      return;
    }

    // Ephemeral thread-open broadcast. Notify layout listeners immediately;
    // when it includes a file, buffer that file per thread until the target
    // pane's secondary panel is ready to consume it.
    const threadOpen = threadOpenSignalLenientSchema.safeParse(parsed);
    if (threadOpen.success) {
      if (threadOpen.data.file !== null) {
        this.pendingOpenFileByThreadId.set(
          threadOpen.data.threadId,
          threadOpen.data.file,
        );
      }
      for (const cb of this.threadOpenCallbacks) {
        cb(threadOpen.data);
      }
      return;
    }

    const threadPaneAction =
      threadPaneActionSignalLenientSchema.safeParse(parsed);
    if (threadPaneAction.success) {
      for (const cb of this.threadPaneActionCallbacks) {
        cb(threadPaneAction.data);
      }
      return;
    }

    // Ephemeral plugin realtime signal (bb.realtime.publish). Not buffered:
    // only live useRealtime subscribers care, and V1 has no replay.
    const pluginSignal = pluginSignalLenientSchema.safeParse(parsed);
    if (pluginSignal.success) {
      for (const cb of this.pluginSignalCallbacks) {
        cb(pluginSignal.data);
      }
      return;
    }

    // Lenient parse: tolerate a newer server (unknown fields stripped,
    // unknown change kinds filtered) instead of dropping whole messages
    // on additive contract changes.
    const msg = changedMessageLenientSchema.safeParse(parsed);
    if (msg.success) {
      for (const cb of this.callbacks) {
        cb(msg.data);
      }
    } else {
      console.error("Ignored invalid realtime message", msg.error);
    }
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.clearSubscriptionAcceptance();
    this.lastServerMessageAt = 0;
    this.setConnectionState("connecting");
  }

  /**
   * Refcount key for one active subscription.
   *
   * For plugin-channel targets (BBF-4) it is deliberately FINER than the
   * server's fan-out key: `realtimeSubscriptionTargetKey` excludes `as` so one
   * window is one hub fan-out entry however many plugins want it, but the
   * server authorizes per asserting subscriber. If the app deduped on the
   * server key, only the first subscriber's `as` would ever be sent, and mount
   * order would silently decide whether a publisher's own panel — or a foreign
   * one — got the feed.
   */
  private subscriptionRefcountKey(target: RealtimeSubscriptionTarget): string {
    const key = realtimeSubscriptionTargetKey(target);
    if (target.kind !== "plugin-channel") return key;
    return `${key}|as=${target.as ?? target.pluginId}`;
  }

  subscribe(target: RealtimeSubscriptionTarget): void {
    const key = this.subscriptionRefcountKey(target);
    const existing = this.subscriptions.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }

    this.subscriptions.set(key, { count: 1, target });
    // A quarantined target is one this server closes the socket over, so a
    // remount must not send it again: the refcount is kept (so unsubscribe
    // stays balanced) but the wire stays quiet until the tab reloads.
    if (this.rejectedSubscriptionKeys.has(key)) {
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendSubscription(key, target);
    }
  }

  unsubscribe(target: RealtimeSubscriptionTarget): void {
    const key = this.subscriptionRefcountKey(target);
    const existing = this.subscriptions.get(key);
    if (!existing) {
      return;
    }
    if (existing.count > 1) {
      existing.count -= 1;
      return;
    }

    this.subscriptions.delete(key);
    // The server never accepted a quarantined target, and an unsubscribe
    // carries the same payload the server rejects, so sending it would close
    // the socket the other subscriptions are sharing.
    if (this.rejectedSubscriptionKeys.has(key)) {
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendMessage({ type: "unsubscribe", target });
    }
  }

  onChanged(callback: ChangeCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  onThreadOpen(callback: ThreadOpenCallback): () => void {
    this.threadOpenCallbacks.add(callback);
    return () => {
      this.threadOpenCallbacks.delete(callback);
    };
  }

  onThreadPaneAction(callback: ThreadPaneActionCallback): () => void {
    this.threadPaneActionCallbacks.add(callback);
    return () => {
      this.threadPaneActionCallbacks.delete(callback);
    };
  }

  onPluginSignal(callback: PluginSignalCallback): () => void {
    this.pluginSignalCallbacks.add(callback);
    return () => {
      this.pluginSignalCallbacks.delete(callback);
    };
  }

  /**
   * Return and clear the buffered "open file" intent for a thread, if any. The
   * secondary panel calls this when the thread becomes visible so the file
   * opens exactly once and is not re-opened on a later visit.
   */
  consumePendingOpenFile(threadId: string): ThreadOpenFile | null {
    const pending = this.pendingOpenFileByThreadId.get(threadId);
    if (!pending) {
      return null;
    }
    this.pendingOpenFileByThreadId.delete(threadId);
    return pending;
  }

  onConnected(callback: ConnectedCallback): () => void {
    this.connectedCallbacks.add(callback);
    return () => {
      this.connectedCallbacks.delete(callback);
    };
  }

  onConnectionStateChange(callback: ConnectionStateCallback): () => void {
    this.connectionStateCallbacks.add(callback);
    return () => {
      this.connectionStateCallbacks.delete(callback);
    };
  }

  getConnectionState(): WebSocketConnectionState {
    return this.connectionState;
  }

  /**
   * Whether realtime delivery is currently proven, not merely assumed.
   *
   * `connectionState` only moves on the socket's open/close callbacks, so a
   * TCP-dead socket keeps reporting "connected" until the browser notices —
   * which is why callers that skip work "because realtime will deliver it"
   * must ask this instead. Pull-only on purpose: it can go stale without an
   * event, so it is read at the moment a decision depends on it.
   */
  isRealtimeLive(): boolean {
    if (this.connectionState !== "connected") {
      return false;
    }
    // Mid-attribution the subscription set is deliberately incomplete, so the
    // events a caller would rely on may not be flowing yet.
    if (this.stagingSubscriptionReplay) {
      return false;
    }
    return Date.now() - this.lastServerMessageAt <= REALTIME_SILENCE_LIMIT_MS;
  }

  private sendMessage(msg: ClientMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private setConnectionState(nextState: WebSocketConnectionState): void {
    if (this.connectionState === nextState) {
      return;
    }
    this.connectionState = nextState;
    for (const callback of this.connectionStateCallbacks) {
      callback();
    }
  }
}

// Singleton instance — preserved across Vite HMR so the WebSocket connection
// and its state survive module re-evaluation during dev rebuilds.
function createOrReuse(): WebSocketManager {
  if (import.meta.hot?.data) {
    const existing = import.meta.hot.data.wsManager as
      | WebSocketManager
      | undefined;
    if (existing) return existing;
    const instance = new WebSocketManager();
    import.meta.hot.data.wsManager = instance;
    return instance;
  }
  return new WebSocketManager();
}

export const wsManager = createOrReuse();
