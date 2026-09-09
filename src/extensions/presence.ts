import type {
  BusIdentity,
  MessageBusExtension,
  Unsubscribe
} from "../core/types.js";

export interface PeerInfo extends BusIdentity {
  readonly lastSeenAt: number;
}

export interface PresenceOptions {
  readonly heartbeatMs?: number;
  readonly peerTimeoutMs?: number;
}

export interface PresenceApi {
  peers(): readonly PeerInfo[];
  onJoin(handler: (peer: PeerInfo) => void): Unsubscribe;
  onLeave(handler: (peer: PeerInfo) => void): Unsubscribe;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_PEER_TIMEOUT_MS = 75_000;

export function presence(options: PresenceOptions = {}): MessageBusExtension<PresenceApi> {
  return {
    id: "presence",
    install(context) {
      const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
      const peerTimeoutMs = options.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
      const peers = new Map<string, PeerInfo>();
      const joinListeners = new Set<(peer: PeerInfo) => void>();
      const leaveListeners = new Set<(peer: PeerInfo) => void>();

      const announce = (): void => {
        context.publish("announce", undefined);
      };

      const upsert = (identity: BusIdentity): void => {
        if (identity.instanceId === context.identity.instanceId) {
          return;
        }

        const now = Date.now();
        const existing = peers.get(identity.instanceId);
        const peer: PeerInfo = {
          ...identity,
          lastSeenAt: now
        };
        peers.set(identity.instanceId, peer);

        if (!existing) {
          for (const listener of joinListeners) {
            safeListener(() => listener(peer), context);
          }
        }
      };

      const remove = (instanceId: string): void => {
        const peer = peers.get(instanceId);
        if (!peer) {
          return;
        }
        peers.delete(instanceId);
        for (const listener of leaveListeners) {
          safeListener(() => listener(peer), context);
        }
      };

      const unsubscribeQuery = context.subscribe("query", () => announce());
      const unsubscribeAnnounce = context.subscribe("announce", (_payload, message) => {
        upsert(message.source);
      });
      const unsubscribeBye = context.subscribe("bye", (_payload, message) => {
        remove(message.source.instanceId);
      });

      const heartbeat = setInterval(announce, heartbeatMs);
      const cleanup = setInterval(() => {
        const cutoff = Date.now() - peerTimeoutMs;
        for (const peer of peers.values()) {
          if (peer.lastSeenAt < cutoff) {
            remove(peer.instanceId);
          }
        }
      }, Math.min(heartbeatMs, Math.max(1_000, peerTimeoutMs / 3)));

      const onVisible = (): void => {
        if (typeof document !== "undefined" && document.visibilityState === "visible") {
          context.publish("query", undefined);
          announce();
        }
      };
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisible);
      }

      context.publish("query", undefined);
      announce();

      const api: PresenceApi = {
        peers: () => [...peers.values()].sort((a, b) => a.instanceId.localeCompare(b.instanceId)),
        onJoin(handler) {
          joinListeners.add(handler);
          return () => joinListeners.delete(handler);
        },
        onLeave(handler) {
          leaveListeners.add(handler);
          return () => leaveListeners.delete(handler);
        }
      };

      return {
        api,
        dispose() {
          try {
            context.publish("bye", undefined);
          } catch {
            // The bus may already be shutting down after an external failure.
          }
          clearInterval(heartbeat);
          clearInterval(cleanup);
          unsubscribeQuery();
          unsubscribeAnnounce();
          unsubscribeBye();
          if (typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", onVisible);
          }
          peers.clear();
          joinListeners.clear();
          leaveListeners.clear();
        }
      };
    }
  };
}

function safeListener(action: () => void, context: { reportError(error: unknown): void }): void {
  try {
    action();
  } catch (error) {
    context.reportError(error);
  }
}
