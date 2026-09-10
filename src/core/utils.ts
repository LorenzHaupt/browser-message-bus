import {
  InvalidConfigurationError,
  InvalidTopicError,
  PayloadCloneError,
  UnsupportedEnvironmentError
} from "./errors.js";
import { RESERVED_TOPIC_PREFIX } from "./constants.js";
import type { BusIdentity, MessageTarget } from "./types.js";

export function assertNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new InvalidConfigurationError(`${name} must be a non-empty string.`);
  }
  return trimmed;
}

export function assertPublicTopic(topic: string): void {
  if (!topic.trim() || topic.startsWith(RESERVED_TOPIC_PREFIX)) {
    throw new InvalidTopicError(topic);
  }
}

export function assertExtensionId(id: string): string {
  const normalized = id.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(normalized)) {
    throw new InvalidConfigurationError(
      `Invalid extension id \"${id}\". Use letters, numbers, dots, underscores or dashes.`
    );
  }
  return normalized;
}

export function createInstanceId(): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new UnsupportedEnvironmentError("crypto.randomUUID()");
  }
  return crypto.randomUUID();
}

/**
 * Nutzt denselben Structured-Clone-Mechanismus, auf dem auch die Browser-Transporte basieren.
 * Nicht transportierbare Werte werden früh und mit einem domänenspezifischen Fehler abgelehnt.
 */
export function cloneForTransport<T>(value: T): T {
  if (typeof structuredClone !== "function") {
    throw new UnsupportedEnvironmentError("structuredClone()");
  }

  try {
    return structuredClone(value);
  } catch (error) {
    throw new PayloadCloneError(error);
  }
}

export function normalizeTarget(target: MessageTarget | undefined): MessageTarget | undefined {
  if (!target) {
    return undefined;
  }

  const instanceId = target.instanceId?.trim();
  const appId = target.appId?.trim();
  if (!instanceId && !appId) {
    throw new InvalidConfigurationError("target must contain a non-empty instanceId or appId.");
  }

  return {
    ...(instanceId ? { instanceId } : {}),
    ...(appId ? { appId } : {})
  };
}

/** Prüft ausschließlich die Routing-Semantik eines Targets; eine Autorisierungsentscheidung ist das nicht. */
export function matchesTarget(
  target: MessageTarget | undefined,
  identity: BusIdentity
): boolean {
  if (!target) {
    return true;
  }

  if (target.instanceId && target.instanceId !== identity.instanceId) {
    return false;
  }

  if (target.appId && target.appId !== identity.appId) {
    return false;
  }

  return true;
}

export function freezeIdentity(identity: BusIdentity): BusIdentity {
  return Object.freeze({ ...identity });
}

export function freezeTarget(target: MessageTarget | undefined): MessageTarget | undefined {
  return target ? Object.freeze({ ...target }) : undefined;
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
