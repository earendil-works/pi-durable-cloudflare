import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { type EntryId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { createCloudflareSqliteDatabase } from "../src/sqlite.ts";

const context = BACKGROUND_CONTEXT;

registerStorageConformance(
  { describe, expect, it },
  "Cloudflare Durable Object SQLite",
  async (use) => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, async (instance) => use(await instance.storage));
  },
);

describe("Cloudflare Durable Object example", () => {
  it("adapts binary values and rejects bigint query parameters", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (_instance, state) => {
      const database = createCloudflareSqliteDatabase(state.storage);
      const statement = database.prepare("SELECT ? AS value");
      const bytes = new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4);
      expect(statement.get<{ readonly value: Uint8Array }>(bytes)).toEqual({
        value: new Uint8Array([1, 2, 3]),
      });
      expect(() => statement.get(1n)).toThrow("does not accept bigint query parameters");
    });
  });

  it("creates named sessions idempotently and reconstructs Session after eviction", async () => {
    const url = "https://example.com/sessions/example";
    const missing = await exports.default.fetch(url);
    expect(missing.status).toBe(404);

    const created = await Promise.all([
      exports.default.fetch(url, { method: "POST" }),
      exports.default.fetch(url, { method: "POST" }),
    ]);
    expect(created.map(({ status }) => status).sort()).toEqual([200, 201]);
    const conversations = await Promise.all(created.map((response) => response.json()));
    expect(conversations[0]).toMatchObject({ id: expect.any(Number) });
    expect(conversations[1]).toEqual(conversations[0]);

    await evictDurableObject(env.SESSIONS.getByName("example"));

    const fetched = await exports.default.fetch(url);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(conversations[0]);
  });

  it("adopts a legacy root conversation without losing its entries", async () => {
    const stub = env.SESSIONS.getByName("legacy-root");
    const entryId = await runInDurableObject(stub, async (instance) => {
      const storage = await instance.storage;
      await storage.commit(
        [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
        context,
      );
      const id = await storage.mintId<EntryId>();
      await storage.commit(
        [
          {
            type: "entry",
            value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "legacy" },
          },
        ],
        context,
      );
      return id;
    });

    const migrated = await exports.default.fetch("https://example.com/sessions/legacy-root");
    expect(migrated.status).toBe(200);
    expect(await migrated.json()).toEqual({ id: ROOT_CONVERSATION_ID });

    await evictDurableObject(stub);

    const fetched = await exports.default.fetch("https://example.com/sessions/legacy-root");
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual({ id: ROOT_CONVERSATION_ID });

    const recovered = await runInDurableObject(stub, async (instance) =>
      (await instance.storage).entry(ROOT_CONVERSATION_ID, entryId, context),
    );
    expect(recovered?.entry).toEqual({
      id: entryId,
      conversationId: ROOT_CONVERSATION_ID,
      kind: "legacy",
    });
  });

  it("fails when primary conversation metadata is dangling", async () => {
    const stub = env.SESSIONS.getByName("dangling-primary");
    const created = await stub.createPrimaryConversation();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec("DELETE FROM conversations WHERE id = ?", created.conversation.id);
      await expect(instance.primaryConversation()).rejects.toMatchObject({
        code: "PRIMARY_CONVERSATION_MISSING",
      });
    });
  });

  it("reopens SqliteStorage over persisted Durable Object data after eviction", async () => {
    const stub = env.SESSIONS.getByName("eviction");
    const entryId = await runInDurableObject(stub, async (instance) => {
      const storage = await instance.storage;
      await storage.commit(
        [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
        context,
      );
      const id = await storage.mintId<EntryId>();
      await storage.commit(
        [
          {
            type: "entry",
            value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "before-eviction" },
          },
        ],
        context,
      );
      return id;
    });

    await evictDurableObject(stub);

    const recovered = await runInDurableObject(stub, async (instance) =>
      (await instance.storage).entry(ROOT_CONVERSATION_ID, entryId, context),
    );
    expect(recovered).toEqual({
      entry: {
        id: entryId,
        conversationId: ROOT_CONVERSATION_ID,
        kind: "before-eviction",
      },
      commitSeq: 2,
    });
  });
});
