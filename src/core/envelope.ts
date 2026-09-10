import { BUS_NAMESPACE, PROTOCOL_VERSION, RESERVED_TOPIC_PREFIX } from "./constants.js";
import type { BusEnvelope, BusIdentity, MessageTarget } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIdentity(value: unknown): value is BusIdentity {
  if (!isRecord(value) || typeof value.instanceId !== "string" || !value.instanceId) {
    return false;
  }
  return value.appId === undefined || (typeof value.appId === "string" && !!value.appId);
}

function isTarget(value: unknown): value is MessageTarget {
  if (!isRecord(value)) {
    return false;
  }

  const validInstance =
    value.instanceId === undefined ||
    (typeof value.instanceId === "string" && !!value.instanceId);
  const validApp =
    value.appId === undefined || (typeof value.appId === "string" && !!value.appId);

  return validInstance && validApp && (value.instanceId !== undefined || value.appId !== undefined);
}

/**
 * Runtime-Grenze für Daten aus Transporten. Geprüft wird das technische Envelope, nicht die fachliche Form der Payload.
 */
export function isBusEnvelope(value: unknown): value is BusEnvelope {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.namespace === BUS_NAMESPACE &&
    value.protocolVersion === PROTOCOL_VERSION &&
    typeof value.id === "string" &&
    !!value.id &&
    typeof value.topic === "string" &&
    !!value.topic &&
    ((value.system === true && value.topic.startsWith(RESERVED_TOPIC_PREFIX)) ||
      (value.system === false && !value.topic.startsWith(RESERVED_TOPIC_PREFIX))) &&
    isIdentity(value.source) &&
    (value.target === undefined || isTarget(value.target)) &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp) &&
    typeof value.hop === "number" &&
    Number.isInteger(value.hop) &&
    value.hop >= 0 &&
    typeof value.system === "boolean"
  );
}
