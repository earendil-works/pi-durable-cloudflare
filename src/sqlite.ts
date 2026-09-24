import type {
  SqliteDatabase,
  SqliteStatement,
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

function createCloudflareSqliteStatement(sql: SqlStorage, query: string): SqliteStatement {
  return {
    run(...params): void {
      sql.exec(query, ...params.map(binding));
    },

    get<T extends object>(...params: SqliteValue[]): T | undefined {
      const result = sql.exec(query, ...params.map(binding)).next();
      return result.done ? undefined : row<T>(result.value);
    },

    all<T extends object>(...params: SqliteValue[]): T[] {
      return sql
        .exec(query, ...params.map(binding))
        .toArray()
        .map(row<T>);
    },
  };
}

/** Adapts one Durable Object's synchronous SQLite API to pi-durable's portable facade. */
export function createCloudflareSqliteDatabase(storage: DurableObjectStorage): SqliteDatabase {
  return {
    exec(sql): void {
      storage.sql.exec(sql);
    },

    prepare(sql): SqliteStatement {
      return createCloudflareSqliteStatement(storage.sql, sql);
    },

    transaction<T>(callback: () => T): T {
      return storage.transactionSync(callback);
    },

    close(): void {
      // The Durable Object runtime owns the SQLite connection lifetime.
    },
  };
}
