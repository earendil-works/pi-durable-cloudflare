# pi-durable on Cloudflare Durable Objects

Example of an `@earendil-works/pi-durable` Harness hosted in a Cloudflare Durable Object. Each named agent session is one Durable Object, with Harness state stored in SQLite through a custom storage adapter.

The platform-independent composition in `src/agent.ts` owns the model collection and extension registry. The Durable Object opens SQLite and the Harness inside `blockConcurrencyWhile()`, so event delivery starts only after local initialization completes and eviction reconstructs the Harness over persisted state.

The temporary HTTP surface treats each named session as one replaceable Harness configuration resource:

```text
GET /session/<id>  read the root conversation's configuration
PUT /session/<id>  create the root if needed and replace its configuration
```

`PUT` accepts the built-in `ConversationConfigState`: `{ "model"?: { "provider": "...", "modelId": "..." }, "thinkingLevel": "...", "activeTools": ["..."] }`. Omit `model` to clear model selection. Active tool names must exist in the application registry.

A future `POST /session/<id>/prompt` route should use durable submissions once the Harness implements the submission and turn-execution loop. This sample does not append a user entry and pretend that an agent ran.

The project also runs pi-durable's reusable storage conformance and benchmark suites against Cloudflare Durable Object SQLite.

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

`pnpm benchmark` runs the reusable pi-durable storage workloads in the local Workers runtime. Results vary by machine and are not production latency measurements.
