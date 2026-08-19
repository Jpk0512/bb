import {
  realtimeSubscriptionTargetKey,
  type RealtimeSubscriptionTarget,
} from "@bb/domain";
import type { NotificationHub } from "./hub.js";

/**
 * Cross-plugin realtime subscription policy (BBF-4).
 *
 * ## This is a compatibility contract, NOT a security boundary
 *
 * Say it plainly, because the shape of the code invites the opposite reading:
 * a publisher declares which of its channels other plugins may subscribe to,
 * and this coordinator refuses undeclared foreign subscriptions. That looks
 * like a permission system. It is not one, and must never be described as one
 * in user-facing copy.
 *
 * - `bb.sdk.plugins.callRpc({ pluginId, method })` already lets any plugin call
 *   any other plugin's RPC with no grant of any kind. A subscriber denied a
 *   channel here just polls the publisher's RPC instead — which is exactly what
 *   bb-plugin-board does today. A subscriber-side gate would be theater.
 * - Every plugin frontend shares one JS realm and one
 *   `globalThis.__bbPluginRuntime`. The `as` field on the subscribe target is
 *   client-asserted; a hostile bundle can subscribe as anyone.
 *
 * What the declaration actually buys is worth having on its own terms:
 *
 * - An EXPLICIT, VERSIONED contract instead of an accidental one. Before this,
 *   a publisher's internal channel name became a de-facto public API the moment
 *   another plugin read it off the wire, and renaming it broke a stranger
 *   silently. `bb.realtime.declare` is the publisher stating which names it
 *   intends to keep, with a human label the plugin detail page can show and a
 *   `scoped` flag that says whether ids are meaningful on it.
 * - A default that is strictly more private than the broadcast it replaces:
 *   before BBF-4 every plugin's every payload reached every connected client
 *   and was discarded by a client-side `if`. Now an undeclared channel reaches
 *   only the publisher's own panels.
 *
 * ## Own-channel subscriptions never need a declaration
 *
 * `as === pluginId` is always allowed. Every plugin that used `useRealtime`
 * before BBF-4 keeps working with no declaration and no rebuild.
 *
 * ## Publisher disabled / reloaded
 *
 * The coordinator records what a socket ASKED for, separately from what the
 * hub currently delivers. A foreign request for an undeclared channel is
 * remembered but not granted. Every declaration change re-reconciles the
 * remembered set for that publisher:
 *
 * - publisher disabled, reloading, or crashed → declarations cleared → granted
 *   foreign subscriptions are revoked from the hub and go quiet;
 * - publisher re-enabled or reloaded and re-declares → the remembered requests
 *   are re-granted and delivery resumes with NO client action.
 *
 * Forgetting the request on revoke would leave a subscriber panel permanently
 * dead after the publisher was toggled off and on, with nothing left to trigger
 * a re-subscribe — the plugin is still mounted and its effect has already run.
 *
 * ## Why grants are aggregated per (socket, key) over asserted `as` values
 *
 * `realtimeSubscriptionTargetKey` deliberately excludes `as`, so one browser
 * window watching one publisher channel is one hub fan-out entry no matter how
 * many plugins want it. But authorization differs per subscriber, so the
 * coordinator keeps every asserted `as` for a key and grants the shared hub
 * subscription when ANY of them is permitted. Without that, mount order would
 * decide behaviour: a foreign plugin subscribing first to an undeclared channel
 * would leave the publisher's OWN panel silently unfed.
 */

interface PluginRealtimeSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface PluginRealtimeCoordinatorDeps {
  hub: Pick<NotificationHub, "subscribe" | "unsubscribe">;
}

/** One channel a plugin has declared other plugins may subscribe to. */
export interface PluginRealtimeChannelDeclaration {
  channel: string;
  /** Human label for the plugin detail "Includes" section. */
  label: string;
  /** True when publishes on this channel carry a scope id (task id, thread id). */
  scoped: boolean;
}

/** One declared channel, flattened for the contributions route. */
export interface PluginRealtimeChannelContribution
  extends PluginRealtimeChannelDeclaration {
  pluginId: string;
}

type PluginChannelTarget = Extract<
  RealtimeSubscriptionTarget,
  { kind: "plugin-channel" }
>;

interface RecordedKey {
  granted: boolean;
  /** Subscriber plugin id → the target it asserted (all share one key). */
  requests: Map<string, PluginChannelTarget>;
}

export function isPluginChannelTarget(
  target: RealtimeSubscriptionTarget,
): target is PluginChannelTarget {
  return target.kind === "plugin-channel";
}

const CHANNEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Shared with the plugin API so `declare` and this coordinator cannot drift. */
export function isValidPluginRealtimeChannelName(channel: string): boolean {
  return CHANNEL_NAME_PATTERN.test(channel);
}

function subscriberIdOf(target: PluginChannelTarget): string {
  return target.as ?? target.pluginId;
}

export class PluginRealtimeCoordinator {
  /** Publisher plugin id → declared channel name → declaration. */
  private readonly declarationsByPlugin = new Map<
    string,
    Map<string, PluginRealtimeChannelDeclaration>
  >();
  /** Socket → subscription key → recorded requests and current grant. */
  private readonly recordsBySocket = new Map<
    PluginRealtimeSocket,
    Map<string, RecordedKey>
  >();

  constructor(private readonly deps: PluginRealtimeCoordinatorDeps) {}

