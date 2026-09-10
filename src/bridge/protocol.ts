import { BUS_NAMESPACE, PROTOCOL_VERSION } from "../core/constants.js";
import type { BusIdentity } from "../core/types.js";

/** Technische Nachrichten, die ausschließlich zum Aufbau des dedizierten MessagePort verwendet werden. */
export type BridgeHandshakeMessage =
  | {
      namespace: typeof BUS_NAMESPACE;
      protocolVersion: typeof PROTOCOL_VERSION;
      type: "bridge:hello";
      channel: string;
      nonce: string;
      source: BusIdentity;
    }
  | {
      namespace: typeof BUS_NAMESPACE;
      protocolVersion: typeof PROTOCOL_VERSION;
      type: "bridge:ready";
      channel: string;
      nonce: string;
      acceptNonce: string;
      source: BusIdentity;
    }
  | {
      namespace: typeof BUS_NAMESPACE;
      protocolVersion: typeof PROTOCOL_VERSION;
      type: "bridge:connect";
      channel: string;
      nonce: string;
      acceptNonce: string;
      connectionId: string;
      source: BusIdentity;
    };

export interface BridgeAck {
  namespace: typeof BUS_NAMESPACE;
  protocolVersion: typeof PROTOCOL_VERSION;
  type: "bridge:ack";
  connectionId: string;
}

export function isBridgeHandshakeMessage(value: unknown): value is BridgeHandshakeMessage {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.namespace !== BUS_NAMESPACE ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    typeof value.type !== "string" ||
    typeof value.channel !== "string" ||
    typeof value.nonce !== "string" ||
    !isIdentity(value.source)
  ) {
    return false;
  }

  if (value.type === "bridge:hello") {
    return true;
  }

  if (value.type === "bridge:ready") {
    return typeof value.acceptNonce === "string";
  }

  if (value.type === "bridge:connect") {
    return (
      typeof value.acceptNonce === "string" &&
      typeof value.connectionId === "string" &&
      !!value.connectionId
    );
  }

  return false;
}

export function isBridgeAck(value: unknown): value is BridgeAck {
  return (
    isRecord(value) &&
    value.namespace === BUS_NAMESPACE &&
    value.protocolVersion === PROTOCOL_VERSION &&
    value.type === "bridge:ack" &&
    typeof value.connectionId === "string" &&
    !!value.connectionId
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIdentity(value: unknown): value is BusIdentity {
  return (
    isRecord(value) &&
    typeof value.instanceId === "string" &&
    !!value.instanceId &&
    (value.appId === undefined || (typeof value.appId === "string" && !!value.appId))
  );
}
