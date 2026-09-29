import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  type EntryId,
  Harness,
  type Harness as PiHarness,
  ROOT_CONVERSATION_ID,
  type Storage,
} from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { describe, expect, it } from "vitest";
import { createCloudflareSqliteDatabase } from "../src/sqlite.ts";

const context = BACKGROUND_CONTEXT;

const openStorage = (state: DurableObjectState): Promise<SqliteStorage> =>
  SqliteStorage.open(createCloudflareSqliteDatabase(state.storage));

async function openFauxHarness(
  storage: Storage,
  responses: readonly FauxResponseStep[],
): Promise<PiHarness> {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([...responses]);
  return Harness.open(storage, { models, registry: createRegistry() }, context);
}

registerStorageConformance(
  { describe, expect, it },
  "Cloudflare Durable Object SQLite",
  async (use) => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, async (_instance, state) => use(await openStorage(state)));
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
    await missing.body?.cancel();

    const expectedConfig = {
      model: { provider: "example", modelId: "test-model" },
      thinkingLevel: "high",
      activeTools: [],
      streamOptions: {
        timeoutMs: 30_000,
        metadata: { environment: "test" },
        deferred: { window: "15m" },
      },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 },
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

  it("does not confuse a session named prompt with the prompt subroute", async () => {
    const response = await exports.default.fetch("https://example.com/session/prompt", {
      method: "PUT",
      body: JSON.stringify({ thinkingLevel: "off", activeTools: [] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thinkingLevel: "off", activeTools: [] });
  });

  it.each([
    { name: "malformed JSON", body: "{" },
    { name: "missing required fields", body: "{}" },
    {
      name: "an invalid deferred window",
      body: JSON.stringify({
        thinkingLevel: "off",
        activeTools: [],
        streamOptions: { deferred: { window: "forever" } },
      }),
    },
    {
      name: "an unknown deferred property",
      body: JSON.stringify({
        thinkingLevel: "off",
        activeTools: [],
        streamOptions: { deferred: { unexpected: true } },
      }),
    },
    {
      name: "a negative durable retry count",
      body: JSON.stringify({
        thinkingLevel: "off",
        activeTools: [],
        retry: { enabled: true, maxRetries: -1, baseDelayMs: 100 },
      }),
    },
    {
      name: "an unsafe stream retry count",
      body: JSON.stringify({
        thinkingLevel: "off",
        activeTools: [],
        streamOptions: { maxRetries: 1e100 },
      }),
    },
  ])("returns 400 for configuration with $name", async ({ body }) => {
    const response = await exports.default.fetch("https://example.com/session/invalid", {
      method: "PUT",
      body,
    });
    expect(response.status).toBe(400);
    await response.body?.cancel();
  });

  it("propagates unexpected configuration body reader failures", async () => {
    const url = "https://example.com/session/invalid";
    const request = new Request(url, { method: "PUT", body: "{}" });
    Object.defineProperty(request, "json", {
      value: async () => {
        throw new Error("body read failed");
      },
    });
    const stub = env.SESSIONS.getByName("invalid-reader");
    await expect(runInDurableObject(stub, (instance) => instance.fetch(request))).rejects.toThrow(
      "body read failed",
    );
  });

  it.each([
    { name: "malformed JSON", body: "{" },
    { name: "missing required fields", body: "{}" },
    { name: "non-text content", body: '{"type":"input","content":[]}' },
    {
      name: "an invalid busy policy",
      body: '{"type":"input","content":"ok","whenBusy":"wait"}',
    },
    {
      name: "an unsupported busy policy",
      body: '{"type":"input","content":"ok","whenBusy":"steer"}',
    },
    {
      name: "oversized content",
      body: JSON.stringify({ type: "input", content: "x".repeat(100_001) }),
    },
    {
      name: "an oversized request ID",
      body: JSON.stringify({ type: "input", content: "ok", requestId: "x".repeat(257) }),
    },
  ])("returns 400 for a prompt with $name", async ({ body }) => {
    const response = await exports.default.fetch("https://example.com/session/invalid/prompt", {
      method: "POST",
      body,
    });
    expect(response.status).toBe(400);
    await response.body?.cancel();
  });

  it("returns an unanswered submission when no model is configured", async () => {
    const url = "https://example.com/session/prompt-no-model/prompt";
    const prompt = () =>
      exports.default.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "input", content: "Hello", requestId: "prompt-1" }),
      });

    const submitted = await prompt();
    expect(submitted.status).toBe(200);
    const result = await submitted.json<{ submission: { status: string } }>();
    expect(result).toMatchObject({
      submission: {
        status: "unanswered",
      },
    });
  });

  it("returns a durable assistant answer after eviction", async () => {
    const sessionUrl = "https://example.com/session/model-turn";
    const configured = await exports.default.fetch(sessionUrl, {
      method: "PUT",
      body: JSON.stringify({
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
        activeTools: [],
      }),
    });
    expect(configured.status).toBe(200);

    const stub = env.SESSIONS.getByName("model-turn");
    await configured.body?.cancel();
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = await openStorage(state);
      const harness = await openFauxHarness(storage, [
        fauxAssistantMessage("Hello from the model"),
      ]);
      try {
        const root = await harness.root(context);
        const submission = await root.submit(
          { type: "input", content: "Say hello", requestId: "turn-1" },
          context,
        );
        await submission.wait(context);
      } finally {
        await harness.close(context);
      }
    });
    await evictDurableObject(stub);

    const prompt = () =>
      exports.default.fetch(`${sessionUrl}/prompt`, {
        method: "POST",
        body: JSON.stringify({ type: "input", content: "Say hello", requestId: "turn-1" }),
      });
    const response = await prompt();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      submission: { id: expect.any(Number), requestId: "turn-1", status: "done" },
      answer: {
        id: expect.any(Number),
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Hello from the model" }],
          },
        ],
      },
    });

    await evictDurableObject(stub);
    const reacquired = await prompt();
    expect(reacquired.status).toBe(200);
    expect(await reacquired.json()).toEqual(result);
  });

  it("resumes an interrupted in-flight generation after eviction", async () => {
    const firstRequestStarted = Promise.withResolvers<void>();
    const interrupted: FauxResponseStep = async (_request, options) => {
      firstRequestStarted.resolve();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("Request interrupted", "AbortError"));
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      });
    };

    const sessionId = "in-flight-recovery";
    const sessionUrl = `https://example.com/session/${sessionId}`;
    const configured = await exports.default.fetch(sessionUrl, {
      method: "PUT",
      body: JSON.stringify({
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
        activeTools: [],
      }),
    });
    expect(configured.status).toBe(200);

    const stub = env.SESSIONS.getByName(sessionId);
    await configured.body?.cancel();
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = await openStorage(state);
      const harness = await openFauxHarness(storage, [interrupted]);
      try {
        const root = await harness.root(context);
        await root.submit(
          {
            type: "input",
            content: "Finish after recovery",
            requestId: "recovery-turn",
          },
          context,
        );
        await firstRequestStarted.promise;
      } finally {
        await harness.close(context);
      }
    });
    await evictDurableObject(stub);

    let status: string | undefined;
    for (let attempt = 0; attempt < 100 && status === undefined; attempt++) {
      status = await runInDurableObject(stub, async (_instance, state) => {
        const submission = await (
          await openStorage(state)
        ).submissionByRequest(ROOT_CONVERSATION_ID, "recovery-turn", context);
        return submission?.status === "placed" ? undefined : submission?.status;
      });
    }

    expect(status).toBe("unanswered");
  });

  it("reopens SqliteStorage over persisted Durable Object data after eviction", async () => {
    const stub = env.SESSIONS.getByName("eviction");
    const entryId = await runInDurableObject(stub, async (_instance, state) => {
      const storage = await openStorage(state);
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

    const recovered = await runInDurableObject(stub, async (_instance, state) =>
      (await openStorage(state)).entry(ROOT_CONVERSATION_ID, entryId, context),
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
