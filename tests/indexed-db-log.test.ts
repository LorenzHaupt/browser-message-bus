import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createMessageBus } from "../src/index.js";
import { persistentLog } from "../src/persistent-log.js";
import { uniqueChannel } from "./helpers.js";

interface Messages {
  event: {
    nested: {
      value: number;
    };
  };
}

describe("IndexedDB persistent log", () => {
  it("writes, reads and clears messages through the real IndexedDbLogStore implementation", async () => {
    const databaseName = `bmb-test-${crypto.randomUUID()}`;
    const bus = createMessageBus<Messages>({ channel: uniqueChannel() });
    const log = bus.use(
      persistentLog({
        databaseName,
        maxAgeMs: 60_000,
        maxEntries: 100
      })
    );

    await log.ready();
    bus.publish("event", { nested: { value: 42 } });
    await log.flush();

    const entries = await log.read({ topic: "event" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toEqual({ nested: { value: 42 } });

    await log.clear("event");
    expect(await log.read()).toEqual([]);

    await bus.close();
  });
});
