import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  ConversationConfig,
  type ConversationId,
  createRegistry,
  Harness,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { describe, expect, it } from "vitest";
import { openChatHarness } from "../src/chat.ts";
import worker from "../src/index.ts";
import { MAX_CLIENT_FRAME_CHARACTERS } from "../src/protocol.ts";
import { DeliverScheduledInstruction } from "../src/schedule.ts";
import { createCloudflareSqliteDatabase } from "../src/sqlite.ts";

type ProtocolMessage = {
  readonly type?: string;
  readonly conversationId?: number;
  readonly events?: readonly unknown[];
  readonly items?: readonly { readonly text?: unknown }[];
  readonly usernames?: readonly string[];
};

const userEntryText = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as {
    readonly model?: readonly { readonly role?: unknown; readonly content?: unknown }[];
  };
  const message = entry.model?.[0];
  if (message?.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .flatMap((part) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
};

const submittedTexts = (message: ProtocolMessage): readonly string[] => {
  if (message.type === "conversation.inbox") {
    return (message.items ?? []).flatMap(({ text }) => (typeof text === "string" ? [text] : []));
  }
  if (message.type !== "conversation.events") return [];
  return (message.events ?? []).flatMap((event) => {
    if (typeof event !== "object" || event === null) return [];
    if ("entry" in event) {
      const text = userEntryText(event.entry);
      return text === undefined ? [] : [text];
    }
    if ("entries" in event && Array.isArray(event.entries)) {
      return event.entries.flatMap((entry) => {
        const text = userEntryText(entry);
        return text === undefined ? [] : [text];
      });
    }
    return [];
  });
};

const sessionSocketUrl = (sessionId: string, username: string, clientId: string): string => {
  const url = new URL(`https://example.com/api/sessions/${sessionId}`);
  url.searchParams.set("username", username);
  url.searchParams.set("_pk", clientId);
  return url.href;
};

const jsonMessages = (socket: WebSocket) => {
  const queued: unknown[] = [];
  const waiting: Array<(value: unknown) => void> = [];
  socket.addEventListener("message", (event) => {
    const value: unknown = JSON.parse(String(event.data));
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
    next,
    nextMatching,
    /** Session snapshot, root conversation events, root inbox, and typing presence. */
    skipConnectFrames: async (): Promise<void> => {
      for (let index = 0; index < 4; index++) await next();
    },
  };
};

async function configureOfflineModel(sessionId: string, conversationId: number = 1): Promise<void> {
  const stub = env.SESSIONS.getByName(sessionId);
  await runInDurableObject(stub, async (_instance, state) => {
    const storage = await SqliteStorage.open(createCloudflareSqliteDatabase(state.storage));
    const harness = await openChatHarness(storage, BACKGROUND_CONTEXT, {
      scheduleCreated: async () => {},
    });
    try {
      await harness.root(BACKGROUND_CONTEXT);
      await harness.commit(async (tx) => {
        Object.assign(await tx.doc(ConversationConfig, conversationId as ConversationId), {
          model: { provider: "offline", modelId: "offline" },
          thinkingLevel: "off",
          activeTools: [],
        });
      }, BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
}

async function seedUserEntry(sessionId: string, content: string): Promise<number> {
  const stub = env.SESSIONS.getByName(sessionId);
  return runInDurableObject(stub, async (_instance, state) => {
    const storage = await SqliteStorage.open(createCloudflareSqliteDatabase(state.storage));
    const models = createModels();
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage([fauxText("Seeded")])]);
    models.setProvider(faux.provider);
    const harness = await Harness.open(
      storage,
      { models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, {
        init: async (tx, conversationId) => {
          Object.assign(await tx.doc(ConversationConfig, conversationId), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
            activeTools: [],
          });
        },
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
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
}

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
    const aliceViews = await Promise.all([
      aliceMessages.nextMatching<ProtocolMessage>((message) =>
        submittedTexts(message).includes(aliceText),
      ),
      bobMessages.nextMatching<ProtocolMessage>((message) =>
        submittedTexts(message).includes(aliceText),
      ),
    ]);
    expect(aliceViews.map(submittedTexts)).toEqual([
      expect.arrayContaining([aliceText]),
      expect.arrayContaining([aliceText]),
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
    const bobViews = await Promise.all([
      aliceMessages.nextMatching<ProtocolMessage>((message) =>
        submittedTexts(message).includes(bobText),
      ),
      bobMessages.nextMatching<ProtocolMessage>((message) =>
        submittedTexts(message).includes(bobText),
      ),
    ]);
    expect(bobViews.map(submittedTexts)).toEqual([
      expect.arrayContaining([bobText]),
      expect.arrayContaining([bobText]),
    ]);

    aliceSocket.close(1000, "test complete");
    bobSocket.close(1000, "test complete");
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
    await reopenedMessages.next();
    const snapshot = await reopenedMessages.next<ProtocolMessage>();
    expect(submittedTexts(snapshot).filter((text) => text === "[Alice]\nOnly once")).toHaveLength(
      1,
    );
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
      session: { conversations: Array<{ id: number }> };
    }>();
    expect(session).toEqual({
      type: "session.snapshot",
      session: { conversations: [{ id: 1 }] },
    });

    const conversation = await messages.next<{
      type: string;
      conversationId: number;
      events: Array<{ type: string; entries?: unknown[] }>;
    }>();
    expect(conversation).toMatchObject({
      type: "conversation.events",
      conversationId: 1,
      events: [
        {
          type: "snapshot",
          entries: [],
          config: { activeTools: ["get_weather", "schedule", "recall"] },
        },
      ],
    });

    await expect(messages.next()).resolves.toEqual({
      type: "conversation.inbox",
      conversationId: 1,
      items: [],
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
    await evictDurableObject(env.SESSIONS.getByName(sessionId));
    socket.send(
      JSON.stringify({
        type: "prompt.submit",
        requestId: "prompt-after-eviction",
        conversationId: created.conversationId,
        content: "Continue here",
      }),
    );

    const restored = await messages.nextMatching<ProtocolMessage>(
      (message) =>
        message.type === "conversation.events" &&
        message.conversationId === created.conversationId &&
        (message.events?.some(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "snapshot",
        ) ??
          false),
    );
    expect(restored.conversationId).toBe(created.conversationId);
    const attributed = await messages.nextMatching<ProtocolMessage>((message) =>
      submittedTexts(message).includes("[Alice]\nContinue here"),
    );
    expect(submittedTexts(attributed)).toContain("[Alice]\nContinue here");
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
    await evictDurableObject(env.SESSIONS.getByName(sessionId));

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
      events?: Array<{ type: string }>;
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
      if (
        event.type === "conversation.events" &&
        event.conversationId !== 1 &&
        event.events?.[0]?.type === "snapshot"
      ) {
        receivedForkSnapshot = true;
      }
    }

    expect(forkId).toEqual(expect.any(Number));
    expect(forkSummary).toEqual({
      id: forkId,
      parent: { conversationId: 1, at: entryId },
    });
    expect(receivedForkSnapshot).toBe(true);
    socket.close(1000, "test complete");
  });

  it("lists subagent conversations with their owner", async () => {
    const sessionId = "owned-conversations-listed";
    // A task-owned conversation, as recall creates for its subagent.
    const childId = await runInDurableObject(
      env.SESSIONS.getByName(sessionId),
      async (_instance, state) => {
        const storage = await SqliteStorage.open(createCloudflareSqliteDatabase(state.storage));
        const harness = await openChatHarness(storage, BACKGROUND_CONTEXT, {
          scheduleCreated: async () => {},
        });
        try {
          const root = await harness.root(BACKGROUND_CONTEXT);
          return await root.commit(async (tx) => {
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
        } finally {
          await harness.close(BACKGROUND_CONTEXT);
        }
      },
    );

    const response = await exports.default.fetch(`https://example.com/api/sessions/${sessionId}`, {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await expect(messages.next()).resolves.toEqual({
      type: "session.snapshot",
      session: { conversations: [{ id: 1 }, { id: childId, owner: { conversationId: 1 } }] },
    });
    socket.close(1000, "test complete");
  });
});
