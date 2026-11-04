import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  type ConversationView,
  createRegistry,
  type EntryRecord,
  Harness,
  type HarnessOptions,
  type InboxState,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it } from "vitest";
import { createChatHarnessOptions } from "../src/chat.ts";
import { expectAlarm } from "./alarm.ts";
import worker from "../src/index.ts";
import { MAX_CLIENT_FRAME_CHARACTERS, queuedInputs } from "../src/protocol.ts";
import { DeliverScheduledInstruction } from "../src/schedule.ts";

type ProtocolMessage = {
  readonly type?: string;
  readonly conversationId?: number;
  readonly usernames?: readonly string[];
};

const userEntryText = (entry: EntryRecord): string | undefined => {
  const message = entry.model?.[0];
  if (message?.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
};

/** User texts in a view: entries of the window, and inputs queued in `pi.inbox`. */
const submittedTexts = (view: ConversationView | undefined): readonly string[] => [
  ...(view?.entries ?? []).flatMap((entry) => {
    const text = userEntryText(entry);
    return text === undefined ? [] : [text];
  }),
  ...queuedInputs(view?.docs["pi.inbox"] as InboxState | undefined).map(({ text }) => text),
];

const sessionSocketUrl = (sessionId: string, username: string, clientId: string): string => {
  const url = new URL(`https://example.com/api/sessions/${sessionId}`);
  url.searchParams.set("username", username);
  url.searchParams.set("_pk", clientId);
  return url.href;
};

const jsonMessages = (socket: WebSocket) => {
  const queued: unknown[] = [];
  const waiting: Array<(value: unknown) => void> = [];
  /** Each conversation's view as the frames received so far leave it. */
  const views = new Map<number, ConversationView>();
  socket.addEventListener("message", (event) => {
    const value: unknown = JSON.parse(String(event.data));
    const frame = value as {
      type?: string;
      conversationId?: number;
      view?: ConversationView;
      ops?: Op[];
    };
    if (frame.type === "conversation.view") views.set(frame.conversationId!, frame.view!);
    if (frame.type === "conversation.ops") {
      views.set(
        frame.conversationId!,
        applyImmutable(views.get(frame.conversationId!), frame.ops!),
      );
    }
    const resolve = waiting.shift();
    if (resolve === undefined) queued.push(value);
    else resolve(value);
  });
  const next = <T>(): Promise<T> => {
    const value = queued.shift();
    return value === undefined
      ? new Promise((resolve) => waiting.push((message) => resolve(message as T)))
      : Promise.resolve(value as T);
  };
  const nextMatching = async <T>(predicate: (value: T) => boolean): Promise<T> => {
    for (;;) {
      const value = await next<T>();
      if (predicate(value)) return value;
    }
  };
  return {
    views,
    next,
    nextMatching,
    /** Reads frames until the view of `conversationId` satisfies `predicate`. */
    untilView: async (
      conversationId: number,
      predicate: (view: ConversationView) => boolean,
    ): Promise<ConversationView> => {
      for (;;) {
        const view = views.get(conversationId);
        if (view !== undefined && predicate(view)) return view;
        await next();
      }
    },
    /** Session snapshot, root conversation view, and typing presence. */
    skipConnectFrames: async (): Promise<void> => {
      for (let index = 0; index < 3; index++) await next();
    },
  };
};

/**
 * Write state as an earlier process would have. The live Session keeps its own harness open, so seed through a
 * separate harness and then evict, letting the next request reopen the Session from storage.
 */
async function seedSession<T>(
  sessionId: string,
  options: HarnessOptions,
  seed: (harness: Harness) => Promise<T>,
): Promise<T> {
  const stub = env.SESSIONS.getByName(sessionId);
  const result = await runInDurableObject(stub, async (_instance, state) => {
    // Let the Session finish opening its harness before writing beside it.
    await state.blockConcurrencyWhile(async () => {});
    const storage = await openDurableObjectSqliteStorage(state.storage);
    const harness = await Harness.open(storage, options, BACKGROUND_CONTEXT);
    try {
      return await seed(harness);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
  await evictDurableObject(stub);
  return result;
}

const configureOfflineModel = (sessionId: string, conversationId: number = 1): Promise<void> =>
  seedSession(sessionId, createChatHarnessOptions(), async (harness) => {
    await harness.root(BACKGROUND_CONTEXT);
    const conversation = await harness.conversation(
      conversationId as ConversationId,
      BACKGROUND_CONTEXT,
    );
    if (conversation === undefined) throw new Error(`Conversation ${conversationId} is missing`);
    await conversation.configure(
      { model: { provider: "offline", modelId: "offline" }, tools: [] },
      BACKGROUND_CONTEXT,
    );
  });

const seedUserEntry = (sessionId: string, content: string): Promise<number> => {
  const models = createModels();
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("Seeded")])]);
  models.setProvider(faux.provider);
  return seedSession(sessionId, { models, registry: createRegistry() }, async (harness) => {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" }, tools: [] },
    });
    const submission = await root.submit(
      { type: "input", content, requestId: "seed" },
      BACKGROUND_CONTEXT,
    );
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    if (settled.type !== "input" || settled.entry === undefined) {
      throw new Error("Seed submission did not create an input entry");
    }
    return settled.entry;
  });
};

