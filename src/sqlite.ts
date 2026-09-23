import type {
  SqliteDatabase,
  SqliteStatement,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

const binding = (value: SqliteValue): SqlStorageValue => {
  if (typeof value === "bigint") {
    throw new TypeError("Cloudflare Durable Object SQLite does not support bigint bindings");
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

class CloudflareSqliteStatement implements SqliteStatement {
  private readonly sql: SqlStorage;
  private readonly query: string;

  constructor(sql: SqlStorage, query: string) {
    this.sql = sql;
    this.query = query;
  }

  run(...params: SqliteValue[]): void {
    this.sql.exec(this.query, ...params.map(binding));
  }

  get<T extends object>(...params: SqliteValue[]): T | undefined {
    const result = this.sql.exec(this.query, ...params.map(binding)).next();
    return result.done ? undefined : row<T>(result.value);
  }

  all<T extends object>(...params: SqliteValue[]): T[] {
    return this.sql
      .exec(this.query, ...params.map(binding))
      .toArray()
      .map(row<T>);
  }
}

/** Adapts one Durable Object's synchronous SQLite API to pi-durable's portable facade. */
export class CloudflareSqliteDatabase implements SqliteDatabase {
  private readonly storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }

  exec(sql: string): void {
    this.storage.sql.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new CloudflareSqliteStatement(this.storage.sql, sql);
  }

  transaction<T>(callback: () => T): T {
    return this.storage.transactionSync(callback);
  }

  close(): void {
    // The Durable Object runtime owns the SQLite connection lifetime.
  }
}
