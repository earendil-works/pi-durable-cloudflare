# pi-durable on Cloudflare

A working example of [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) running in a Cloudflare Durable Object.

Start with the [Pi Durable announcement](https://earendil.com/posts/pi-durable/) for the ideas behind the harness. This repository shows one way to put those ideas into a small, usable web application.

Pi Durable is experimental, so its APIs may still change.

## What you can try

- Create a shared chat session and open it in multiple browsers.
- Run several conversations at once and fork a conversation from an earlier message.
- Reconnect without losing committed transcripts or queued prompts.
- Schedule one-time or recurring follow-ups.
- Ask a search subagent about earlier conversations.
- Open Activity to inspect live task ownership, waits, tool calls, and background work while conversations run.

This is a sample, not a production service. It intentionally has no authentication or rate limiting.

## Run it locally

You need Node.js 22.19 or newer, pnpm 11, and an OpenAI API key.

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

Add your key to `.dev.vars`:

```dotenv
OPENAI_API_KEY=your-key
```

Then start the Worker and React client together:

```sh
pnpm dev
```

Open the local URL printed by Vite, create a session, and send a message. Open the session URL in another browser to try the multiplayer flow.

## Where to look

The shortest path through the project is:

- [`src/chat.ts`](src/chat.ts) defines the models, extensions, tools, and default agent.
- [`src/session.ts`](src/session.ts) hosts the harness with Pi Durable's built-in Durable Object SQLite storage and connects it to Cloudflare's native hibernating WebSockets and alarms.
- [`src/tools.ts`](src/tools.ts), [`src/schedule.ts`](src/schedule.ts), and [`src/search.ts`](src/search.ts) contain the example tools and tasks.
- [`src/client/`](src/client/) is the React client and its event-driven session state.
- [`test/`](test/) covers application flows including restart recovery, scheduling, forks, and inboxes, and runs pi-durable's storage conformance suite against the built-in Cloudflare adapter.

The code is the documentation for this integration. In particular, the tests are useful examples of restart behavior, scheduling, forks, inboxes, and storage conformance.

## Commands

```sh
pnpm dev        # local development
pnpm test       # test suite
pnpm check      # formatting, types, build, and deploy dry run
pnpm build      # production build
pnpm preview    # preview the production build locally
```

## Deploy

Authenticate Wrangler, store the API key as a Worker secret, then deploy:

```sh
pnpm exec wrangler login
pnpm exec wrangler secret put OPENAI_API_KEY
pnpm deploy
```

Before exposing a deployment, add authentication, authorization, and rate limiting. Anyone who can reach this sample can create sessions that use your model credentials.

## Further reading

- [Pi Durable announcement](https://earendil.com/posts/pi-durable/)
- [pi-durable package documentation](https://github.com/earendil-works/pi/tree/main/packages/durable)
- [pi-durable examples](https://github.com/earendil-works/pi/tree/main/packages/durable/test/examples)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