  /**
   * Whether this exact target may be delivered right now. Own-plugin targets
   * always may; a foreign target may only while its publisher declares the
   * channel. Non-plugin-channel targets are not this coordinator's business and
   * report true.
   */
  isSubscribable(target: RealtimeSubscriptionTarget): boolean {
    if (!isPluginChannelTarget(target)) return true;
    if (subscriberIdOf(target) === target.pluginId) return true;
    return (
      this.declarationsByPlugin.get(target.pluginId)?.has(target.channel) ===
      true
    );
  }

  /**
   * Take ownership of a `subscribe` for a plugin-channel target and return
   * true; return false for every other target kind so the caller falls through
   * to the hub.
   *
   * Ownership matters: a foreign request for a not-yet-declared channel must be
   * REMEMBERED without being handed to the hub. A plain
   * `if (allowed) hub.subscribe()` at the call site would forget it and never
   * recover once the publisher loaded.
   */
  subscribe(
    socket: PluginRealtimeSocket,
    target: RealtimeSubscriptionTarget,
  ): boolean {
    if (!isPluginChannelTarget(target)) return false;

    const key = realtimeSubscriptionTargetKey(target);
    const records =
      this.recordsBySocket.get(socket) ?? new Map<string, RecordedKey>();
    this.recordsBySocket.set(socket, records);
    const record =
      records.get(key) ?? ({ granted: false, requests: new Map() } as RecordedKey);
    records.set(key, record);
    record.requests.set(subscriberIdOf(target), target);
    this.applyGrant(socket, record);
    return true;
  }

  /** Mirror of {@link subscribe}; returns true when it owned the target. */
  unsubscribe(
    socket: PluginRealtimeSocket,
    target: RealtimeSubscriptionTarget,
  ): boolean {
    if (!isPluginChannelTarget(target)) return false;

    const key = realtimeSubscriptionTargetKey(target);
    const records = this.recordsBySocket.get(socket);
    const record = records?.get(key);
    if (!records || !record) {
      // Never recorded — still clear any hub state, so an unsubscribe is never
      // a silent no-op because the bookkeeping disagreed.
      this.deps.hub.unsubscribe(socket, target);
      return true;
    }

    record.requests.delete(subscriberIdOf(target));
    if (record.requests.size > 0) {
      // Another plugin on this window still wants the shared entry; only the
      // aggregate grant can change.
      this.applyGrant(socket, record);
      return true;
    }

    records.delete(key);
    if (records.size === 0) this.recordsBySocket.delete(socket);
    if (record.granted) this.deps.hub.unsubscribe(socket, target);
    return true;
  }

  /**
   * Forget a closed socket. The hub clears its own per-socket keys in
   * `unregisterClient`, so this only drops the request bookkeeping — but it
   * must happen, or the server leaks one entry per closed tab.
   */
  releaseSocket(socket: PluginRealtimeSocket): void {
    this.recordsBySocket.delete(socket);
  }

  /**
   * Replace a publisher's declared channel set at plugin activation, then
   * reconcile every remembered request for it: newly declared channels are
   * granted, withdrawn ones revoked.
   */
  replaceDeclarationsForOwner(
    pluginId: string,
    declarations: readonly PluginRealtimeChannelDeclaration[],
  ): void {
    if (pluginId.trim().length === 0) {
      throw new Error(
        "realtime channel declaration pluginId must be non-empty",
      );
    }
    const next = new Map<string, PluginRealtimeChannelDeclaration>();
    for (const declaration of declarations) {
      next.set(declaration.channel, {
        channel: declaration.channel,
        label: declaration.label,
        scoped: declaration.scoped,
      });
    }
    if (next.size === 0) this.declarationsByPlugin.delete(pluginId);
    else this.declarationsByPlugin.set(pluginId, next);
    this.reconcile(pluginId);
  }

  /** Publisher disabled, reloading, or crashed: revoke, but do not forget. */
  clearDeclarationsForOwner(pluginId: string): void {
    this.declarationsByPlugin.delete(pluginId);
    this.reconcile(pluginId);
  }

  /** Every declared channel across every loaded publisher, for the API route. */
  listChannelContributions(): PluginRealtimeChannelContribution[] {
    const contributions: PluginRealtimeChannelContribution[] = [];
    for (const [pluginId, channels] of this.declarationsByPlugin) {
      for (const declaration of channels.values()) {
        contributions.push({ pluginId, ...declaration });
      }
    }
    return contributions.sort(
      (a, b) =>
        a.pluginId.localeCompare(b.pluginId) ||
        a.channel.localeCompare(b.channel),
    );
  }

  /** The channels one publisher currently declares, for capability summaries. */
  listChannelsForPlugin(pluginId: string): PluginRealtimeChannelDeclaration[] {
    const channels = this.declarationsByPlugin.get(pluginId);
    if (!channels) return [];
    return [...channels.values()].sort((a, b) =>
      a.channel.localeCompare(b.channel),
    );
  }

  private applyGrant(socket: PluginRealtimeSocket, record: RecordedKey): void {
    let granted = false;
    let representative: PluginChannelTarget | undefined;
    for (const target of record.requests.values()) {
      representative ??= target;
      if (this.isSubscribable(target)) {
        granted = true;
        representative = target;
        break;
      }
    }
    if (granted === record.granted || representative === undefined) return;
    record.granted = granted;
    if (granted) this.deps.hub.subscribe(socket, representative);
    else this.deps.hub.unsubscribe(socket, representative);
  }

  private reconcile(pluginId: string): void {
    for (const [socket, records] of this.recordsBySocket) {
      for (const record of records.values()) {
        const first = record.requests.values().next().value;
        if (first === undefined || first.pluginId !== pluginId) continue;
        this.applyGrant(socket, record);
      }
    }
  }
}
