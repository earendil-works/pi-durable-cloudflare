import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ConversationConfig } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { describe, expect, it } from "vitest";
import { openChatHarness } from "../src/chat.ts";
import { MAX_CLIENT_FRAME_CHARACTERS } from "../src/protocol.ts";
import { DeliverScheduledInstruction } from "../src/schedule.ts";
import { createCloudflareSqliteDatabase } from "../src/sqlite.ts";

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
  return {
    next,
    /** Session snapshot, root conversation events, and root inbox. */
    skipConnectFrames: async (): Promise<void> => {
      for (let index = 0; index < 3; index++) await next();
    },
  };
};

async function seedUserEntry(sessionId: string, content: string): Promise<number> {
  const stub = env.SESSIONS.getByName(sessionId);
  return runInDurableObject(stub, async (_instance, state) => {
    const storage = await SqliteStorage.open(createCloudflareSqliteDatabase(state.storage));
    const harness = await openChatHarness(storage, BACKGROUND_CONTEXT, {
      scheduleCreated: (runAt) => state.storage.setAlarm(runAt),
    });
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, {
        init: async (tx, conversationId) => {
          Object.assign(await tx.doc(ConversationConfig, conversationId), {
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
      "https://example.com/api/sessions/00000000-0000-4000-8000-000000000001/connect",
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

    socket!.close(1000, "test complete");
  });

  it("restores a watched conversation after Durable Object eviction", async () => {
    const sessionId = "websocket-eviction";
    const response = await exports.default.fetch(
      `https://example.com/api/sessions/${sessionId}/connect`,
      { headers: { Upgrade: "websocket" } },
    );
    const socket = response.webSocket!;
    const messages = jsonMessages(socket);
    socket.accept();
    await messages.skipConnectFrames();

    await evictDurableObject(env.SESSIONS.getByName(sessionId));
    socket.send(
      JSON.stringify({
        type: "conversation.create",
        requestId: "create-after-eviction",
      }),
    );

    const restored = await messages.next<{
      type: string;
      conversationId?: number;
      events?: Array<{ type: string }>;
    }>();
    expect(restored).toMatchObject({
      type: "conversation.events",
      conversationId: 1,
      events: [{ type: "snapshot" }],
    });
    socket.close(1000, "test complete");
  });

  it("closes the WebSocket after a malformed command frame", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/sessions/malformed-frame/connect",
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
      "https://example.com/api/sessions/oversized-frame/connect",
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

  it("requires GET for a WebSocket upgrade", async () => {
    const response = await exports.default.fetch(
      "https://example.com/api/sessions/non-get-upgrade/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    await response.body?.cancel();
  });

  it("creates a durable fork at a committed transcript entry", async () => {
    const sessionId = "fork-over-websocket";
    const entryId = await seedUserEntry(sessionId, "Fork this");
    await evictDurableObject(env.SESSIONS.getByName(sessionId));

    const response = await exports.default.fetch(
      `https://example.com/api/sessions/${sessionId}/connect`,
      { headers: { Upgrade: "websocket" } },
    );
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

    const response = await exports.default.fetch(
      `https://example.com/api/sessions/${sessionId}/connect`,
      { headers: { Upgrade: "websocket" } },
    );
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
