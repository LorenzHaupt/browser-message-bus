import { UnsupportedEnvironmentError } from "../core/errors.js";
import type { BusEnvelope, BusTransport, MessageBusErrorHandler } from "../core/types.js";

/**
 * Standardtransport für Browser-Kontexte desselben Origins. Der Core registriert genau einen Transport pro channel.
 */
export class BroadcastChannelTransport implements BusTransport {
  readonly kind = "broadcast-channel";
  readonly id: string;

  private channel: BroadcastChannel | undefined;
  private receive: ((envelope: BusEnvelope) => void) | undefined;

  constructor(
    private readonly channelName: string,
    private readonly reportError: MessageBusErrorHandler
  ) {
    this.id = `broadcast:${channelName}`;
  }

  start(receive: (envelope: BusEnvelope) => void): void {
    if (this.channel) {
      return;
    }

    if (typeof BroadcastChannel === "undefined") {
      throw new UnsupportedEnvironmentError("BroadcastChannel");
    }

    this.receive = receive;
    this.channel = new BroadcastChannel(this.channelName);
    this.channel.addEventListener("message", this.onMessage);
    this.channel.addEventListener("messageerror", this.onMessageError);
  }

  send(envelope: BusEnvelope): void {
    this.channel?.postMessage(envelope);
  }

  close(): void {
    if (!this.channel) {
      return;
    }

    this.channel.removeEventListener("message", this.onMessage);
    this.channel.removeEventListener("messageerror", this.onMessageError);
    this.channel.close();
    this.channel = undefined;
    this.receive = undefined;
  }

  private readonly onMessage = (event: MessageEvent<BusEnvelope>): void => {
    this.receive?.(event.data);
  };

  private readonly onMessageError = (): void => {
    this.reportError(new Error("BroadcastChannel could not deserialize a message."), {
      phase: "transport",
      transportId: this.id
    });
  };
}
