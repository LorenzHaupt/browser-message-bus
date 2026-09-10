import { BrowserMessageBus } from "./core/message-bus.js";
import type { MessageBus, MessageBusOptions, MessageMap } from "./core/types.js";

/**
 * Erzeugt eine sofort einsatzbereite Bus-Instanz.
 * Der konfigurierte BroadcastChannel wird direkt eingerichtet; ein separates start() ist nicht nötig.
 */
export function createMessageBus<M extends MessageMap>(
  options: MessageBusOptions
): MessageBus<M> {
  return new BrowserMessageBus<M>(options);
}

export {
  BridgeProtocolError,
  BridgeSecurityError,
  BridgeTimeoutError,
  BusClosedError,
  DuplicateRequestHandlerError,
  ExtensionAlreadyInstalledError,
  InvalidConfigurationError,
  InvalidEnvelopeError,
  InvalidTopicError,
  MessageBusError,
  PayloadCloneError,
  PersistenceError,
  RemoteRequestError,
  RequestAbortedError,
  RequestTimeoutError,
  UnsupportedEnvironmentError
} from "./core/errors.js";

export type {
  BusConnection,
  BusConnector,
  BusIdentity,
  MessageBus,
  MessageBusErrorContext,
  MessageBusErrorHandler,
  MessageBusExtension,
  MessageContext,
  MessageHandler,
  MessageMap,
  MessageTarget,
  PublishArguments,
  PublishOptions,
  PublishReceipt,
  SubscribeOptions,
  TopicOf,
  Unsubscribe
} from "./core/types.js";
