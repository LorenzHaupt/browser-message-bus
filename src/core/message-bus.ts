import {
  BUS_NAMESPACE,
  DEFAULT_MAX_HOPS,
  PROTOCOL_VERSION,
  RESERVED_TOPIC_PREFIX
} from "./constants.js";
import { DeduplicationCache } from "./deduplication.js";
import { isBusEnvelope } from "./envelope.js";
import {
  BusClosedError,
  ExtensionAlreadyInstalledError,
  InvalidConfigurationError,
  InvalidEnvelopeError
} from "./errors.js";
import type {
  BusConnection,
  BusConnector,
  BusEnvelope,
  BusIdentity,
  BusTransport,
  ExtensionContext,
  ExtensionInstallation,
  MessageBus,
  MessageBusErrorContext,
  MessageBusErrorHandler,
  MessageBusExtension,
  MessageContext,
  MessageHandler,
  MessageMap,
  MessageTarget,
  ObservedMessage,
  PublishArguments,
  PublishOptions,
  PublishReceipt,
  SubscribeOptions,
  TopicOf,
  Unsubscribe
} from "./types.js";
import {
  assertExtensionId,
  assertNonEmpty,
  assertPublicTopic,
  cloneForTransport,
  createInstanceId,
  freezeIdentity,
  matchesTarget,
  normalizeTarget
} from "./utils.js";
import { BroadcastChannelTransport } from "../transports/broadcast-channel-transport.js";

interface Subscription {
  active: boolean;
  queue: Promise<void>;
  handler: MessageHandler<unknown>;
}

interface ExtensionRecord {
  installation: ExtensionInstallation<unknown>;
}

class ConnectionImpl implements BusConnection {
  private isConnected = true;

  constructor(
    readonly id: string,
    readonly remote: BusIdentity,
    private readonly closeTransport: () => Promise<void>
  ) {}

  get connected(): boolean {
    return this.isConnected;
  }

  markClosed(): void {
    this.isConnected = false;
  }

  async close(): Promise<void> {
    if (!this.isConnected) {
      return;
    }
    this.isConnected = false;
    await this.closeTransport();
  }
}

export class BrowserMessageBus<M extends MessageMap> implements MessageBus<M> {
  readonly channel: string;
  readonly identity: BusIdentity;
  readonly instanceId: string;
  readonly appId?: string;

  private readonly maxHops: number;
  private readonly reportErrorHandler: MessageBusErrorHandler;
  private readonly dedupe = new DeduplicationCache();
  private readonly transports = new Map<string, BusTransport>();
  private readonly connections = new Map<string, ConnectionImpl>();
  private readonly subscriptions = new Map<string, Set<Subscription>>();
  private readonly systemSubscriptions = new Map<string, Set<Subscription>>();
  private readonly observers = new Set<(message: ObservedMessage) => void>();
  private readonly extensions = new Map<string, ExtensionRecord>();
  private isClosed = false;

