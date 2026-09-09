import { BUS_NAMESPACE, PROTOCOL_VERSION } from "../core/constants.js";
import {
  BridgeSecurityError,
  BridgeTimeoutError,
  InvalidConfigurationError,
  UnsupportedEnvironmentError
} from "../core/errors.js";
import type {
  BusConnector,
  ConnectorContext,
  ConnectorResult
} from "../core/types.js";
import { createInstanceId } from "../core/utils.js";
import { MessagePortTransport } from "../transports/message-port-transport.js";
import type { WindowBridgeOptions } from "./types.js";
import {
  isBridgeAck,
  isBridgeHandshakeMessage,
  type BridgeHandshakeMessage
} from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const HELLO_RETRY_MS = 250;

class WindowBridgeConnector implements BusConnector {
  readonly kind = "window";

  constructor(private readonly options: WindowBridgeOptions) {}

  connect(context: ConnectorContext): Promise<ConnectorResult> {
    const localWindow = this.options.localWindow ?? getCurrentWindow();
    const origin = normalizeOrigin(this.options.origin);
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (this.options.mode === "connect") {
      return connectToWindow(localWindow, this.options.targetWindow, origin, timeoutMs, this.options.allowedTopics, context);
    }

    return acceptFromWindow(localWindow, this.options.targetWindow, origin, timeoutMs, this.options.allowedTopics, context);
  }
}

export function windowBridge(options: WindowBridgeOptions): BusConnector {
  return new WindowBridgeConnector(options);
}

async function connectToWindow(
  localWindow: Window,
  targetWindow: Window,
  origin: string,
  timeoutMs: number,
  allowedTopics: readonly string[] | undefined,
  context: ConnectorContext
): Promise<ConnectorResult> {
  const nonce = createInstanceId();
  const hello: BridgeHandshakeMessage = {
    namespace: BUS_NAMESPACE,
    protocolVersion: PROTOCOL_VERSION,
    type: "bridge:hello",
    channel: context.channel,
    nonce,
    source: context.identity
  };

  return new Promise<ConnectorResult>((resolve, reject) => {
    let settled = false;
    let retry: ReturnType<typeof setInterval> | undefined;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (retry) {
        clearInterval(retry);
      }
      localWindow.removeEventListener("message", onMessage);
      callback();
    };

    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== targetWindow || event.origin !== origin) {
        return;
      }
      if (!isBridgeHandshakeMessage(event.data) || event.data.type !== "bridge:ready") {
        return;
      }
      if (event.data.channel !== context.channel || event.data.nonce !== nonce) {
        return;
      }

      const ready = event.data;
      const connectionId = createInstanceId();
      const channel = new MessageChannel();
      const port = channel.port1;

      const ackTimeout = setTimeout(() => {
        port.close();
        finish(() => reject(new BridgeTimeoutError(timeoutMs)));
      }, timeoutMs);

      const onAck = (ackEvent: MessageEvent<unknown>): void => {
        if (!isBridgeAck(ackEvent.data) || ackEvent.data.connectionId !== connectionId) {
          return;
        }

        clearTimeout(ackTimeout);
        port.removeEventListener("message", onAck);
        finish(() => {
          resolve({
            remote: ready.source,
            transport: new MessagePortTransport(
              port,
              connectionId,
              allowedTopics,
              context.reportError
            )
          });
        });
      };

      port.addEventListener("message", onAck);
      port.start();

      const connectMessage: BridgeHandshakeMessage = {
        namespace: BUS_NAMESPACE,
        protocolVersion: PROTOCOL_VERSION,
        type: "bridge:connect",
        channel: context.channel,
        nonce,
        acceptNonce: ready.acceptNonce,
        connectionId,
        source: context.identity
      };

      targetWindow.postMessage(connectMessage, origin, [channel.port2]);
    };

    localWindow.addEventListener("message", onMessage);

    const sendHello = (): void => {
      try {
        targetWindow.postMessage(hello, origin);
      } catch (error) {
        finish(() => reject(error));
      }
    };

    const timeout = setTimeout(
      () => finish(() => reject(new BridgeTimeoutError(timeoutMs))),
      timeoutMs
    );
    retry = setInterval(sendHello, HELLO_RETRY_MS);
    sendHello();
  });
}

async function acceptFromWindow(
  localWindow: Window,
  targetWindow: Window,
  origin: string,
  timeoutMs: number,
  allowedTopics: readonly string[] | undefined,
  context: ConnectorContext
): Promise<ConnectorResult> {
  return new Promise<ConnectorResult>((resolve, reject) => {
    let activeNonce: string | undefined;
    let acceptNonce: string | undefined;
    let remoteIdentity: ConnectorResult["remote"] | undefined;

    const timeout = setTimeout(() => {
      localWindow.removeEventListener("message", onMessage);
      reject(new BridgeTimeoutError(timeoutMs));
    }, timeoutMs);

    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== targetWindow || event.origin !== origin) {
        return;
      }
      if (!isBridgeHandshakeMessage(event.data)) {
        return;
      }
      if (event.data.channel !== context.channel) {
        return;
      }

      if (event.data.type === "bridge:hello") {
        if (!activeNonce || activeNonce !== event.data.nonce) {
          activeNonce = event.data.nonce;
          acceptNonce = createInstanceId();
          remoteIdentity = event.data.source;
        }

        const ready: BridgeHandshakeMessage = {
          namespace: BUS_NAMESPACE,
          protocolVersion: PROTOCOL_VERSION,
          type: "bridge:ready",
          channel: context.channel,
          nonce: activeNonce,
          acceptNonce: acceptNonce!,
          source: context.identity
        };
        targetWindow.postMessage(ready, origin);
        return;
      }

      if (event.data.type !== "bridge:connect") {
        return;
      }

      if (
        !activeNonce ||
        !acceptNonce ||
        event.data.nonce !== activeNonce ||
        event.data.acceptNonce !== acceptNonce ||
        !remoteIdentity ||
        event.data.source.instanceId !== remoteIdentity.instanceId ||
        event.data.source.appId !== remoteIdentity.appId ||
        event.ports.length !== 1
      ) {
        return;
      }

      const port = event.ports[0];
      if (!port) {
        return;
      }

      const ack = {
        namespace: BUS_NAMESPACE,
        protocolVersion: PROTOCOL_VERSION,
        type: "bridge:ack" as const,
        connectionId: event.data.connectionId
      };
      port.postMessage(ack);

      clearTimeout(timeout);
      localWindow.removeEventListener("message", onMessage);
      resolve({
        remote: remoteIdentity,
        transport: new MessagePortTransport(
          port,
          event.data.connectionId,
          allowedTopics,
          context.reportError
        )
      });
    };

    localWindow.addEventListener("message", onMessage);
  });
}

function normalizeOrigin(origin: string): string {
  if (origin === "*" || origin === "null") {
    throw new BridgeSecurityError("Bridge origin must be an explicit HTTP(S) origin and may not be \"*\" or \"null\".");
  }

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new InvalidConfigurationError(`Invalid bridge origin \"${origin}\".`);
  }

  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== origin) {
    throw new BridgeSecurityError(
      `Bridge origin must be an exact HTTP(S) origin without path, query or fragment. Received \"${origin}\".`
    );
  }

  return url.origin;
}

function getCurrentWindow(): Window {
  if (typeof window === "undefined") {
    throw new UnsupportedEnvironmentError("window");
  }
  return window;
}
