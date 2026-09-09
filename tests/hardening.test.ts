import { describe, expect, it, vi } from "vitest";
import { createMessageBus } from "../src/index.js";
import type { MessageBusExtension, ObservedMessage } from "../src/core/types.js";
import { sleep, uniqueChannel, waitFor } from "./helpers.js";

interface Messages {
  mutate: {
    nested: {
      value: number;
    };
  };
  ordered: {
    value: number;
  };
}

describe("core hardening", () => {
  it("gives every local subscriber an isolated structured-clone payload snapshot", async () => {
    const bus = createMessageBus<Messages>({ channel: uniqueChannel() });
    const secondSubscriber = vi.fn();

    bus.subscribe("mutate", payload => {
      payload.nested.value = 999;
    });

    bus.subscribe("mutate", payload => {
      secondSubscriber(payload.nested.value);
    });

    bus.publish("mutate", { nested: { value: 42 } });

    await waitFor(() => secondSubscriber.mock.calls.length === 1);
    expect(secondSubscriber).toHaveBeenCalledWith(42);

    await bus.close();
  });

  it("isolates observer payload snapshots from other extensions", async () => {
    const bus = createMessageBus<Messages>({ channel: uniqueChannel() });
    let observedValue: number | undefined;

    const mutatingObserver: MessageBusExtension<void> = {
      id: "mutating-observer",
      install(context) {
        const unsubscribe = context.observe(message => {
          const payload = message.payload as Messages["mutate"];
          payload.nested.value = 777;
        });
        return { api: undefined, dispose: unsubscribe };
      }
    };

    const recordingObserver: MessageBusExtension<void> = {
      id: "recording-observer",
      install(context) {
        const unsubscribe = context.observe((message: ObservedMessage) => {
          observedValue = (message.payload as Messages["mutate"]).nested.value;
        });
        return { api: undefined, dispose: unsubscribe };
      }
    };

    bus.use(mutatingObserver);
    bus.use(recordingObserver);
    bus.publish("mutate", { nested: { value: 12 } });

    expect(observedValue).toBe(12);
    await bus.close();
  });

  it("preserves FIFO order within one asynchronous subscription", async () => {
    const bus = createMessageBus<Messages>({ channel: uniqueChannel() });
    const order: number[] = [];

    bus.subscribe("ordered", async payload => {
      if (payload.value === 1) {
        await sleep(30);
      }
      order.push(payload.value);
    });

    bus.publish("ordered", { value: 1 });
    bus.publish("ordered", { value: 2 });

    await waitFor(() => order.length === 2);
    expect(order).toEqual([1, 2]);

    await bus.close();
  });

  it("automatically unsubscribes when the supplied AbortSignal aborts", async () => {
    const bus = createMessageBus<Messages>({ channel: uniqueChannel() });
    const controller = new AbortController();
    const handler = vi.fn();

    bus.subscribe("ordered", handler, { signal: controller.signal });
    controller.abort();
    bus.publish("ordered", { value: 1 });

    await sleep(20);
    expect(handler).not.toHaveBeenCalled();

    await bus.close();
  });
});
