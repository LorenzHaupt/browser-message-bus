import { describe, expect, it } from "vitest";
import { createMessageBus, RequestTimeoutError } from "../src/index.js";
import { requestReply } from "../src/request-reply.js";
import { uniqueChannel } from "./helpers.js";

interface Messages {
  noop: undefined;
}

interface Requests {
  sum: {
    request: { a: number; b: number };
    response: { result: number };
  };
  fail: {
    request: undefined;
    response: undefined;
  };
  missing: {
    request: undefined;
    response: string;
  };
}

describe("request/reply extension", () => {
  it("performs a targeted request and response", async () => {
    const channel = uniqueChannel();
    const a = createMessageBus<Messages>({ channel });
    const b = createMessageBus<Messages>({ channel });
    const aRpc = a.use(requestReply<Requests>());
    const bRpc = b.use(requestReply<Requests>());

    bRpc.handle("sum", request => ({ result: request.a + request.b }));

    const result = await aRpc.request(
      "sum",
      { a: 2, b: 3 },
      { target: { instanceId: b.instanceId } }
    );

    expect(result).toEqual({ result: 5 });
    await Promise.all([a.close(), b.close()]);
  });

  it("propagates remote handler errors", async () => {
    const channel = uniqueChannel();
    const a = createMessageBus<Messages>({ channel });
    const b = createMessageBus<Messages>({ channel });
    const aRpc = a.use(requestReply<Requests>());
    const bRpc = b.use(requestReply<Requests>());

    bRpc.handle("fail", () => {
      throw new Error("remote boom");
    });

    await expect(
      aRpc.request("fail", undefined, { target: { instanceId: b.instanceId } })
    ).rejects.toMatchObject({
      name: "RemoteRequestError",
      message: "remote boom"
    });

    await Promise.all([a.close(), b.close()]);
  });

  it("times out when nobody handles the request", async () => {
    const bus = createMessageBus<Messages>({ channel: uniqueChannel() });
    const rpc = bus.use(requestReply<Requests>({ defaultTimeoutMs: 30 }));

    await expect(rpc.request("missing", undefined)).rejects.toBeInstanceOf(RequestTimeoutError);

    await bus.close();
  });
});
