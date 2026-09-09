import { describe, expect, it } from "vitest";
import { createMessageBus, UnsupportedEnvironmentError } from "../src/index.js";
import {
  createPersistentLogExtension,
  persistentLog,
  type LoggedMessage,
  type PersistentLogReadOptions
} from "../src/extensions/persistent-log.js";
import type { LogStore } from "../src/extensions/indexed-db-log-store.js";
import { uniqueChannel } from "./helpers.js";

interface Messages {
  "document.open": { id: string };
  ignored: { value: number };
}

class MemoryLogStore implements LogStore {
  readonly messages = new Map<string, LoggedMessage>();

  async open(): Promise<void> {}

  async put(message: LoggedMessage): Promise<void> {
    this.messages.set(message.id, structuredClone(message));
  }

  async read(options: PersistentLogReadOptions): Promise<LoggedMessage[]> {
    let values = [...this.messages.values()].filter(message => {
      if (options.topic && message.topic !== options.topic) return false;
      if (options.since !== undefined && message.timestamp < options.since) return false;
      if (options.until !== undefined && message.timestamp > options.until) return false;
      return true;
    });
    values.sort((a, b) => a.timestamp - b.timestamp);
    if (options.order === "desc") values.reverse();
    return values.slice(0, options.limit ?? 1_000);
  }

  async clear(topic?: string): Promise<void> {
    if (!topic) {
      this.messages.clear();
      return;
    }
    for (const [id, message] of this.messages) {
      if (message.topic === topic) this.messages.delete(id);
    }
  }

  async cleanup(): Promise<void> {}
  close(): void {}
}

describe("persistent log extension", () => {
  it("logs configured public topics and can read/clear them", async () => {
    const store = new MemoryLogStore();
    const bus = createMessageBus<Messages>({ channel: uniqueChannel() });
    const log = bus.use(
      createPersistentLogExtension(
        { topics: ["document.open"] },
        () => store
      )
    );

    bus.publish("document.open", { id: "4711" });
    bus.publish("ignored", { value: 1 });
    await log.flush();

    const entries = await log.read({ topic: "document.open" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      topic: "document.open",
      payload: { id: "4711" },
      source: bus.identity
    });

    await log.clear("document.open");
    expect(await log.read()).toEqual([]);
    await bus.close();
  });

  it("fails explicitly when IndexedDB is unavailable", async () => {
    const bus = createMessageBus<Messages>({
      channel: uniqueChannel(),
      onError: () => undefined
    });
    const log = bus.use(persistentLog());

    await expect(log.ready()).rejects.toBeInstanceOf(UnsupportedEnvironmentError);
    await bus.close();
  });

});
