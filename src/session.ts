import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  ConversationBusy,
  ConversationConfig,
  type ConversationConfigState,
  type Harness as PiHarness,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  InvalidConfigurationError,
  InvalidPromptError,
  openChatHarness,
  parseConversationConfig,
  parseTextPrompt,
  type TextPrompt,
} from "./chat.ts";
import { createCloudflareSqliteDatabase } from "./sqlite.ts";

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const RECOVERY_ALARM_DELAY_MS = 60_000;

export class Session extends DurableObject<Env> {
  #harness!: PiHarness;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const ready = ctx.blockConcurrencyWhile(async () => {
      const storage = await SqliteStorage.open(createCloudflareSqliteDatabase(ctx.storage));
      this.#harness = await openChatHarness(storage, BACKGROUND_CONTEXT);
    });
    void ready
      .then(() => this.#resume())
      .catch((error: unknown) => console.error("Harness recovery failed", error));
  }

  override alarm(): Promise<void> {
    return this.#resume();
  }

  override async fetch(request: Request): Promise<Response> {
    const isPrompt = /^\/session\/[^/]+\/prompt\/?$/.test(new URL(request.url).pathname);
    if (isPrompt) {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }
      let prompt: TextPrompt;
      try {
        prompt = parseTextPrompt(await request.json());
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof InvalidPromptError)) throw error;
        return json({ error: error.message }, 400);
      }
      try {
        return json(await this.#prompt(prompt), 200);
      } catch (error) {
        if (!(error instanceof ConversationBusy)) throw error;
        return json({ error: error.message }, 409);
      }
    }

    if (request.method === "GET") {
      const config = await this.#getConfig();
      return config === undefined ? json({ error: "Session not found" }, 404) : json(config, 200);
    }
    if (request.method === "PUT") {
      let config: ConversationConfigState;
      try {
        config = parseConversationConfig(await request.json());
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof InvalidConfigurationError)) {
          throw error;
        }
        return json({ error: error.message }, 400);
      }
      return json(await this.#setConfig(config), 200);
    }
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, PUT" });
  }

  async #prompt(input: TextPrompt) {
    const root = await this.#harness.root(BACKGROUND_CONTEXT);
    await this.ctx.storage.setAlarm(Date.now() + RECOVERY_ALARM_DELAY_MS);
    const submission = await root.submit(input, BACKGROUND_CONTEXT);
    await this.#resume();
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    await this.#refreshRecoveryAlarm();
    if (settled.status !== "done" || settled.type !== "input") {
      return { submission: settled };
    }

    const answer = await root.commit(
      (tx) => tx.entry(AssistantEntry, settled.answer),
      BACKGROUND_CONTEXT,
    );
    if (answer === undefined) throw new Error("Settled prompt answer is missing");
    return { submission: settled, answer };
  }

  async #resume(): Promise<void> {
    this.#harness.resume();
    await this.#refreshRecoveryAlarm();
  }

  async #refreshRecoveryAlarm(): Promise<void> {
    const inspection = await this.#harness.inspect(BACKGROUND_CONTEXT);
    if (inspection.tasks.some(({ state }) => state.kind !== "blocked")) {
      await this.ctx.storage.setAlarm(Date.now() + RECOVERY_ALARM_DELAY_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  #getConfig(): Promise<Readonly<ConversationConfigState> | undefined> {
    return this.#harness.snapshot(ConversationConfig, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
  }

  async #setConfig(value: ConversationConfigState): Promise<Readonly<ConversationConfigState>> {
    const next = {
      model: value.model,
      streamOptions: value.streamOptions,
      retry: value.retry,
      ...value,
    };
    const conversation = await this.#harness.root(BACKGROUND_CONTEXT, {
      init: async (tx, conversationId) => {
        Object.assign(await tx.doc(ConversationConfig, conversationId), next);
      },
    });
    await conversation.commit(async (tx) => {
      Object.assign(await tx.doc(ConversationConfig, conversation.id), next);
    }, BACKGROUND_CONTEXT);
    const stored = await this.#getConfig();
    if (stored === undefined) throw new Error("Root conversation configuration is missing");
    return stored;
  }
}
