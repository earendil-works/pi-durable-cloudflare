# pi-durable on Cloudflare Durable Objects

Example of an `@earendil-works/pi-durable` Harness hosted in a Cloudflare Durable Object. Each named agent session is one Durable Object, with Harness state stored in SQLite through a custom storage adapter.

The platform-independent chat composition in `src/chat.ts` owns the model collection and extension registry. The Durable Object opens SQLite and the Harness inside `blockConcurrencyWhile()`, so event delivery starts only after local initialization completes and eviction reconstructs the Harness over persisted state.

While durable tasks remain unfinished, the Durable Object keeps a recovery alarm armed. The alarm reconstructs and resumes work after eviction without relying on `waitUntil()`, which does not extend Durable Object lifetime.

The temporary HTTP surface exposes one root conversation per named session:

> [!WARNING]
> This demo HTTP surface intentionally has no authentication. Do not expose it publicly with a production API key without adding access control and rate limiting.

```text
GET /session/<id>  read the root conversation's configuration
PUT /session/<id>  create the root if needed and replace its configuration
POST /session/<id>/prompt  submit a text turn and wait for its durable result
```

`PUT` accepts the built-in `ConversationConfigState`, including `model`, `thinkingLevel`, `activeTools`, `streamOptions`, and `retry`. Omit an optional field to clear it. Active tool names must exist in the application registry.

The application registry includes OpenAI models. For local development, copy the example environment file and set the key in `.dev.vars`:

```sh
cp .dev.vars.example .dev.vars
```

For a deployed Worker, store the key as a secret:

```sh
pnpm exec wrangler secret put OPENAI_API_KEY
```

`POST` accepts an input submission with text content. `requestId` is optional but recommended because retries with the same ID reacquire the existing durable submission:

```json
{
  "type": "input",
  "content": "Explain durable execution in one sentence.",
  "requestId": "turn-1"
}
```

The route waits for the Harness submission. A completed turn returns the settled submission and its `pi.assistant` entry. A terminal turn without an answer returns `status: "unanswered"` and its reason, such as `no_model`. This temporary endpoint supports text input only.

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
