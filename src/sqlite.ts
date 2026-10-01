import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

const binding = (value: SqliteValue): SqlStorageValue => {
  if (typeof value === "bigint") {
    throw new TypeError("Cloudflare SqlStorage does not accept bigint query parameters");
  }
  if (!(value instanceof Uint8Array)) return value;
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
};

const row = <T extends object>(value: Record<string, SqlStorageValue>): T =>
  Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      field instanceof ArrayBuffer ? new Uint8Array(field) : field,
    ]),
  ) as T;

type RunOperation = <T>(operation: () => T) => Promise<T>;

const ignore = (): void => {};

/** Runs database operations in call order and holds the line across asynchronous transactions. */
class SerialOperationQueue {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  run<T>(operation: () => T): Promise<T> {
    if (this.#pending > 0) return this.#enqueue(operation);
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  runAsync<T>(operation: () => Promise<T>): Promise<T> {
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
      sql.exec(query, ...params.map(binding));
    });
  },

  get<T extends object>(query: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return runOperation(() => {
      const result = sql.exec(query, ...params.map(binding)).next();
      return result.done ? undefined : row<T>(result.value);
    });
  },

  all<T extends object>(query: string, ...params: SqliteValue[]): Promise<T[]> {
    return runOperation(() =>
      sql
        .exec(query, ...params.map(binding))
        .toArray()
        .map(row<T>),
    );
  },
});

/** Adapts one Durable Object's synchronous SQLite API to pi-durable's asynchronous portable facade. */
export function createCloudflareSqliteDatabase(storage: DurableObjectStorage): SqliteDatabase {
  const access = new SerialOperationQueue();
  const executor = createExecutor(storage.sql, (operation) => access.run(operation));
  return {
    ...executor,

    transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
      // Durable Object transactions include SQL issued through storage.sql and roll it back if this rejects.
      return access.runAsync(() =>
        storage.transaction(async () => {
          const scope = { active: true };
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
      return access.run(() => {
        // The Durable Object runtime owns the SQLite connection lifetime.
      });
    },
  };
}
