import { clientMessageSchema } from "@bb/domain";
import { decodeSocketPayload } from "./decode-payload.js";
import type { NotificationHub } from "./hub.js";
import type { WatchInterestCoordinator } from "./watch-interests.js";
import type { PluginRealtimeCoordinator } from "./plugin-realtime.js";

interface ClientSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export function onClientSocketOpen(
  hub: NotificationHub,
  socket: ClientSocket,
): void {
  hub.registerClient(socket);
}

export function onClientSocketMessage(
  deps: {
    hub: NotificationHub;
    watchInterests: Pick<
      WatchInterestCoordinator,
      "subscribe" | "unsubscribe" | "releaseSocket"
    >;
    pluginRealtime: Pick<
      PluginRealtimeCoordinator,
      "subscribe" | "unsubscribe" | "releaseSocket"
    >;
  },
  socket: ClientSocket,
  raw: unknown,
): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeSocketPayload(raw));
  } catch {
    socket.close(1008, "invalid-message");
    return;
  }

  const result = clientMessageSchema.safeParse(decoded);
  if (!result.success) {
    socket.close(1008, "invalid-message");
    return;
  }
  const parsed = result.data;

  switch (parsed.type) {
    case "subscribe":
      // BBF-4: the plugin-realtime coordinator OWNS plugin-channel targets and
      // calls the hub itself, because it may have to defer the hub.subscribe
      // until the publishing plugin declares the channel. It returns false for
      // every other target kind, which the hub takes directly.
      //
      // An unauthorized plugin-channel subscribe is remembered and left
      // ungranted — never a socket close. One plugin's bad subscribe must not
      // kill the whole window's shared connection.
      if (!deps.pluginRealtime.subscribe(socket, parsed.target)) {
        deps.hub.subscribe(socket, parsed.target);
      }
      deps.watchInterests.subscribe(socket, parsed.target);
      break;
    case "unsubscribe":
      if (!deps.pluginRealtime.unsubscribe(socket, parsed.target)) {
        deps.hub.unsubscribe(socket, parsed.target);
      }
      deps.watchInterests.unsubscribe(socket, parsed.target);
      break;
    default: {
      const _exhaustive: never = parsed;
      throw new Error(`Unhandled client message: ${_exhaustive}`);
    }
  }
}

export function onClientSocketClose(
  deps: {
    hub: NotificationHub;
    watchInterests: Pick<WatchInterestCoordinator, "releaseSocket">;
    pluginRealtime: Pick<PluginRealtimeCoordinator, "releaseSocket">;
  },
  socket: ClientSocket,
): void {
  deps.watchInterests.releaseSocket(socket);
  deps.pluginRealtime.releaseSocket(socket);
  deps.hub.unregisterClient(socket);
}