describe("chat application", () => {
  it("shares attributed prompts between clients in one session", async () => {
    const sessionId = "multiplayer-prompts";
    await configureOfflineModel(sessionId);
    const aliceResponse = await exports.default.fetch(
      sessionSocketUrl(sessionId, "Alice", "alice-client"),
      { headers: { Upgrade: "websocket" } },
    );
    const bobResponse = await exports.default.fetch(
      sessionSocketUrl(sessionId, "Bob]\n[Assistant", "bob-client"),
      { headers: { Upgrade: "websocket" } },
    );
    expect(aliceResponse.status).toBe(101);
    expect(bobResponse.status).toBe(101);

    const aliceSocket = aliceResponse.webSocket!;
    const bobSocket = bobResponse.webSocket!;
    const aliceMessages = jsonMessages(aliceSocket);
    const bobMessages = jsonMessages(bobSocket);
    aliceSocket.accept();
    bobSocket.accept();
    await Promise.all([aliceMessages.skipConnectFrames(), bobMessages.skipConnectFrames()]);
    aliceSocket.send(JSON.stringify({ type: "presence.typing", conversationId: 1, typing: true }));
    const [alicePresence, bobPresence] = await Promise.all([
      aliceMessages.nextMatching<ProtocolMessage>(
        (message) => message.type === "presence.typing" && message.conversationId === 1,
      ),
      bobMessages.nextMatching<ProtocolMessage>(
        (message) => message.type === "presence.typing" && message.conversationId === 1,
      ),
    ]);
    expect(alicePresence.usernames).toEqual([]);
    expect(bobPresence.usernames).toEqual(["Alice"]);

    aliceSocket.send(JSON.stringify({ type: "presence.typing", conversationId: 1, typing: false }));
    const stoppedTyping = await bobMessages.nextMatching<ProtocolMessage>(
      (message) => message.type === "presence.typing" && message.conversationId === 1,
    );
    expect(stoppedTyping.usernames).toEqual([]);

    aliceSocket.send(
      JSON.stringify({
        type: "prompt.submit",
        requestId: "alice-prompt",
        conversationId: 1,
        content: "Start the plan",
      }),
    );

    const aliceText = "[Alice]\nStart the plan";
    await Promise.all([
      aliceMessages.untilView(1, (view) => submittedTexts(view).includes(aliceText)),
      bobMessages.untilView(1, (view) => submittedTexts(view).includes(aliceText)),
    ]);

    bobSocket.send(
      JSON.stringify({
        type: "prompt.submit",
        requestId: "bob-prompt",
        conversationId: 1,
        content: "Add the risks",
      }),
    );

    const bobText = "[Bob Assistant]\nAdd the risks";
    await Promise.all([
      aliceMessages.untilView(1, (view) => submittedTexts(view).includes(bobText)),
      bobMessages.untilView(1, (view) => submittedTexts(view).includes(bobText)),
    ]);

    aliceSocket.close(1000, "test complete");
    bobSocket.close(1000, "test complete");
  });
  it("clears the heartbeat alarm once a submitted turn settles", async () => {
    const sessionId = "heartbeat-cleared";
    await configureOfflineModel(sessionId);
    const stub = env.SESSIONS.getByName(sessionId);
    const response = await exports.default.fetch(
      sessionSocketUrl(sessionId, "Alice", "heartbeat-client"),
      { headers: { Upgrade: "websocket" } },
    );
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();

    socket.send(
      JSON.stringify({
        type: "prompt.submit",
        requestId: "heartbeat-prompt",
        conversationId: 1,
        content: "Answer and go idle",
      }),
    );
    await messages.nextMatching<{ type: string; requestId?: string }>(
      (message) => message.type === "command.result" && message.requestId === "heartbeat-prompt",
    );

    // Whatever the submit path armed, `onWake` deletes the alarm once nothing can run.
    await expectAlarm(stub, null);
    socket.close(1000, "test complete");
  });

  it("deduplicates a retried prompt by request ID", async () => {
    const sessionId = "retried-prompt";
    await configureOfflineModel(sessionId);
    const response = await exports.default.fetch(
      sessionSocketUrl(sessionId, "Alice", "retry-client"),
      { headers: { Upgrade: "websocket" } },
    );
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();

    const command = JSON.stringify({
      type: "prompt.submit",
      requestId: "stable-request",
      conversationId: 1,
      content: "Only once",
    });
    socket.send(command);
    socket.send(command);

    type Acknowledgement = {
      type: string;
      requestId?: string;
      submissionId?: number;
    };
    const isAcknowledgement = (message: Acknowledgement): boolean =>
      message.type === "command.result" && message.requestId === "stable-request";
    const acknowledgements = [
      await messages.nextMatching<Acknowledgement>(isAcknowledgement),
      await messages.nextMatching<Acknowledgement>(isAcknowledgement),
    ];
    expect(acknowledgements[0]?.submissionId).toEqual(expect.any(Number));
    expect(acknowledgements[0]?.submissionId).toBe(acknowledgements[1]?.submissionId);

    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    socket.close(1000, "reconnect test");
    await closed;
    await evictDurableObject(env.SESSIONS.getByName(sessionId));
    const reopened = await exports.default.fetch(
      sessionSocketUrl(sessionId, "Alice", "retry-client-2"),
      { headers: { Upgrade: "websocket" } },
    );
    const reopenedSocket = reopened.webSocket!;
    const reopenedMessages = jsonMessages(reopenedSocket);
    reopenedSocket.accept();
    await reopenedMessages.skipConnectFrames();
    expect(
      submittedTexts(reopenedMessages.views.get(1)).filter((text) => text === "[Alice]\nOnly once"),
    ).toHaveLength(1);
    reopenedSocket.close(1000, "test complete");
  });
  it("acknowledges and deduplicates retried conversation creation", async () => {
    const sessionId = "retried-conversation-create";
    const command = JSON.stringify({
      type: "conversation.create",
      requestId: "stable-create-request",
    });
    const response = await exports.default.fetch(
      sessionSocketUrl(sessionId, "Alice", "create-retry-client"),
      { headers: { Upgrade: "websocket" } },
    );
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();

    socket.send(command);
    type CreateEvent = {
      type: string;
      requestId?: string;
      conversationId?: number;
    };
    const creationFrames: CreateEvent[] = [];
    while (
      !creationFrames.some(
        ({ type, requestId }) => type === "command.result" && requestId === "stable-create-request",
      ) ||
      !creationFrames.some(
        ({ type, conversationId }) => type === "conversation.view" && conversationId !== 1,
      )
    ) {
      creationFrames.push(await messages.next<CreateEvent>());
    }
    const acknowledgementIndex = creationFrames.findIndex(
      ({ type, requestId }) => type === "command.result" && requestId === "stable-create-request",
    );
    const watchIndex = creationFrames.findIndex(
      ({ type, conversationId }) => type === "conversation.view" && conversationId !== 1,
    );
    expect(watchIndex).toBeLessThan(acknowledgementIndex);
    const first = creationFrames[acknowledgementIndex]!;
    expect(first).toMatchObject({
      type: "command.result",
      requestId: "stable-create-request",
      conversationId: expect.any(Number),
    });

    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    socket.close(1000, "retry after eviction");
    await closed;
    await evictDurableObject(env.SESSIONS.getByName(sessionId));

    const reopened = await exports.default.fetch(
      sessionSocketUrl(sessionId, "Alice", "create-retry-client-2"),
      { headers: { Upgrade: "websocket" } },
    );
    const reopenedSocket = reopened.webSocket!;
    const reopenedMessages = jsonMessages(reopenedSocket);
    reopenedSocket.accept();
    const snapshot = await reopenedMessages.next<{
      type: string;
      session: { conversations: Array<{ id: number }> };
    }>();
    expect(snapshot.session.conversations).toHaveLength(2);
    for (let index = 0; index < 2; index++) await reopenedMessages.next();

    reopenedSocket.send(command);
    const retried = await reopenedMessages.nextMatching<CreateEvent>(
      ({ type, requestId }) => type === "command.result" && requestId === "stable-create-request",
    );
    expect(retried).toMatchObject({
      type: "command.result",
      requestId: "stable-create-request",
      conversationId: first.conversationId,
    });
    reopenedSocket.close(1000, "test complete");
  });

  it("creates an opaque session URL", async () => {
    const response = await exports.default.fetch("https://example.com/api/sessions", {
      method: "POST",
    });

    expect(response.status).toBe(201);
    const result = await response.json<{ sessionId: string; url: string }>();
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.url).toBe(`/sessions/${result.sessionId}`);
  });

  it("opens a session WebSocket with the root conversation", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/sessions/00000000-0000-4000-8000-000000000001",
      { headers: { Upgrade: "websocket" } },
    );

    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).toBeDefined();
    const messages = jsonMessages(socket!);
    socket!.accept();

    const session = await messages.next<{
      type: string;
      session: {
        conversations: Array<{ id: number }>;
        activity: { tasks: Record<string, unknown> };
      };
    }>();
    expect(session).toEqual({
      type: "session.snapshot",
      session: { conversations: [{ id: 1 }], activity: { tasks: {} } },
    });

    await expect(messages.next()).resolves.toMatchObject({
      type: "conversation.view",
      conversationId: 1,
      view: {
        conversation: { id: 1 },
        entries: [],
        docs: {
          "pi.agent": {
            model: { provider: "openai", modelId: "gpt-6-luna" },
            thinkingLevel: "off",
            tools: ["get_weather", "schedule", "search_history"],
          },
        },
      },
    });
    await expect(messages.next()).resolves.toEqual({
      type: "presence.typing",
      conversationId: 1,
      usernames: [],
    });

    socket!.close(1000, "test complete");
  });

  it("restores participant and conversation state after Durable Object eviction", async () => {
    const sessionId = "websocket-eviction";
    const response = await exports.default.fetch(
      sessionSocketUrl(sessionId, "Alice", "eviction-client"),
      { headers: { Upgrade: "websocket" } },
    );
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();

    socket.send(
      JSON.stringify({ type: "conversation.create", requestId: "create-before-eviction" }),
    );
    const created = await messages.nextMatching<{
      type: string;
      requestId?: string;
      conversationId?: number;
    }>(
      (message) =>
        message.type === "command.result" && message.requestId === "create-before-eviction",
    );
    expect(created.conversationId).toEqual(expect.any(Number));

    await evictDurableObject(env.SESSIONS.getByName(sessionId));
    await configureOfflineModel(sessionId, created.conversationId);
    socket.send(
      JSON.stringify({
        type: "prompt.submit",
        requestId: "prompt-after-eviction",
        conversationId: created.conversationId,
        content: "Continue here",
      }),
    );

    // The restarted object watches the conversation again for the hibernated socket: a fresh first value.
    const restored = await messages.nextMatching<ProtocolMessage>(
      (message) =>
        message.type === "conversation.view" && message.conversationId === created.conversationId,
    );
    expect(restored.conversationId).toBe(created.conversationId);
    await messages.untilView(created.conversationId!, (view) =>
      submittedTexts(view).includes("[Alice]\nContinue here"),
    );
    socket.close(1000, "test complete");
  });

  it("restores typing presence after Durable Object eviction", async () => {
    const sessionId = "typing-presence-eviction";
    const aliceResponse = await exports.default.fetch(
      sessionSocketUrl(sessionId, "Alice", "typing-alice"),
      { headers: { Upgrade: "websocket" } },
    );
    const bobResponse = await exports.default.fetch(
      sessionSocketUrl(sessionId, "Bob", "typing-bob"),
      { headers: { Upgrade: "websocket" } },
    );
    const aliceSocket = aliceResponse.webSocket!;
    const bobSocket = bobResponse.webSocket!;
    const aliceMessages = jsonMessages(aliceSocket);
    const bobMessages = jsonMessages(bobSocket);
    aliceSocket.accept();
    bobSocket.accept();
    await Promise.all([aliceMessages.skipConnectFrames(), bobMessages.skipConnectFrames()]);

    aliceSocket.send(JSON.stringify({ type: "presence.typing", conversationId: 1, typing: true }));
    await expect(
      bobMessages.nextMatching<ProtocolMessage>(
        (message) =>
          message.type === "presence.typing" &&
          message.conversationId === 1 &&
          message.usernames?.includes("Alice") === true,
      ),
    ).resolves.toMatchObject({ usernames: ["Alice"] });

    await evictDurableObject(env.SESSIONS.getByName(sessionId));
    bobSocket.send(
      JSON.stringify({
        type: "conversation.open",
        requestId: "wake-after-eviction",
        conversationId: 1,
      }),
    );

    await expect(
      bobMessages.nextMatching<ProtocolMessage>(
        (message) =>
          message.type === "presence.typing" &&
          message.conversationId === 1 &&
          message.usernames?.includes("Alice") === true,
      ),
    ).resolves.toMatchObject({ usernames: ["Alice"] });

    aliceSocket.close(1000, "test complete");
    bobSocket.close(1000, "test complete");
  });

  it("closes the WebSocket after a malformed command frame", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/sessions/malformed-frame",
      { headers: { Upgrade: "websocket" } },
    );
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );

    socket.send("{");

    await expect(messages.next()).resolves.toEqual({
      type: "error",
      error: { code: "invalid_command", message: "Message must contain valid JSON" },
    });
    await expect(closed).resolves.toMatchObject({ code: 1002 });
  });

  it("rejects oversized command frames before parsing", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/sessions/oversized-frame",
      { headers: { Upgrade: "websocket" } },
    );
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );

    socket.send("x".repeat(MAX_CLIENT_FRAME_CHARACTERS + 1));

    await expect(messages.next()).resolves.toEqual({
      type: "error",
      error: { code: "frame_too_large", message: "Command frame exceeds the size limit" },
    });
    await expect(closed).resolves.toMatchObject({ code: 1009 });
  });

  it("requires a GET WebSocket upgrade on session socket routes", async () => {
    const nonGetResponse = await worker.fetch(
      new Request("https://example.com/api/sessions/non-get-upgrade", {
        method: "POST",
        headers: { Upgrade: "websocket" },
      }),
      env,
    );

    expect(nonGetResponse.status).toBe(405);
    expect(nonGetResponse.headers.get("Allow")).toBe("GET");
    await nonGetResponse.body?.cancel();

    const nonUpgradeResponse = await worker.fetch(
      new Request("https://example.com/api/sessions/non-upgrade"),
      env,
    );
    expect(nonUpgradeResponse.status).toBe(426);
    expect(nonUpgradeResponse.headers.get("Upgrade")).toBe("websocket");
    await nonUpgradeResponse.body?.cancel();

    const extraSegmentResponse = await worker.fetch(
      new Request("https://example.com/api/sessions/opaque/extra", {
        headers: { Upgrade: "websocket" },
      }),
      env,
    );
    expect(extraSegmentResponse.status).toBe(404);
    await extraSegmentResponse.body?.cancel();
  });

  it("creates a durable fork at a committed transcript entry", async () => {
    const sessionId = "fork-over-websocket";
    const entryId = await seedUserEntry(sessionId, "Fork this");

    const response = await exports.default.fetch(`https://example.com/api/sessions/${sessionId}`, {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();

    socket.send(
      JSON.stringify({
        type: "conversation.fork",
        requestId: "fork-1",
        conversationId: 1,
        entryId,
      }),
    );

    type Event = {
      type: string;
      requestId?: string;
      ok?: boolean;
      conversationId?: number;
      session?: {
        conversations: Array<{
          id: number;
          parent?: { conversationId: number; at: number };
        }>;
      };
    };
    let forkId: number | undefined;
    let forkSummary: { id: number; parent?: { conversationId: number; at: number } } | undefined;
    let receivedForkSnapshot = false;
    for (
      let index = 0;
      index < 10 && (forkId === undefined || forkSummary === undefined || !receivedForkSnapshot);
      index++
    ) {
      const event = await messages.next<Event>();
      if (event.type === "command.result" && event.requestId === "fork-1" && event.ok) {
        forkId = event.conversationId;
      }
      if (event.type === "session.snapshot") {
        forkSummary = event.session?.conversations.find(({ parent }) => parent !== undefined);
      }
      if (event.type === "conversation.view" && event.conversationId !== 1) {
        receivedForkSnapshot = true;
      }
    }

    expect(forkId).toEqual(expect.any(Number));
    expect(forkSummary).toEqual({
      id: forkId,
      parent: { conversationId: 1, at: entryId },
    });
    expect(receivedForkSnapshot).toBe(true);
    socket.send(
      JSON.stringify({
        type: "conversation.fork",
        requestId: "fork-1",
        conversationId: 1,
        entryId,
      }),
    );
    const retryFrames: Event[] = [];
    while (
      !retryFrames.some(
        (event) => event.type === "command.result" && event.requestId === "fork-1",
      ) ||
      !retryFrames.some((event) => event.type === "session.snapshot")
    ) {
      retryFrames.push(await messages.next<Event>());
    }
    const retried = retryFrames.find(
      (event) => event.type === "command.result" && event.requestId === "fork-1",
    );
    expect(retried).toMatchObject({ ok: true, conversationId: forkId });
    const afterRetry = retryFrames.find((event) => event.type === "session.snapshot");
    expect(
      afterRetry?.session?.conversations.filter(({ parent }) => parent !== undefined),
    ).toHaveLength(1);
    socket.close(1000, "test complete");
  });

  it("pages transcript entries outside the view's window", async () => {
    const sessionId = "entries-paging";
    const input = await seedUserEntry(sessionId, "Page me");
    const response = await exports.default.fetch(`https://example.com/api/sessions/${sessionId}`, {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );
    type PageResult = {
      type: string;
      requestId?: string;
      ok?: boolean;
      page?: { items: EntryRecord[]; next?: unknown };
    };
    const requestPage = async (requestId: string, query: object): Promise<PageResult> => {
      socket.send(
        JSON.stringify({ type: "conversation.entries", requestId, conversationId: 1, ...query }),
      );
      return messages.nextMatching<PageResult>(
        (message) => message.type === "command.result" && message.requestId === requestId,
      );
    };

    // Newest first: the answer, with more before it.
    const newest = await requestPage("page-1", { order: "descending", limit: 1 });
    expect(newest.ok).toBe(true);
    expect(newest.page?.items).toHaveLength(1);
    expect(newest.page?.next).toBeDefined();
    // Up to the input, the first entry: nothing before it.
    const first = await requestPage("page-2", { maxEntryId: input, order: "descending", limit: 1 });
    expect(first.page?.items.map(({ id }) => id)).toEqual([input]);
    expect(first.page?.next).toBeUndefined();

    // Out-of-range limits are protocol errors.
    socket.send(
      JSON.stringify({
        type: "conversation.entries",
        requestId: "page-3",
        conversationId: 1,
        order: "ascending",
        limit: 1_000,
      }),
    );
    await expect(closed).resolves.toMatchObject({ code: 1002 });
  });

  it("lists subagent conversations with their owner", async () => {
    const sessionId = "owned-conversations-listed";
    // A task-owned conversation, as history search creates for its subagent.
    const childId = await seedSession(sessionId, createChatHarnessOptions(), async (harness) => {
      const root = await harness.root(BACKGROUND_CONTEXT);
      return root.commit(async (tx) => {
        const task = await tx.createTask(
          DeliverScheduledInstruction,
          {
            id: "schedule:owner",
            conversationId: root.id,
            instruction: "Owner only",
            runAt: Date.now() + 3_600_000,
          },
          { ownership: { kind: "conversation" }, background: true },
        );
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: task },
        });
        return child.id;
      }, BACKGROUND_CONTEXT);
    });

    const response = await exports.default.fetch(`https://example.com/api/sessions/${sessionId}`, {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    // The reopened Session resumes the delivery, which goes to sleep: its activity update may precede the snapshot.
    const snapshot = await messages.nextMatching<{
      type: string;
      session: {
        conversations: unknown[];
        activity: { tasks: Record<string, unknown> };
      };
    }>(({ type }) => type === "session.snapshot");
    expect(snapshot).toMatchObject({
      type: "session.snapshot",
      session: {
        conversations: [{ id: 1 }, { id: childId, owner: { conversationId: 1 } }],
      },
    });
    expect(Object.values(snapshot.session.activity.tasks)).toEqual([
      expect.objectContaining({
        kind: "app.deliver-scheduled-instruction",
        conversationId: 1,
        background: true,
        conversations: [childId],
      }),
    ]);
    socket.close(1000, "test complete");
  });
});
