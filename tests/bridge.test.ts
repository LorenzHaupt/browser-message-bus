import { describe, expect, it, vi } from "vitest";
import { BridgeSecurityError, BridgeTimeoutError, createMessageBus } from "../src/index.js";
import { windowBridge } from "../src/bridge.js";
import { BUS_NAMESPACE, PROTOCOL_VERSION } from "../src/core/constants.js";
import type { BusEnvelope, BusIdentity } from "../src/core/types.js";
import { uniqueChannel, waitFor } from "./helpers.js";

interface Messages {
  ping: { value: number };
}

class FakeLocalWindow {
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== "message") return;
    this.listeners.add(listener as (event: MessageEvent<unknown>) => void);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== "message") return;
    this.listeners.delete(listener as (event: MessageEvent<unknown>) => void);
  }

  emit(data: unknown, source: Window, origin: string, ports: readonly MessagePort[] = []): void {
    const event = {
      data,
      source,
      origin,
      ports
    } as unknown as MessageEvent<unknown>;
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

interface RemoteHarness {
  readonly window: Window;
  readonly identity: BusIdentity;
  get port(): MessagePort | undefined;
  get connectionId(): string | undefined;
  readonly received: BusEnvelope[];
  sendEnvelope(envelope: BusEnvelope): void;
  closeRemote(): void;
}

function createRemoteHarness(
  local: FakeLocalWindow,
  origin: string,
  channel: string
): RemoteHarness {
  const identity: BusIdentity = { instanceId: crypto.randomUUID(), appId: "remote" };
  let remotePort: MessagePort | undefined;
  let connectionId: string | undefined;
  const received: BusEnvelope[] = [];

  const target = {
    postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]) {
      expect(targetOrigin).toBe(origin);
      const value = message as Record<string, unknown>;

      if (value.type === "bridge:hello") {
        queueMicrotask(() => {
          local.emit(
            {
              namespace: BUS_NAMESPACE,
              protocolVersion: PROTOCOL_VERSION,
              type: "bridge:ready",
              channel,
              nonce: value.nonce,
              acceptNonce: "accept-nonce",
              source: identity
            },
            target as unknown as Window,
            origin
          );
        });
      }

      if (value.type === "bridge:connect") {
        connectionId = value.connectionId as string;
        remotePort = transfer?.[0] as MessagePort;
        remotePort.addEventListener("message", event => {
          const frame = event.data as Record<string, unknown>;
          if (frame.type === "bridge:envelope") {
            received.push(frame.envelope as BusEnvelope);
          }
        });
        remotePort.start();
        queueMicrotask(() => {
          remotePort?.postMessage({
            namespace: BUS_NAMESPACE,
            protocolVersion: PROTOCOL_VERSION,
            type: "bridge:ack",
            connectionId
          });
        });
      }
    }
  } as unknown as Window;

  return {
    window: target,
    identity,
    get port() {
      return remotePort;
    },
    get connectionId() {
      return connectionId;
    },
    received,
    sendEnvelope(envelope) {
      if (!remotePort || !connectionId) throw new Error("Bridge is not connected.");
      remotePort.postMessage({
        namespace: BUS_NAMESPACE,
        protocolVersion: PROTOCOL_VERSION,
        type: "bridge:envelope",
        connectionId,
        envelope
      });
    },
    closeRemote() {
      remotePort?.close();
    }
  };
}

