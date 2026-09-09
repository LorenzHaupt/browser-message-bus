import { PersistenceError, UnsupportedEnvironmentError } from "../core/errors.js";
import type { LoggedMessage, PersistentLogReadOptions } from "./persistent-log.js";

const DB_VERSION = 1;
const STORE = "messages";
const TIMESTAMP_INDEX = "timestamp";
const TOPIC_TIMESTAMP_INDEX = "topic_timestamp";

export interface LogStore {
  open(): Promise<void>;
  put(message: LoggedMessage): Promise<void>;
  read(options: PersistentLogReadOptions): Promise<LoggedMessage[]>;
  clear(topic?: string): Promise<void>;
  cleanup(maxAgeMs: number, maxEntries: number): Promise<void>;
  close(): void;
}

export class IndexedDbLogStore implements LogStore {
  private database: IDBDatabase | undefined;

  constructor(
    private readonly databaseName: string,
    private readonly requestPersistentStorage: boolean
  ) {}

  async open(): Promise<void> {
    if (this.database) {
      return;
    }
    if (typeof indexedDB === "undefined") {
      throw new UnsupportedEnvironmentError("IndexedDB");
    }

    if (
      this.requestPersistentStorage &&
      typeof navigator !== "undefined" &&
      navigator.storage?.persist
    ) {
      try {
        await navigator.storage.persist();
      } catch {
        // Persistent storage is an optional browser hint.
      }
    }

    this.database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex(TIMESTAMP_INDEX, "timestamp");
          store.createIndex(TOPIC_TIMESTAMP_INDEX, ["topic", "timestamp"]);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new PersistenceError("Could not open IndexedDB log.", request.error));
      request.onblocked = () => reject(new PersistenceError("IndexedDB log is blocked by another open version."));
    });
  }

  async put(message: LoggedMessage): Promise<void> {
    const db = this.assertOpen();
    await transactionPromise(db, STORE, "readwrite", store => store.put(message));
  }

  async read(options: PersistentLogReadOptions): Promise<LoggedMessage[]> {
    const db = this.assertOpen();
    const order = options.order ?? "asc";
    const limit = options.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new PersistenceError("Persistent log read limit must be a positive integer.");
    }

    return new Promise<LoggedMessage[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const results: LoggedMessage[] = [];
      const direction: IDBCursorDirection = order === "desc" ? "prev" : "next";

      let request: IDBRequest<IDBCursorWithValue | null>;
      if (options.topic) {
        const lower = [options.topic, options.since ?? 0];
        const upper = [options.topic, options.until ?? Number.MAX_SAFE_INTEGER];
        request = store.index(TOPIC_TIMESTAMP_INDEX).openCursor(IDBKeyRange.bound(lower, upper), direction);
      } else {
        const range = IDBKeyRange.bound(options.since ?? 0, options.until ?? Number.MAX_SAFE_INTEGER);
        request = store.index(TIMESTAMP_INDEX).openCursor(range, direction);
      }

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || results.length >= limit) {
          resolve(results);
          return;
        }
        results.push(cursor.value as LoggedMessage);
        cursor.continue();
      };
      request.onerror = () => reject(new PersistenceError("Could not read the persistent log.", request.error));
    });
  }

  async clear(topic?: string): Promise<void> {
    const db = this.assertOpen();
    if (!topic) {
      await transactionPromise(db, STORE, "readwrite", store => store.clear());
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const index = store.index(TOPIC_TIMESTAMP_INDEX);
      const range = IDBKeyRange.bound([topic, 0], [topic, Number.MAX_SAFE_INTEGER]);
      const request = index.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new PersistenceError("Could not clear the persistent log.", tx.error));
      tx.onabort = () => reject(new PersistenceError("Persistent log clear transaction was aborted.", tx.error));
    });
  }

  async cleanup(maxAgeMs: number, maxEntries: number): Promise<void> {
    const db = this.assertOpen();
    const cutoff = Date.now() - maxAgeMs;

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const index = tx.objectStore(STORE).index(TIMESTAMP_INDEX);
      const request = index.openCursor(IDBKeyRange.upperBound(cutoff, true));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new PersistenceError("Persistent log cleanup failed.", tx.error));
    });

    const count = await requestPromise(db.transaction(STORE, "readonly").objectStore(STORE).count());
    const excess = count - maxEntries;
    if (excess <= 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const index = tx.objectStore(STORE).index(TIMESTAMP_INDEX);
      let remaining = excess;
      const request = index.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || remaining <= 0) {
          return;
        }
        cursor.delete();
        remaining -= 1;
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new PersistenceError("Persistent log size cleanup failed.", tx.error));
    });
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private assertOpen(): IDBDatabase {
    if (!this.database) {
      throw new PersistenceError("Persistent log is not open yet.");
    }
    return this.database;
  }
}

function transactionPromise(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    action(tx.objectStore(storeName));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new PersistenceError("IndexedDB transaction failed.", tx.error));
    tx.onabort = () => reject(new PersistenceError("IndexedDB transaction was aborted.", tx.error));
  });
}

function requestPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new PersistenceError("IndexedDB request failed.", request.error));
  });
}