  constructor(options: MessageBusOptionsLike) {
    this.channel = assertNonEmpty(options.channel, "channel");
    this.maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
    if (!Number.isInteger(this.maxHops) || this.maxHops < 1 || this.maxHops > 64) {
      throw new InvalidConfigurationError("maxHops must be an integer between 1 and 64.");
    }

    const instanceId = options.instanceId
      ? assertNonEmpty(options.instanceId, "instanceId")
      : createInstanceId();
    const appId = options.appId ? assertNonEmpty(options.appId, "appId") : undefined;

    this.identity = freezeIdentity({
      instanceId,
      ...(appId ? { appId } : {})
    });
    this.instanceId = instanceId;
    if (appId) {
      this.appId = appId;
    }

    this.reportErrorHandler = options.onError ?? defaultErrorHandler;

    const broadcast = new BroadcastChannelTransport(this.channel, this.reportErrorHandler);
    this.registerTransport(broadcast);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  publish<K extends TopicOf<M>>(
    topic: K,
    ...args: PublishArguments<M[K]>
  ): PublishReceipt {
    this.assertOpen();
    assertPublicTopic(topic);
    const payload = args[0] as M[K];
    const options = (args[1] ?? {}) as PublishOptions;
    return this.publishEnvelope(topic, payload, options.target, false);
  }

  subscribe<K extends TopicOf<M>>(
    topic: K,
    handler: MessageHandler<M[K]>,
    options: SubscribeOptions = {}
  ): Unsubscribe {
    this.assertOpen();
    assertPublicTopic(topic);

    const unsubscribe = this.addSubscription(
      this.subscriptions,
      topic,
      handler as MessageHandler<unknown>
    );

    if (options.signal) {
      if (options.signal.aborted) {
        unsubscribe();
        return unsubscribe;
      }
      options.signal.addEventListener("abort", unsubscribe, { once: true });
    }

    return unsubscribe;
  }

  use<TApi>(extension: MessageBusExtension<TApi>): TApi {
    this.assertOpen();
    const id = assertExtensionId(extension.id);
    if (this.extensions.has(id)) {
      throw new ExtensionAlreadyInstalledError(id);
    }

    const prefix = `${RESERVED_TOPIC_PREFIX}ext/${id}/`;
    const context: ExtensionContext = {
      channel: this.channel,
      identity: this.identity,
      publish: (topic, payload, options = {}) =>
        this.publishEnvelope(`${prefix}${normalizeExtensionTopic(topic)}`, payload, options.target, true),
      subscribe: (topic, handler) =>
        this.addSubscription(
          this.systemSubscriptions,
          `${prefix}${normalizeExtensionTopic(topic)}`,
          handler
        ),
      observe: handler => {
        this.observers.add(handler);
        return () => this.observers.delete(handler);
      },
      reportError: (error, phase = "extension") =>
        this.reportError(error, { phase })
    };

    let installation: ExtensionInstallation<TApi>;
    try {
      installation = extension.install(context);
    } catch (error) {
      this.reportError(error, { phase: "extension" });
      throw error;
    }

    this.extensions.set(id, { installation: installation as ExtensionInstallation<unknown> });
    return installation.api;
  }

  async connect(connector: BusConnector): Promise<BusConnection> {
    this.assertOpen();

    const result = await connector.connect({
      channel: this.channel,
      identity: this.identity,
      reportError: this.reportErrorHandler
    });

    this.assertOpen();
    if (this.transports.has(result.transport.id)) {
      await result.transport.close(false);
      throw new InvalidConfigurationError(
        `A transport with id \"${result.transport.id}\" is already connected.`
      );
    }

    const connection = new ConnectionImpl(
      result.transport.id,
      freezeIdentity(result.remote),
      () => this.removeTransport(result.transport.id, true)
    );
    this.connections.set(result.transport.id, connection);
    this.registerTransport(result.transport);
    return connection;
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    for (const record of [...this.extensions.values()].reverse()) {
      try {
        await record.installation.dispose?.();
      } catch (error) {
        this.reportError(error, { phase: "extension" });
      }
    }
    this.extensions.clear();
    this.isClosed = true;

    for (const connection of this.connections.values()) {
      connection.markClosed();
    }
    this.connections.clear();

    for (const transport of this.transports.values()) {
      try {
        await transport.close(true);
      } catch (error) {
        this.reportError(error, { phase: "transport", transportId: transport.id });
      }
    }
    this.transports.clear();

    this.subscriptions.clear();
    this.systemSubscriptions.clear();
    this.observers.clear();
    this.dedupe.clear();
  }

  private publishEnvelope(
    topic: string,
    payload: unknown,
    target: MessageTarget | undefined,
    system: boolean
  ): PublishReceipt {
    this.assertOpen();
    const clonedPayload = cloneForTransport(payload);
    const normalizedTarget = normalizeTarget(target);
    const id = createInstanceId();
    const envelope: BusEnvelope = {
      namespace: BUS_NAMESPACE,
      protocolVersion: PROTOCOL_VERSION,
      id,
      topic,
      payload: clonedPayload,
      source: this.identity,
      ...(normalizedTarget ? { target: normalizedTarget } : {}),
      timestamp: Date.now(),
      hop: 0,
      system
    };

    this.dedupe.hasOrAdd(id, envelope.timestamp);
    this.observe(envelope);
    this.deliverLocally(envelope);
    this.forward(envelope);

    return { messageId: id };
  }

  private registerTransport(transport: BusTransport): void {
    this.transports.set(transport.id, transport);
    try {
      const startResult = transport.start(
        envelope => this.receive(envelope, transport.id),
        () => void this.removeTransport(transport.id, false)
      );
      if (startResult instanceof Promise) {
        void startResult.catch(error => {
          this.reportError(error, { phase: "transport", transportId: transport.id });
        });
      }
    } catch (error) {
      this.transports.delete(transport.id);
      throw error;
    }
  }

  private async removeTransport(id: string, notifyRemote: boolean): Promise<void> {
    const transport = this.transports.get(id);
    if (!transport) {
      return;
    }

    this.transports.delete(id);
    const connection = this.connections.get(id);
    connection?.markClosed();
    this.connections.delete(id);

    try {
      await transport.close(notifyRemote);
    } catch (error) {
      this.reportError(error, { phase: "transport", transportId: id });
    }
  }

  private receive(value: BusEnvelope, incomingTransportId: string): void {
    if (this.isClosed) {
      return;
    }

    if (!isBusEnvelope(value)) {
      this.reportError(new InvalidEnvelopeError(), {
        phase: "protocol",
        transportId: incomingTransportId
      });
      return;
    }

    if (value.hop > this.maxHops) {
      return;
    }

    if (this.dedupe.hasOrAdd(value.id)) {
      return;
    }

    this.observe(value);
    this.deliverLocally(value);

    if (value.hop >= this.maxHops) {
      return;
    }

    this.forward({ ...value, hop: value.hop + 1 }, incomingTransportId);
  }

  private deliverLocally(envelope: BusEnvelope): void {
    if (!matchesTarget(envelope.target, this.identity)) {
      return;
    }

    const registry = envelope.system ? this.systemSubscriptions : this.subscriptions;
    const subscriptions = registry.get(envelope.topic);
    if (!subscriptions?.size) {
      return;
    }

    const context: MessageContext = Object.freeze({
      messageId: envelope.id,
      source: envelope.source,
      ...(envelope.target ? { target: envelope.target } : {}),
      timestamp: envelope.timestamp
    });

    for (const subscription of subscriptions) {
      if (!subscription.active) {
        continue;
      }

      subscription.queue = subscription.queue
        .then(async () => {
          if (!subscription.active) {
            return;
          }
          await subscription.handler(envelope.payload, context);
        })
        .catch(error => {
          this.reportError(error, { phase: "subscriber", topic: envelope.topic });
        });
    }
  }

  private forward(envelope: BusEnvelope, excludeTransportId?: string): void {
    for (const transport of this.transports.values()) {
      if (transport.id === excludeTransportId) {
        continue;
      }

      try {
        transport.send(envelope);
      } catch (error) {
        this.reportError(error, {
          phase: "transport",
          topic: envelope.topic,
          transportId: transport.id
        });
      }
    }
  }

  private observe(envelope: BusEnvelope): void {
    if (envelope.system || this.observers.size === 0) {
      return;
    }

    const message: ObservedMessage = {
      topic: envelope.topic,
      payload: envelope.payload,
      context: {
        messageId: envelope.id,
        source: envelope.source,
        ...(envelope.target ? { target: envelope.target } : {}),
        timestamp: envelope.timestamp
      }
    };

    for (const observer of this.observers) {
      try {
        observer(message);
      } catch (error) {
        this.reportError(error, { phase: "extension", topic: envelope.topic });
      }
    }
  }

  private addSubscription(
    registry: Map<string, Set<Subscription>>,
    topic: string,
    handler: MessageHandler<unknown>
  ): Unsubscribe {
    let bucket = registry.get(topic);
    if (!bucket) {
      bucket = new Set();
      registry.set(topic, bucket);
    }

    const subscription: Subscription = {
      active: true,
      queue: Promise.resolve(),
      handler
    };
    bucket.add(subscription);

    return () => {
      if (!subscription.active) {
        return;
      }
      subscription.active = false;
      bucket?.delete(subscription);
      if (bucket?.size === 0) {
        registry.delete(topic);
      }
    };
  }

  private reportError(error: unknown, context: MessageBusErrorContext): void {
    try {
      this.reportErrorHandler(error, context);
    } catch {
      // An error reporter must never break message delivery.
    }
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new BusClosedError();
    }
  }
}

interface MessageBusOptionsLike {
  readonly channel: string;
  readonly appId?: string;
  readonly instanceId?: string;
  readonly maxHops?: number;
  readonly onError?: MessageBusErrorHandler;
}

function normalizeExtensionTopic(topic: string): string {
  const value = topic.trim();
  if (!value || value.startsWith("/") || value.includes("..")) {
    throw new InvalidConfigurationError(`Invalid extension topic \"${topic}\".`);
  }
  return value;
}

function defaultErrorHandler(error: unknown, context: MessageBusErrorContext): void {
  console.error("[browser-message-bus]", context, error);
}
