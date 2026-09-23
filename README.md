# pi-durable on Cloudflare Durable Objects

Example of `@earendil-works/pi-durable`'s for Cloudflare. Each session is its own Durable Object, with session data stored in SQLite using a custom adapter. This implementation shows how to use the built-in conformance test suite to ensure a custom storage backend works correctly.

Sessions are created and accessed via these endpoints:

```text
POST /sessions/<name>  create the root conversation idempotently
GET  /sessions/<name>  read the root conversation
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
pnpm check
pnpm dev
```
