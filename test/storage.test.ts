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

  it("routes named sessions and creates the root conversation idempotently", async () => {
    const url = "https://example.com/sessions/example";
    const missing = await exports.default.fetch(url);
    expect(missing.status).toBe(404);

    const created = await exports.default.fetch(url, { method: "POST" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: 1 });

    const repeated = await exports.default.fetch(url, { method: "POST" });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ id: 1 });

    const fetched = await exports.default.fetch(url);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual({ id: 1 });
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
