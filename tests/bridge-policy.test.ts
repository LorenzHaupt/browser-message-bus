import { describe, expect, it, vi } from "vitest";
import { InvalidConfigurationError } from "../src/index.js";
import { windowBridge } from "../src/bridge.js";
import { BUS_NAMESPACE, PROTOCOL_VERSION } from "../src/core/constants.js";
import type { BusEnvelope } from "../src/core/types.js";
import { MessagePortTransport } from "../src/transports/message-port-transport.js";
import { sleep, waitFor } from "./helpers.js";

function envelope(topic: string, system: boolean): BusEnvelope {
  return {
    namespace: BUS_NAMESPACE,
    protocolVersion: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    topic,
    payload: { value: topic },
    source: { instanceId: "remote" },
    timestamp: Date.now(),
    hop: 0,
    system
  };
}

function frame(connectionId: string, message: BusEnvelope): object {
  return {
    namespace: BUS_NAMESPACE,
    protocolVersion: PROTOCOL_VERSION,
    type: "bridge:envelope",
    connectionId,
    envelope: message
  };
}

describe("bridge policy", () => {
  it("uses deny-by-default once an allow-list policy is configured", async () => {
    const channel = new MessageChannel();
    const connectionId = crypto.randomUUID();
    const received: string[] = [];

    const transport = new MessagePortTransport(
      channel.port1,
      connectionId,
      ["public.allowed"],
      ["presence"],
      vi.fn()
    );

    transport.start(message => received.push(message.topic), () => undefined);
    channel.port2.start();

    channel.port2.postMessage(frame(connectionId, envelope("public.allowed", false)));
    channel.port2.postMessage(frame(connectionId, envelope("public.blocked", false)));
    channel.port2.postMessage(frame(connectionId, envelope("@bmb/ext/presence/announce", true)));
    channel.port2.postMessage(frame(connectionId, envelope("@bmb/ext/request-reply/request", true)));

    await waitFor(() => received.length === 2);
    await sleep(20);

    expect(received).toEqual([
      "public.allowed",
      "@bmb/ext/presence/announce"
    ]);

    transport.close(false);
    channel.port2.close();
  });

  it("allows all traffic when no bridge policy is configured", async () => {
    const channel = new MessageChannel();
    const connectionId = crypto.randomUUID();
    const received: string[] = [];

    const transport = new MessagePortTransport(
      channel.port1,
      connectionId,
      undefined,
      undefined,
      vi.fn()
    );

    transport.start(message => received.push(message.topic), () => undefined);
    channel.port2.start();

    channel.port2.postMessage(frame(connectionId, envelope("public.any", false)));
    channel.port2.postMessage(frame(connectionId, envelope("@bmb/ext/request-reply/request", true)));

    await waitFor(() => received.length === 2);
    expect(received).toEqual([
      "public.any",
      "@bmb/ext/request-reply/request"
    ]);

    transport.close(false);
    channel.port2.close();
  });

  it("rejects reserved system topics in the public topic allow-list", () => {
    expect(() =>
      windowBridge({
        targetWindow: {} as Window,
        origin: "https://example.test",
        mode: "connect",
        allowedTopics: ["@bmb/ext/presence/announce"]
      })
    ).toThrow(InvalidConfigurationError);
  });
});
