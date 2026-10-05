import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

const toSqlStorageParameter = (value: SqliteValue): SqlStorageValue => {
  if (typeof value === "bigint") {
    throw new TypeError(
      "Cloudflare SqlStorage does not accept bigint query parameters; converting them could lose precision",
    );
  }
  return value instanceof Uint8Array ? new Uint8Array(value).buffer : value;
};

const fromSqlStorageRow = <T extends object>(source: Record<string, SqlStorageValue>): T =>
  Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      value instanceof ArrayBuffer ? new Uint8Array(value) : value,
    ]),
  ) as T;

type RunOperation = <T>(operation: () => T) => Promise<T>;

const ignore = (): void => {};

/** Runs database operations in call order and holds the line across asynchronous transactions. */
class SerialOperationQueue {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  runSynchronous<T>(operation: () => T): Promise<T> {
    if (this.#pending > 0) return this.#enqueue(operation);
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#pending > 0) return this.#enqueue(operation);
    this.#pending++;
    const barrier = Promise.withResolvers<void>();
    this.#tail = barrier.promise;
    let started: Promise<T>;
    try {
      started = operation();
    } catch (error) {
      started = Promise.reject(error);
    }
    return started.finally(() => {
      this.#pending--;
      barrier.resolve();
    });
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    this.#pending++;
    const settled = this.#tail.then(operation).finally(() => {
      this.#pending--;
    });
    this.#tail = settled.then(ignore, ignore);
    return settled;
  }
}

const createExecutor = (sql: SqlStorage, runOperation: RunOperation): SqliteExecutor => ({
  exec(query): Promise<void> {
    return runOperation(() => {
      sql.exec(query);
    });
  },

  run(query, ...params): Promise<void> {
    return runOperation(() => {
      sql.exec(query, ...params.map(toSqlStorageParameter));
    });
  },

  get<T extends object>(query: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return runOperation(() => {
      const result = sql.exec(query, ...params.map(toSqlStorageParameter)).next();
      return result.done ? undefined : fromSqlStorageRow<T>(result.value);
    });
  },

  all<T extends object>(query: string, ...params: SqliteValue[]): Promise<T[]> {
    return runOperation(() =>
      sql
        .exec(query, ...params.map(toSqlStorageParameter))
        .toArray()
        .map(fromSqlStorageRow<T>),
    );
  },
});

/**
 * Adapts one Durable Object's synchronous SQLite API to pi-durable's asynchronous portable facade.
 *
 * Retain one instance per Durable Object. Separate adapters over the same storage do not share
 * transaction serialization.
 */
export function createCloudflareSqliteDatabase(storage: DurableObjectStorage): SqliteDatabase {
  const access = new SerialOperationQueue();
  const executor = createExecutor(storage.sql, (operation) => access.runSynchronous(operation));
  return {
    ...executor,

    transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
      // Durable Object transactions include SQL issued through storage.sql and roll it back if this rejects.
      return access.runExclusive(() =>
        storage.transaction(async () => {
          const scope = { active: true };
          // The outer transaction already owns the queue. Transaction-handle operations must run
          // directly or they would wait behind their own transaction.
          const transaction = createExecutor(storage.sql, async (operation) => {
            if (!scope.active) throw new Error("SQLite transaction handle is no longer active");
            return operation();
          });
          try {
            return await callback(transaction);
          } finally {
            scope.active = false;
          }
        }),
      );
    },

    close(): Promise<void> {
      return access.runSynchronous(() => {
        // The Durable Object runtime owns the SQLite connection lifetime.
      });
    },
  };
}
