import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
  configure,
  createRegistry,
  defineExtension,
  Harness,
  ROOT_CONVERSATION_ID,
  type SubmissionRecord,
  type Storage,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it } from "vitest";
import { DeliverScheduledInstruction } from "../src/schedule.ts";
import { expectAlarm } from "./alarm.ts";

const context = BACKGROUND_CONTEXT;

const openStorage = (state: DurableObjectState) => openDurableObjectSqliteStorage(state.storage);

/** Write state as an earlier process would have, beside the live Session's harness, then evict the Session. */
async function seed<T>(
  stub: DurableObjectStub,
  write: (harness: Harness) => Promise<T>,
): Promise<T> {
  const result = await runInDurableObject(stub, async (_instance, state) => {
    // Let the Session finish opening its harness before writing beside it.
    await state.blockConcurrencyWhile(async () => {});
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
          configure(tx, conversationId, { thinkingLevel: "off", tools: [] }),
      });
      return await write(harness);
    } finally {
      await harness.close(context);
    }
  });
  await evictDurableObject(stub);
  return result;
}

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

  it("re-arms a persisted scheduled instruction after eviction and submits it from the alarm", async () => {
    const stub = env.SESSIONS.getByName("scheduled-instruction-recovery");
    const runAt = Date.now() + 1_500;
    await seed(stub, (harness) =>
      harness.commit(
        (tx) =>
          tx.createTask(
            DeliverScheduledInstruction,
            {
              id: "schedule:integration",
              conversationId: ROOT_CONVERSATION_ID,
              instruction: "Check the oven",
              runAt,
            },
            {
              ownership: { kind: "conversation" },
              conversationId: ROOT_CONVERSATION_ID,
              background: true,
            },
          ),
        context,
      ),
    );

    // The reopened Session resumes the delivery, which sleeps; `onWake` moves the alarm to its deadline.
    await expectAlarm(stub, runAt);
    // The live instance keeps no timer for the sleep: only its alarm handler can make the delivery runnable.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, runAt - Date.now()) + 20));
    // The alarm may already have fired by itself; running it again is harmless (alarms are at-least-once).
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

  it("clears an early alarm that finds an idle Session", async () => {
    const stub = env.SESSIONS.getByName("early-platform-alarm");
    // A live, idle Session: `onWake` reports nothing to do, and does not report it again unchanged.
    await expectAlarm(stub, null);
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.setAlarm(Date.now() + 30_000),
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    // The handler arms a heartbeat before resuming, then re-arms from the Harness, which has no work.
    await expectAlarm(stub, null);
  });
});
