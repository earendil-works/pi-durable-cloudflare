import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
  configure,
  createRegistry,
  defineExtension,
  type ConversationId,
  Harness,
  ROOT_CONVERSATION_ID,
  type SubmissionRecord,
  type Storage,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it } from "vitest";
import { DeliverScheduledInstruction } from "../src/schedule.ts";

const context = BACKGROUND_CONTEXT;

const openStorage = (state: DurableObjectState) => openDurableObjectSqliteStorage(state.storage);

async function openFauxHarness(
  storage: Storage,
  responses: readonly FauxResponseStep[],
): Promise<Harness> {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([...responses]);
  return Harness.open(storage, { models, registry: createRegistry() }, context);
}

describe("session recovery", () => {
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
    const stub = env.SESSIONS.getByName(sessionId);
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = await openStorage(state);
      const harness = await openFauxHarness(storage, [interrupted]);
      try {
        const root = await harness.root(context, {
          init: (tx, conversationId) =>
            configure(tx, conversationId, {
              model: { provider: "faux", modelId: "faux-1" },
              thinkingLevel: "off",
              tools: [],
            }),
        });
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
    const wake = await exports.default.fetch(`https://example.com/api/sessions/${sessionId}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(wake.status).toBe(101);
    wake.webSocket!.accept();
    wake.webSocket!.close(1000, "test setup complete");

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

  it("re-arms and submits a persisted scheduled instruction after eviction", async () => {
    const sessionId = "scheduled-instruction-recovery";
    const stub = env.SESSIONS.getByName(sessionId);
    await runInDurableObject(stub, async (_instance, state) => {
      const registry = createRegistry();
      registry.install(defineExtension({ name: "schedule", tasks: [DeliverScheduledInstruction] }));
      const harness = await Harness.open(
        await openStorage(state),
        { models: createModels(), registry },
        context,
      );
      try {
        await harness.root(context, {
          init: (tx, conversationId) =>
            configure(tx, conversationId, {
              thinkingLevel: "off",
              tools: [],
            }),
        });
        await harness.commit(
          (tx) =>
            tx.createTask(
              DeliverScheduledInstruction,
              {
                id: "schedule:integration",
                conversationId: ROOT_CONVERSATION_ID,
                instruction: "Check the oven",
                runAt: Date.now() + 200,
              },
              {
                ownership: { kind: "conversation" },
                conversationId: ROOT_CONVERSATION_ID,
                background: true,
              },
            ),
          context,
        );
      } finally {
        await harness.close(context);
      }
    });
    await evictDurableObject(stub);

    const reopened = await exports.default.fetch(`https://example.com/api/sessions/${sessionId}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(reopened.status).toBe(101);
    reopened.webSocket!.accept();
    reopened.webSocket!.close(1000, "test setup complete");
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).not.toBe(
      null,
    );
    await evictDurableObject(stub);
    await new Promise((resolve) => setTimeout(resolve, 220));
    await runDurableObjectAlarm(stub);

    let submission: SubmissionRecord | undefined;
    for (let attempt = 0; attempt < 100 && submission === undefined; attempt++) {
      submission = await runInDurableObject(stub, async (_instance, state) =>
        (await openStorage(state)).submissionByRequest(
          ROOT_CONVERSATION_ID,
          "schedule:integration",
          context,
        ),
      );
    }
    expect(submission).toMatchObject({
      conversationId: ROOT_CONVERSATION_ID,
      requestId: "schedule:integration",
      type: "input",
    });
  });

  it("deletes the platform alarm when scheduled work is no longer actionable", async () => {
    const sessionId = "obsolete-platform-alarm";
    const stub = env.SESSIONS.getByName(sessionId);
    await runInDurableObject(stub, async (_instance, state) => {
      const registry = createRegistry();
      registry.install(defineExtension({ name: "schedule", tasks: [DeliverScheduledInstruction] }));
      const harness = await Harness.open(
        await openStorage(state),
        { models: createModels(), registry },
        context,
      );
      try {
        await harness.root(context, {
          init: (tx, conversationId) =>
            configure(tx, conversationId, {
              thinkingLevel: "off",
              tools: [],
            }),
        });
        await harness.commit(
          (tx) =>
            tx.createTask(
              DeliverScheduledInstruction,
              {
                id: "schedule:missing-conversation",
                conversationId: 999 as ConversationId,
                instruction: "This cannot be delivered",
                runAt: Date.now() - 1,
              },
              {
                ownership: { kind: "conversation" },
                conversationId: ROOT_CONVERSATION_ID,
                background: true,
              },
            ),
          context,
        );
        await state.storage.setAlarm(Date.now());
      } finally {
        await harness.close(context);
      }
    });

    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);

    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
      null,
    );
  });
});
