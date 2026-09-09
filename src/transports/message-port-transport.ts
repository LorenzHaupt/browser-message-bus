import { BUS_NAMESPACE, PROTOCOL_VERSION } from "../core/constants.js";
import { isBusEnvelope } from "../core/envelope.js";
import { InvalidEnvelopeError } from "../core/errors.js";
import type { BusEnvelope, BusTransport, MessageBusErrorHandler } from "../core/types.js";

interface EnvelopeFrame {
  namespace: typeof BUS_NAMESPACE;
  protocolVersion: typeof PROTOCOL_VERSION;
  type: "bridge:envelope";
  connectionId: string;
  envelope: BusEnvelope;
}

interface CloseFrame {
  namespace: typeof BUS_NAMESPACE;
  protocolVersion: typeof PROTOCOL_VERSION;
  type: "bridge:close";
  connectionId: string;
}


export class MessagePortTransport implements BusTransport {
  readonly kind = "message-port";
  readonly id: string;

  private receive: ((envelope: BusEnvelope) => void) | undefined;
  private remoteClose: (() => void) | undefined;
  private isClosed = false;
  private readonly allowedTopics?: ReadonlySet<string>;
  private readonly allowedExtensions?: ReadonlySet<string>;
  private readonly hasExplicitPolicy: boolean;

  constructor(
    private readonly port: MessagePort,
    private readonly connectionId: string,
    allowedTopics: readonly string[] | undefined,
    allowedExtensions: readonly string[] | undefined,
    private readonly reportError: MessageBusErrorHandler
  ) {
    this.id = `bridge:${connectionId}`;
    this.hasExplicitPolicy = allowedTopics !== undefined || allowedExtensions !== undefined;
    if (allowedTopics) {
      this.allowedTopics = new Set(allowedTopics);
    }
    if (allowedExtensions) {
      this.allowedExtensions = new Set(allowedExtensions);
    }
  }

  start(
    receive: (envelope: BusEnvelope) => void,
    remoteClose: () => void
  ): void {
    this.receive = receive;
    this.remoteClose = remoteClose;
    this.port.addEventListener("message", this.onMessage);
    this.port.addEventListener("messageerror", this.onMessageError);
    this.port.start();
  }

  send(envelope: BusEnvelope): void {
    if (this.isClosed || !this.isAllowed(envelope)) {
      return;
    }

    const frame: EnvelopeFrame = {
      namespace: BUS_NAMESPACE,
      protocolVersion: PROTOCOL_VERSION,
      type: "bridge:envelope",
      connectionId: this.connectionId,
      envelope
    };
    this.port.postMessage(frame);
  }

  close(notifyRemote = true): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    if (notifyRemote) {
      const frame: CloseFrame = {
        namespace: BUS_NAMESPACE,
        protocolVersion: PROTOCOL_VERSION,
        type: "bridge:close",
        connectionId: this.connectionId
      };
      try {
        this.port.postMessage(frame);
      } catch {
        // The remote side may already be gone.
      }
    }

    this.port.removeEventListener("message", this.onMessage);
    this.port.removeEventListener("messageerror", this.onMessageError);
    this.port.close();
    this.receive = undefined;
    this.remoteClose = undefined;
  }

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    const value = event.data;
    if (!isRecord(value) || value.connectionId !== this.connectionId) {
      return;
    }

    if (
      value.namespace !== BUS_NAMESPACE ||
      value.protocolVersion !== PROTOCOL_VERSION ||
      typeof value.type !== "string"
    ) {
      return;
    }

    if (value.type === "bridge:close") {
      this.isClosed = true;
      this.port.removeEventListener("message", this.onMessage);
      this.port.removeEventListener("messageerror", this.onMessageError);
      this.port.close();
      this.remoteClose?.();
      return;
    }

    if (value.type !== "bridge:envelope" || !isBusEnvelope(value.envelope)) {
      this.reportError(new InvalidEnvelopeError("Bridge received an invalid envelope."), {
        phase: "protocol",
        transportId: this.id
      });
      return;
    }

    if (!this.isAllowed(value.envelope)) {
      return;
    }

    this.receive?.(value.envelope);
  };

  private readonly onMessageError = (): void => {
    this.reportError(new InvalidEnvelopeError("Bridge could not deserialize a message."), {
      phase: "bridge",
      transportId: this.id
    });
  };

  private isAllowed(envelope: BusEnvelope): boolean {
    if (!this.hasExplicitPolicy) {
      return true;
    }

    if (!envelope.system) {
      return this.allowedTopics?.has(envelope.topic) ?? false;
    }

    const extensionId = extensionIdFromSystemTopic(envelope.topic);
    return extensionId !== undefined && (this.allowedExtensions?.has(extensionId) ?? false);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extensionIdFromSystemTopic(topic: string): string | undefined {
  const prefix = "@bmb/ext/";
  if (!topic.startsWith(prefix)) {
    return undefined;
  }

  const rest = topic.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }

  return rest.slice(0, slash);
}
