import { describe, expect, it, vi } from "vitest";
import {
  BusClosedError,
  InvalidConfigurationError,
  InvalidTopicError,
  PayloadCloneError,
  createMessageBus
} from "../src/index.js";
import { sleep, uniqueChannel, waitFor } from "./helpers.js";

interface Messages {
  ping: { value: number };
  close: undefined;
}

describe("message bus core", () => {
  it("delivers locally without additional configuration", async () => {
    const bus = createMessageBus<Messages>({ channel: uniqueChannel() });
    const values: number[] = [];
    bus.subscribe("ping", payload => {
      values.push(payload.value);
    });

    const receipt = bus.publish("ping", { value: 42 });

    expect(receipt.messageId).toBeTruthy();
    await waitFor(() => values.length === 1);
    expect(values).toEqual([42]);
    await bus.close();
  });

  it("communicates between same-channel instances through BroadcastChannel", async () => {
    const channel = uniqueChannel();
    const a = createMessageBus<Messages>({ channel });
    const b = createMessageBus<Messages>({ channel });
    let received = 0;
    b.subscribe("ping", payload => {
      received = payload.value;
    });

    a.publish("ping", { value: 7 });

    await waitFor(() => received === 7);
    await Promise.all([a.close(), b.close()]);
  });

  it("isolates different channels", async () => {
    const a = createMessageBus<Messages>({ channel: uniqueChannel("a") });
    const b = createMessageBus<Messages>({ channel: uniqueChannel("b") });
    const handler = vi.fn();
    b.subscribe("ping", handler);

    a.publish("ping", { value: 1 });
    await sleep(50);

    expect(handler).not.toHaveBeenCalled();
    await Promise.all([a.close(), b.close()]);
  });

  it("targets one concrete instance", async () => {
    const channel = uniqueChannel();
    const sender = createMessageBus<Messages>({ channel, appId: "host" });
    const a = createMessageBus<Messages>({ channel, appId: "viewer" });
    const b = createMessageBus<Messages>({ channel, appId: "viewer" });
    const seenA = vi.fn();
    const seenB = vi.fn();
    a.subscribe("ping", seenA);
    b.subscribe("ping", seenB);

    sender.publish("ping", { value: 5 }, { target: { instanceId: b.instanceId } });

    await waitFor(() => seenB.mock.calls.length === 1);
    await sleep(30);
    expect(seenA).not.toHaveBeenCalled();
    expect(seenB).toHaveBeenCalledWith(
      { value: 5 },
      expect.objectContaining({ source: sender.identity })
    );
    await Promise.all([sender.close(), a.close(), b.close()]);
  });

  it("targets all instances with a matching appId", async () => {
    const channel = uniqueChannel();
    const sender = createMessageBus<Messages>({ channel, appId: "host" });
    const viewerA = createMessageBus<Messages>({ channel, appId: "viewer" });
    const viewerB = createMessageBus<Messages>({ channel, appId: "viewer" });
    const editor = createMessageBus<Messages>({ channel, appId: "editor" });
    const a = vi.fn();
    const b = vi.fn();
    const e = vi.fn();
    viewerA.subscribe("close", a);
    viewerB.subscribe("close", b);
    editor.subscribe("close", e);

    sender.publish("close", undefined, { target: { appId: "viewer" } });

    await waitFor(() => a.mock.calls.length === 1 && b.mock.calls.length === 1);
    await sleep(30);
    expect(e).not.toHaveBeenCalled();
    await Promise.all([sender.close(), viewerA.close(), viewerB.close(), editor.close()]);
  });

  it("does not let a slow subscriber block another subscriber", async () => {
    const bus = createMessageBus<Messages>({ channel: uniqueChannel() });
    let release!: () => void;
    const blocker = new Promise<void>(resolve => {
      release = resolve;
    });
    let fastRan = false;

    bus.subscribe("ping", async () => {
      await blocker;
    });
    bus.subscribe("ping", () => {
      fastRan = true;
    });

    bus.publish("ping", { value: 1 });
    await waitFor(() => fastRan);
    release();
    await bus.close();
  });

  it("rejects reserved public topics and invalid targets", async () => {
    const bus = createMessageBus<Record<string, unknown>>({ channel: uniqueChannel() });

    expect(() => bus.publish("@bmb/internal", {})).toThrow(InvalidTopicError);
    expect(() => bus.publish("x", {}, { target: {} })).toThrow(InvalidConfigurationError);

    await bus.close();
  });

  it("rejects payloads that structuredClone cannot transport", async () => {
    const bus = createMessageBus<{ bad: { fn: () => void } }>({ channel: uniqueChannel() });

    expect(() => bus.publish("bad", { fn: () => undefined })).toThrow(PayloadCloneError);

    await bus.close();
  });

  it("is idempotent on close and rejects further use", async () => {
    const bus = createMessageBus<Messages>({ channel: uniqueChannel() });

    await bus.close();
    await bus.close();

    expect(() => bus.publish("ping", { value: 1 })).toThrow(BusClosedError);
  });
});
