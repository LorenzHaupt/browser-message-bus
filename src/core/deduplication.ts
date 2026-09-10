import {
  DEFAULT_DEDUPE_MAX_ENTRIES,
  DEFAULT_DEDUPE_TTL_MS
} from "./constants.js";

/**
 * Merkt sich kürzlich gesehene messageIds. Der begrenzte Cache verhindert Mehrfachverarbeitung über mehrere Routen,
 * ohne dauerhaft mit der Laufzeit des Prozesses zu wachsen.
 */
export class DeduplicationCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly maxEntries = DEFAULT_DEDUPE_MAX_ENTRIES,
    private readonly ttlMs = DEFAULT_DEDUPE_TTL_MS
  ) {}

  hasOrAdd(id: string, now = Date.now()): boolean {
    this.cleanup(now);

    if (this.seen.has(id)) {
      return true;
    }

    this.seen.set(id, now);
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (oldest) {
        this.seen.delete(oldest);
      }
    }

    return false;
  }

  clear(): void {
    this.seen.clear();
  }

  private cleanup(now: number): void {
    const cutoff = now - this.ttlMs;
    for (const [id, timestamp] of this.seen) {
      if (timestamp >= cutoff) {
        break;
      }
      this.seen.delete(id);
    }
  }
}
