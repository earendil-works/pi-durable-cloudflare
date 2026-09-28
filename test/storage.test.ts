import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { type EntryId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { createCloudflareSqliteDatabase } from "../src/sqlite.ts";
import worker from "../src/index.ts";

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

  it("replaces Harness configuration idempotently and restores it after eviction", async () => {
    const url = "https://example.com/session/example";
    const missing = await exports.default.fetch(url);
    expect(missing.status).toBe(404);

    const expectedConfig = {
      model: { provider: "example", modelId: "test-model" },
      thinkingLevel: "high",
      activeTools: [],
    };
    const put = () =>
      exports.default.fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(expectedConfig),
      });
    const configured = await Promise.all([put(), put()]);
    expect(configured.map(({ status }) => status)).toEqual([200, 200]);
    expect(await Promise.all(configured.map((response) => response.json()))).toEqual([
      expectedConfig,
      expectedConfig,
    ]);

    const cleared = await exports.default.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thinkingLevel: "off", activeTools: [] }),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ thinkingLevel: "off", activeTools: [] });

    const restored = await put();
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual(expectedConfig);

    await evictDurableObject(env.SESSIONS.getByName("example"));

    const fetched = await exports.default.fetch(url);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(expectedConfig);
  });

  it("returns 400 for invalid configuration input and propagates unexpected JSON reader failures", async () => {
    const url = "https://example.com/session/invalid";
    for (const body of ["{", "{}"]) {
      const response = await exports.default.fetch(url, { method: "PUT", body });
      expect(response.status).toBe(400);
    }

    const request = new Request(url, { method: "PUT", body: "{}" });
    Object.defineProperty(request, "json", {
      value: async () => {
        throw new Error("body read failed");
      },
    });
    await expect(worker.fetch(request, env)).rejects.toThrow("body read failed");
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
