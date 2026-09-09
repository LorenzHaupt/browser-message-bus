import { describe, expect, it } from "vitest";
import {
  InvalidConfigurationError,
  RequestAbortedError,
  createMessageBus
} from "../src/index.js";
import { requestReply } from "../src/request-reply.js";
import { sleep, uniqueChannel } from "./helpers.js";

interface Messages {
  noop: undefined;
}

interface Requests {
  choose: {
    request: undefined;
    response: string;
  };
}

describe("request/reply hardening", () => {
  it("uses first-response-wins semantics for an untargeted request", async () => {
    const channel = uniqueChannel();
    const caller = createMessageBus<Messages>({ channel });
    const fast = createMessageBus<Messages>({ channel });
    const slow = createMessageBus<Messages>({ channel });

    const callerRpc = caller.use(requestReply<Requests>());
    const fastRpc = fast.use(requestReply<Requests>());
    const slowRpc = slow.use(requestReply<Requests>());

    fastRpc.handle("choose", () => "fast");
    slowRpc.handle("choose", async () => {
      await sleep(50);
      return "slow";
    });

    const result = await callerRpc.request("choose");
    expect(result).toBe("fast");

    await Promise.all([caller.close(), fast.close(), slow.close()]);
  });

  it("rejects an aborted request", async () => {
    const bus = createMessageBus<Messages>({ channel: uniqueChannel() });
    const rpc = bus.use(requestReply<Requests>());
    const controller = new AbortController();
    controller.abort();

    await expect(
      rpc.request("choose", undefined, { signal: controller.signal })
    ).rejects.toBeInstanceOf(RequestAbortedError);

    await bus.close();
  });

  it("does not emit a late response after the extension is disposed", async () => {
    const channel = uniqueChannel();
    const errors: unknown[] = [];
    const caller = createMessageBus<Messages>({ channel, onError: error => errors.push(error) });
    const responder = createMessageBus<Messages>({ channel, onError: error => errors.push(error) });
    const callerRpc = caller.use(requestReply<Requests>({ defaultTimeoutMs: 80 }));
    const responderRpc = responder.use(requestReply<Requests>());

    responderRpc.handle("choose", async () => {
      await sleep(40);
      return "late";
    });

    const pending = callerRpc.request("choose", undefined, {
      target: { instanceId: responder.instanceId }
    });

    await sleep(10);
    await responder.close();
    await expect(pending).rejects.toBeDefined();
    expect(errors).toEqual([]);

    await caller.close();
  });

  it("rejects invalid timeout configuration", async () => {
    const bus = createMessageBus<Messages>({ channel: uniqueChannel() });

    expect(() => bus.use(requestReply<Requests>({ defaultTimeoutMs: 0 }))).toThrow(
      InvalidConfigurationError
    );

    await bus.close();
  });
});
