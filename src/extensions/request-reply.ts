import {
  BusClosedError,
  DuplicateRequestHandlerError,
  RemoteRequestError,
  RequestAbortedError,
  RequestTimeoutError
} from "../core/errors.js";
import type {
  MessageBusExtension,
  MessageContext,
  MessageTarget,
  Unsubscribe
} from "../core/types.js";

export interface RequestDefinition {
  request: unknown;
  response: unknown;
}

export type RequestMap = object;
export type ValidRequestMap<R extends object> = {
  [K in keyof R]: RequestDefinition;
};

export type RequestTopic<R extends ValidRequestMap<R>> = keyof R & string;

export interface RequestOptions {
  readonly target?: MessageTarget;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RequestReplyOptions {
  readonly defaultTimeoutMs?: number;
}

export type RequestArguments<TPayload> = undefined extends TPayload
  ? [payload?: TPayload, options?: RequestOptions]
  : [payload: TPayload, options?: RequestOptions];

export type RequestHandler<TRequest, TResponse> = (
  request: TRequest,
  context: MessageContext
) => TResponse | Promise<TResponse>;

export interface RequestReplyApi<R extends ValidRequestMap<R>> {
  request<K extends RequestTopic<R>>(
    topic: K,
    ...args: RequestArguments<R[K]["request"]>
  ): Promise<R[K]["response"]>;

  handle<K extends RequestTopic<R>>(
    topic: K,
    handler: RequestHandler<R[K]["request"], R[K]["response"]>
  ): Unsubscribe;
}

interface RequestFrame {
  requestId: string;
  topic: string;
  payload: unknown;
}

interface ResponseFrame {
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    name: string;
    message: string;
    code?: string;
  };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
}

export function requestReply<R extends ValidRequestMap<R>>(
  options: RequestReplyOptions = {}
): MessageBusExtension<RequestReplyApi<R>> {
  return {
    id: "request-reply",
    install(context) {
      const defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000;
      const handlers = new Map<string, RequestHandler<unknown, unknown>>();
      const pending = new Map<string, PendingRequest>();
      let disposed = false;

      const unsubscribeRequest = context.subscribe("request", async (value, message) => {
        if (!isRequestFrame(value)) {
          return;
        }

        const handler = handlers.get(value.topic);
        if (!handler) {
          return;
        }

        try {
          const response = await handler(value.payload, message);
          const frame: ResponseFrame = {
            requestId: value.requestId,
            ok: true,
            payload: response
          };
          context.publish("response", frame, {
            target: { instanceId: message.source.instanceId }
          });
        } catch (error) {
          const normalized = serializeError(error);
          const frame: ResponseFrame = {
            requestId: value.requestId,
            ok: false,
            error: normalized
          };
          context.publish("response", frame, {
            target: { instanceId: message.source.instanceId }
          });
        }
      });

      const unsubscribeResponse = context.subscribe("response", value => {
        if (!isResponseFrame(value)) {
          return;
        }

        const entry = pending.get(value.requestId);
        if (!entry) {
          return;
        }

        pending.delete(value.requestId);
        clearTimeout(entry.timeout);
        entry.abortCleanup?.();

        if (value.ok) {
          entry.resolve(value.payload);
        } else {
          const remote = value.error ?? { name: "Error", message: "Remote request failed." };
          entry.reject(new RemoteRequestError(remote.message, remote.name, remote.code));
        }
      });

      const api: RequestReplyApi<R> = {
        request(topic, ...args) {
          const payload = args[0];
          const requestOptions = (args[1] ?? {}) as RequestOptions;
          if (disposed) {
            return Promise.reject(new BusClosedError());
          }

          const timeoutMs = requestOptions.timeoutMs ?? defaultTimeoutMs;
          const requestId = randomId();

          return new Promise((resolve, reject) => {
            if (requestOptions.signal?.aborted) {
              reject(new RequestAbortedError(topic));
              return;
            }

            const timeout = setTimeout(() => {
              const current = pending.get(requestId);
              current?.abortCleanup?.();
              pending.delete(requestId);
              reject(new RequestTimeoutError(topic, timeoutMs));
            }, timeoutMs);

            const entry: PendingRequest = { resolve, reject, timeout };

            if (requestOptions.signal) {
              const onAbort = (): void => {
                pending.delete(requestId);
                clearTimeout(timeout);
                reject(new RequestAbortedError(topic));
              };
              requestOptions.signal.addEventListener("abort", onAbort, { once: true });
              entry.abortCleanup = () => requestOptions.signal?.removeEventListener("abort", onAbort);
            }

            pending.set(requestId, entry);
            const frame: RequestFrame = { requestId, topic, payload };
            try {
              context.publish("request", frame, {
                ...(requestOptions.target ? { target: requestOptions.target } : {})
              });
            } catch (error) {
              pending.delete(requestId);
              clearTimeout(timeout);
              entry.abortCleanup?.();
              reject(error);
            }
          });
        },

        handle(topic, handler) {
          if (handlers.has(topic)) {
            throw new DuplicateRequestHandlerError(topic);
          }
          handlers.set(topic, handler as RequestHandler<unknown, unknown>);
          return () => handlers.delete(topic);
        }
      };

      return {
        api,
        dispose() {
          disposed = true;
          unsubscribeRequest();
          unsubscribeResponse();
          handlers.clear();
          for (const entry of pending.values()) {
            clearTimeout(entry.timeout);
            entry.abortCleanup?.();
            entry.reject(new BusClosedError());
          }
          pending.clear();
        }
      };
    }
  };
}

function randomId(): string {
  return crypto.randomUUID();
}

function serializeError(error: unknown): NonNullable<ResponseFrame["error"]> {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(code ? { code } : {})
    };
  }
  return { name: "Error", message: String(error) };
}

function isRequestFrame(value: unknown): value is RequestFrame {
  return (
    isRecord(value) &&
    typeof value.requestId === "string" &&
    typeof value.topic === "string" &&
    "payload" in value
  );
}

function isResponseFrame(value: unknown): value is ResponseFrame {
  return (
    isRecord(value) &&
    typeof value.requestId === "string" &&
    typeof value.ok === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
