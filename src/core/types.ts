export type MessageMap = object;

export interface BusIdentity {
  readonly instanceId: string;
  readonly appId?: string;
}

export interface MessageTarget {
  readonly instanceId?: string;
  readonly appId?: string;
}

export interface MessageContext {
  readonly messageId: string;
  readonly source: BusIdentity;
  readonly target?: MessageTarget;
  readonly timestamp: number;
}

export interface PublishOptions {
  readonly target?: MessageTarget;
}

export interface SubscribeOptions {
  readonly signal?: AbortSignal;
}

export interface PublishReceipt {
  readonly messageId: string;
}

export type PublishArguments<TPayload> = undefined extends TPayload
  ? [payload?: TPayload, options?: PublishOptions]
  : [payload: TPayload, options?: PublishOptions];

export interface MessageBusErrorContext {
  readonly phase:
    | "subscriber"
    | "transport"
    | "extension"
    | "bridge"
    | "persistence"
    | "protocol";
  readonly topic?: string;
  readonly transportId?: string;
}

export type MessageBusErrorHandler = (
  error: unknown,
  context: MessageBusErrorContext
) => void;

export interface MessageBusOptions {
  readonly channel: string;
  readonly appId?: string;
  readonly instanceId?: string;
  readonly maxHops?: number;
  readonly onError?: MessageBusErrorHandler;
}

export type Unsubscribe = () => void;

export type MessageHandler<T> = (
  payload: T,
  context: MessageContext
) => void | Promise<void>;

export interface BusConnection {
  readonly id: string;
  readonly remote: BusIdentity;
  readonly connected: boolean;
  close(): Promise<void>;
}

export interface BusConnector {
  readonly kind: string;
  connect(context: ConnectorContext): Promise<ConnectorResult>;
}

export interface MessageBusExtension<TApi> {
  readonly id: string;
  install(context: ExtensionContext): ExtensionInstallation<TApi>;
}

export interface ExtensionInstallation<TApi> {
  readonly api: TApi;
  dispose?(): void | Promise<void>;
}


export interface ObservedMessage {
  readonly topic: string;
  readonly payload: unknown;
  readonly context: MessageContext;
}

export interface ExtensionContext {
  readonly channel: string;
  readonly identity: BusIdentity;

  publish(
    topic: string,
    payload: unknown,
    options?: PublishOptions
  ): PublishReceipt;

  subscribe(
    topic: string,
    handler: MessageHandler<unknown>
  ): Unsubscribe;

  observe(handler: (message: ObservedMessage) => void): Unsubscribe;

  reportError(error: unknown, phase?: MessageBusErrorContext["phase"]): void;
}

export interface ConnectorContext {
  readonly channel: string;
  readonly identity: BusIdentity;
  readonly reportError: MessageBusErrorHandler;
}

export interface ConnectorResult {
  readonly transport: BusTransport;
  readonly remote: BusIdentity;
}

export interface BusTransport {
  readonly id: string;
  readonly kind: string;

  start(
    receive: (envelope: BusEnvelope) => void,
    remoteClose: () => void
  ): void | Promise<void>;

  send(envelope: BusEnvelope): void;
  close(notifyRemote?: boolean): void | Promise<void>;
}

export interface BusEnvelope {
  readonly namespace: "browser-message-bus";
  readonly protocolVersion: 1;
  readonly id: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly source: BusIdentity;
  readonly target?: MessageTarget;
  readonly timestamp: number;
  readonly hop: number;
  readonly system: boolean;
}

export type TopicOf<M extends MessageMap> = keyof M & string;

export interface MessageBus<M extends MessageMap> {
  readonly channel: string;
  readonly identity: BusIdentity;
  readonly instanceId: string;
  readonly appId?: string;
  readonly closed: boolean;

  publish<K extends TopicOf<M>>(
    topic: K,
    ...args: PublishArguments<M[K]>
  ): PublishReceipt;

  subscribe<K extends TopicOf<M>>(
    topic: K,
    handler: MessageHandler<M[K]>,
    options?: SubscribeOptions
  ): Unsubscribe;

  use<TApi>(extension: MessageBusExtension<TApi>): TApi;
  connect(connector: BusConnector): Promise<BusConnection>;
  close(): Promise<void>;
}
