export const BUS_NAMESPACE = "browser-message-bus" as const;
export const PROTOCOL_VERSION = 1 as const;
export const RESERVED_TOPIC_PREFIX = "@bmb/";
export const DEFAULT_MAX_HOPS = 16;
export const DEFAULT_DEDUPE_MAX_ENTRIES = 10_000;
export const DEFAULT_DEDUPE_TTL_MS = 5 * 60_000;