describe("window bridge", () => {
  it("requires an explicit exact origin", async () => {
    const bus = createMessageBus<Messages>({ channel: uniqueChannel() });
    const fake = new FakeLocalWindow();

    await expect(
      bus.connect(
        windowBridge({
          targetWindow: {} as Window,
          localWindow: fake as unknown as Window,
          origin: "*",
          mode: "connect"
        })
      )
    ).rejects.toBeInstanceOf(BridgeSecurityError);

    await bus.close();
  });

  it("ignores a handshake response from the wrong origin", async () => {
    const channel = uniqueChannel();
    const bus = createMessageBus<Messages>({ channel });
    const local = new FakeLocalWindow();
    const target = {
      postMessage(message: unknown) {
        const value = message as Record<string, unknown>;
        if (value.type === "bridge:hello") {
          queueMicrotask(() => {
            local.emit(
              {
                namespace: BUS_NAMESPACE,
                protocolVersion: PROTOCOL_VERSION,
                type: "bridge:ready",
                channel,
                nonce: value.nonce,
                acceptNonce: "x",
                source: { instanceId: "evil" }
              },
              target as unknown as Window,
              "https://evil.example"
            );
          });
        }
      }
    } as unknown as Window;

    await expect(
      bus.connect(
        windowBridge({
          targetWindow: target,
          localWindow: local as unknown as Window,
          origin: "https://trusted.example",
          mode: "connect",
          timeoutMs: 40
        })
      )
    ).rejects.toBeInstanceOf(BridgeTimeoutError);

    await bus.close();
  });

  it("exposes a closed promise when the remote MessagePort disappears", async () => {
    const channel = uniqueChannel();
    const origin = "https://remote.example";
    const hostWindow = new FakeLocalWindow();
    const remote = createRemoteHarness(hostWindow, origin, channel);
    const host = createMessageBus<Messages>({ channel });

    const connection = await host.connect(
      windowBridge({
        targetWindow: remote.window,
        localWindow: hostWindow as unknown as Window,
        origin,
        mode: "connect"
      })
    );

    expect(connection.connected).toBe(true);
    remote.closeRemote();

    await connection.closed;
    expect(connection.connected).toBe(false);

    await host.close();
  });

  it("routes messages between a bridged remote context and another same-origin tab", async () => {
    const channel = uniqueChannel();
    const origin = "https://remote.example";
    const hostWindow = new FakeLocalWindow();
    const remote = createRemoteHarness(hostWindow, origin, channel);
    const hostA = createMessageBus<Messages>({ channel, appId: "host" });
    const hostB = createMessageBus<Messages>({ channel, appId: "host" });

    const connection = await hostA.connect(
      windowBridge({
        targetWindow: remote.window,
        localWindow: hostWindow as unknown as Window,
        origin,
        mode: "connect"
      })
    );

    expect(connection.remote).toEqual(remote.identity);

    const seenByB = vi.fn();
    hostB.subscribe("ping", seenByB);

    const inbound: BusEnvelope = {
      namespace: BUS_NAMESPACE,
      protocolVersion: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      topic: "ping",
      payload: { value: 11 },
      source: remote.identity,
      target: { instanceId: hostB.instanceId },
      timestamp: Date.now(),
      hop: 0,
      system: false
    };
    remote.sendEnvelope(inbound);
    remote.sendEnvelope(inbound); // duplicate id must be suppressed

    await waitFor(() => seenByB.mock.calls.length === 1);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(seenByB).toHaveBeenCalledTimes(1);
    expect(seenByB.mock.calls[0]?.[0]).toEqual({ value: 11 });

    hostB.publish("ping", { value: 22 }, { target: { instanceId: remote.identity.instanceId } });
    await waitFor(() => remote.received.some(message => (message.payload as { value: number }).value === 22));

    await connection.close();
    await Promise.all([hostA.close(), hostB.close()]);
  });

  it("does not forward a message after its concrete local target has been reached", async () => {
    const channel = uniqueChannel();
    const origin = "https://remote.example";
    const hostWindow = new FakeLocalWindow();
    const remote = createRemoteHarness(hostWindow, origin, channel);
    const host = createMessageBus<Messages>({ channel, instanceId: "host-target" });
    const local = vi.fn();
    host.subscribe("ping", local);

    await host.connect(
      windowBridge({
        targetWindow: remote.window,
        localWindow: hostWindow as unknown as Window,
        origin,
        mode: "connect"
      })
    );

    host.publish("ping", { value: 33 }, { target: { instanceId: host.instanceId } });

    await waitFor(() => local.mock.calls.length === 1);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(remote.received).toHaveLength(0);

    await host.close();
  });

});
