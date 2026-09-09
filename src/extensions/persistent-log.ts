import { PersistenceError } from "../core/errors.js";
import type {
  BusIdentity,
  MessageBusExtension,
  MessageTarget,
  ObservedMessage
} from "../core/types.js";
import { IndexedDbLogStore, type LogStore } from "./indexed-db-log-store.js";

export interface PersistentLogOptions {
  readonly databaseName?: string;
  readonly topics?: readonly string[];
  readonly maxAgeMs?: number;
  readonly maxEntries?: number;
  readonly requestPersistentStorage?: boolean;
}

export interface PersistentLogReadOptions {
  readonly topic?: string;
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
}

export interface LoggedMessage {
  readonly id: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly source: BusIdentity;
  readonly target?: MessageTarget;
  readonly timestamp: number;
}

export interface PersistentLogApi {
  ready(): Promise<void>;
  flush(): Promise<void>;
  read(options?: PersistentLogReadOptions): Promise<readonly LoggedMessage[]>;
  clear(topic?: string): Promise<void>;
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

export function persistentLog(
  options: PersistentLogOptions = {}
): MessageBusExtension<PersistentLogApi> {
  return createPersistentLogExtension(options, (databaseName, requestPersistentStorage) =>
    new IndexedDbLogStore(databaseName, requestPersistentStorage)
  );
}

export function createPersistentLogExtension(
  options: PersistentLogOptions,
  storeFactory: (databaseName: string, requestPersistentStorage: boolean) => LogStore
): MessageBusExtension<PersistentLogApi> {
  return {
    id: "persistent-log",
    install(context) {
      const databaseName = options.databaseName ?? `browser-message-bus:${context.channel}`;
      const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
      const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
      const topicFilter = options.topics ? new Set(options.topics) : undefined;

      if (maxAgeMs <= 0 || !Number.isFinite(maxAgeMs)) {
        throw new PersistenceError("maxAgeMs must be greater than zero.");
      }
      if (!Number.isInteger(maxEntries) || maxEntries < 1) {
        throw new PersistenceError("maxEntries must be a positive integer.");
      }

      const store = storeFactory(databaseName, options.requestPersistentStorage ?? false);
      const openPromise = store.open().then(() => store.cleanup(maxAgeMs, maxEntries));
      let chain: Promise<void> = Promise.resolve();
      let writesSinceCleanup = 0;

      const queue = (work: () => Promise<void>): void => {
        chain = chain
          .then(() => openPromise)
          .then(work)
          .catch(error => {
            context.reportError(error, "persistence");
          });
      };

      const unsubscribe = context.observe(message => {
        if (topicFilter && !topicFilter.has(message.topic)) {
          return;
        }

        const logged = toLoggedMessage(message);
        queue(async () => {
          await store.put(logged);
          writesSinceCleanup += 1;
          if (writesSinceCleanup >= 50) {
            writesSinceCleanup = 0;
            await store.cleanup(maxAgeMs, maxEntries);
          }
        });
      });

      const api: PersistentLogApi = {
        ready: () => openPromise,
        flush: async () => {
          await openPromise;
          await chain;
        },
        read: async (readOptions = {}) => {
          await openPromise;
          await chain;
          return store.read(readOptions);
        },
        clear: async topic => {
          await openPromise;
          await chain;
          await store.clear(topic);
        }
      };

      return {
        api,
        async dispose() {
          unsubscribe();
          await openPromise.catch(() => undefined);
          await chain;
          store.close();
        }
      };
    }
  };
}

function toLoggedMessage(message: ObservedMessage): LoggedMessage {
  return {
    id: message.context.messageId,
    topic: message.topic,
    payload: message.payload,
    source: message.context.source,
    ...(message.context.target ? { target: message.context.target } : {}),
    timestamp: message.context.timestamp
  };
}
