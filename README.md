# pi-durable on Cloudflare Durable Objects

Example of `@earendil-works/pi-durable` on Cloudflare. Each named session is its own Durable Object, with session data stored in SQLite using a custom adapter. The Durable Object opens the storage and constructs a transactional `Session` inside `blockConcurrencyWhile()`, so request methods always receive a ready Session and eviction reconstructs it over persisted data. The implementation also uses the built-in conformance test suite to verify the custom storage backend.

Sessions are created and accessed via these endpoints:

```text
POST /sessions/<name>  create the primary conversation idempotently
GET  /sessions/<name>  read the primary conversation
```

## Install

```sh
pnpm install
```

## Commands

From this directory:

```sh
pnpm format
pnpm test
pnpm benchmark
pnpm check
pnpm dev
```

`pnpm benchmark` runs the reusable pi-durable storage workloads against Cloudflare Durable Object SQLite in the local Workers runtime. Benchmark results vary by machine and are not production latency measurements.
