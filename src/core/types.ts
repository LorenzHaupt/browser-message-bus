/**
 * Beschreibt die fachlichen Topics einer Anwendung und die jeweils dazugehörige Payload.
 * Die konkrete Message-Map wird vom Consumer als generischer Typparameter angegeben.
 */
export type MessageMap = object;

/** Identität genau einer laufenden Bus-Instanz. appId gruppiert optional mehrere Instanzen derselben Anwendung. */
export interface BusIdentity {
  readonly instanceId: string;
  readonly appId?: string;
}

/**
 * Optionales Routing-Ziel einer Nachricht. Sind instanceId und appId gesetzt, müssen beide zur Empfängerinstanz passen.
 * Das Target ist keine Security- oder Vertraulichkeitsgrenze.
 */
export interface MessageTarget {
  readonly instanceId?: string;
  readonly appId?: string;
}

/** Technische Metadaten, die ein Subscriber zusätzlich zur fachlichen Payload erhält. */
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

/** Konfiguration des Core. Nur channel ist für den normalen Betrieb erforderlich. */
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

/** Repräsentiert eine explizit aufgebaute zusätzliche Verbindung, zum Beispiel zu einem iframe oder Popup. */
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

/**
 * Erweiterung mit eigener API. Extensions nutzen nur den schmalen ExtensionContext und bleiben dadurch vom Core entkoppelt.
 */
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

/**
 * Interne Transport-Abstraktion. Der Core routet Envelopes unabhängig davon, ob sie über BroadcastChannel oder MessagePort laufen.
 */
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

/**
 * Internes Transportformat einer Nachricht. Anwendungscode arbeitet normalerweise nur mit Payload und MessageContext.
 */
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

/** Öffentliche, bewusst kleine API des Message Bus. */
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
