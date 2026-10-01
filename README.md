# pi-durable on Cloudflare Durable Objects

Example of an `@earendil-works/pi-durable` Harness hosted in a Cloudflare Durable Object. Each named agent session is one Durable Object, with Harness state stored in SQLite through a custom storage adapter.

The platform-independent chat composition in `src/chat.ts` owns the model collection and extension registry. The Durable Object opens SQLite and the Harness inside `blockConcurrencyWhile()`, so event delivery starts only after local initialization completes and eviction reconstructs the Harness over persisted state.

The browser demo is a small React application built with Vite and served through Workers Static Assets. Its landing page chooses a display name and creates an opaque session URL. Opening a shared session URL in a browser without a stored display name prompts the participant to enter one before connecting. The session view uses a reconnecting PartySocket to display durable transcripts, create independent conversations, and fork a conversation at a committed user or assistant entry. Multiple clients can join the same session and submit prompts; the server prefixes each durable user message with the submitting connection's display name. New UI conversations use the server-selected `gpt-6-luna` model.

The application registry includes three custom tools, all active for new conversations. `get_weather` is based on Cloudflare's voice-agent example and returns randomized mock Fahrenheit weather. `schedule` accepts an instruction and either a relative `delaySeconds` or an absolute ISO 8601 `at`, immediately creates a durable Harness task, and delivers the instruction to the same conversation as a self-contained input when it is due. Repeating schedules persist a structured cadence and IANA timezone. Minute and hour deadlines advance by fixed elapsed durations; day, week, and month deadlines preserve local wall-clock time across timezone offset changes. Successors advance from the previous deadline, skip elapsed occurrences, and are stored as UTC epoch timestamps. A recurring delivery may create only one successor, enforced atomically through its durable source schedule.

`recall` is a foreground subagent: it answers questions about other conversations in the session, such as earlier decisions. The tool call creates a child conversation it owns, whose only tool is `search_conversations`, a case-insensitive substring search over user and assistant messages. The child searches, reads the matches, and replies briefly; the parent receives only that answer, so raw matches never enter its context. Each subagent is its own conversation, listed in the sidebar as `Subagent (id, owner)`, where `owner` is the conversation that asked; opening it shows the child's searches and answer. Search skips subagent conversations and the conversation that asked, so recall does not cite its own question or earlier recall answers.

Prompts sent by any participant while a conversation is busy are queued in its durable inbox and answered in order after the current turn; every client watching that conversation sees them as queued until they are placed. Ephemeral per-conversation presence shows who is actively typing without writing presence into the durable transcript.

Per-conversation updates use pi-durable's experimental `watchEvents()` API. Each watch starts with an atomic snapshot and then sends semantic event batches for committed transcript and streaming changes. The browser reduces those events into application-owned React state; pi-durable does not generate the UI. A small custom session-wide snapshot remains for the conversation sidebar because `watchEvents()` is conversation-scoped. PartyServer stores each connection's display name and selected conversation in its hibernation attachment. PartySocket reconnects dropped browser connections, which receive fresh durable snapshots and retry any unacknowledged prompt with the same deduplicating request ID.

The Durable Object projects the earliest application-scheduled deadline onto its single platform alarm and also uses that alarm for Harness recovery. `Harness.inspect()` does not currently expose the private wake deadlines of built-in retry, deferred-generation, or compaction tasks, so any other actionable live task keeps a conservative recovery alarm armed for no later than 60 seconds. In-memory task-settlement watches reconcile the alarm sooner while the object remains active. When Cloudflare wakes or reconstructs the object, `Harness.resume()` continues each task from its durable checkpoint. Scheduled delivery uses stable request IDs and does not rely on `waitUntil()`, which does not extend Durable Object lifetime.

The browser surface uses:

```text
POST /api/sessions                         create an opaque session URL
GET  /api/sessions/<id>                    upgrade to the PartyServer WebSocket
GET  /sessions/<id>                        load the React session view
```

> [!WARNING]
> This demo intentionally has no authentication. Do not expose it publicly with a production API key without adding access control and rate limiting.

The application registry includes OpenAI models. For local development, copy the example environment file and set the key in `.dev.vars`:

```sh
cp .dev.vars.example .dev.vars
```

For a deployed Worker, store the key as a secret:

```sh
pnpm exec wrangler secret put OPENAI_API_KEY
```

The project also runs pi-durable's reusable storage conformance and benchmark suites against Cloudflare Durable Object SQLite.

## Install

Pi packages are unpublished preview builds. Build them into a local artifact set from a Pi checkout, then point this project at it:

```sh
# In the Pi checkout
npm run pack:packages -- --out .artifacts/pi-packages
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer <path-to-this-project> \
  --package @earendil-works/pi-durable \
  --package @earendil-works/pi-ai \
  --package @earendil-works/chord \
  --package-manager pnpm
```

This rewrites the `package.json` dependencies and `pnpm-workspace.yaml` overrides to the generated tarballs. Then, in this project:

```sh
pnpm install --ignore-scripts
```

## Commands

From this directory:

```sh
pnpm format
pnpm test
pnpm benchmark
pnpm check
pnpm build
pnpm dev
```

`pnpm dev` runs the React UI and Worker together through Cloudflare's Vite plugin with hot module replacement. Use `pnpm preview` to run a production build locally in the Workers runtime.

`pnpm benchmark` runs the reusable pi-durable storage workloads in the local Workers runtime. Results vary by machine and are not production latency measurements.
