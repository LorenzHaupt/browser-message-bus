export class MessageBusError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class BusClosedError extends MessageBusError {
  constructor() {
    super("BUS_CLOSED", "The message bus is closed.");
  }
}

export class InvalidConfigurationError extends MessageBusError {
  constructor(message: string) {
    super("INVALID_CONFIGURATION", message);
  }
}

export class InvalidTopicError extends MessageBusError {
  constructor(topic: string) {
    super(
      "INVALID_TOPIC",
      `Invalid public topic \"${topic}\". Topics must be non-empty and must not start with \"@bmb/\".`
    );
  }
}

export class PayloadCloneError extends MessageBusError {
  constructor(cause?: unknown) {
    super(
      "PAYLOAD_CLONE_ERROR",
      "The payload cannot be transported with the browser structured clone algorithm.",
      cause instanceof Error ? { cause } : undefined
    );
  }
}

export class InvalidEnvelopeError extends MessageBusError {
  constructor(message = "Received an invalid message bus envelope.") {
    super("INVALID_ENVELOPE", message);
  }
}

export class UnsupportedEnvironmentError extends MessageBusError {
  constructor(feature: string) {
    super("UNSUPPORTED_ENVIRONMENT", `${feature} is not available in this runtime.`);
  }
}

export class ExtensionAlreadyInstalledError extends MessageBusError {
  constructor(id: string) {
    super("EXTENSION_ALREADY_INSTALLED", `Extension \"${id}\" is already installed.`);
  }
}

export class RequestTimeoutError extends MessageBusError {
  constructor(topic: string, timeoutMs: number) {
    super("REQUEST_TIMEOUT", `Request \"${topic}\" timed out after ${timeoutMs} ms.`);
  }
}

export class RequestAbortedError extends MessageBusError {
  constructor(topic: string) {
    super("REQUEST_ABORTED", `Request \"${topic}\" was aborted.`);
  }
}

export class DuplicateRequestHandlerError extends MessageBusError {
  constructor(topic: string) {
    super("DUPLICATE_REQUEST_HANDLER", `A request handler for \"${topic}\" already exists.`);
  }
}

export class RemoteRequestError extends MessageBusError {
  readonly remoteName: string | undefined;

  constructor(message: string, remoteName?: string, code?: string) {
    super(code ?? "REMOTE_REQUEST_ERROR", message);
    this.remoteName = remoteName;
  }
}

export class PersistenceError extends MessageBusError {
  constructor(message: string, cause?: unknown) {
    super(
      "PERSISTENCE_ERROR",
      message,
      cause instanceof Error ? { cause } : undefined
    );
  }
}

export class BridgeSecurityError extends MessageBusError {
  constructor(message: string) {
    super("BRIDGE_SECURITY_ERROR", message);
  }
}

export class BridgeTimeoutError extends MessageBusError {
  constructor(timeoutMs: number) {
    super("BRIDGE_TIMEOUT", `Bridge handshake timed out after ${timeoutMs} ms.`);
  }
}

export class BridgeProtocolError extends MessageBusError {
  constructor(message: string) {
    super("BRIDGE_PROTOCOL_ERROR", message);
  }
}
