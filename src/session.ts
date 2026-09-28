import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ConversationConfig,
  type ConversationConfigState,
  type Harness as PiHarness,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openAgentHarness } from "./agent.ts";
import { createCloudflareSqliteDatabase } from "./sqlite.ts";

export class Session extends DurableObject<Env> {
  readonly storage: Promise<SqliteStorage>;
  #harness!: PiHarness;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = ctx.blockConcurrencyWhile(async () => {
      const storage = await SqliteStorage.open(createCloudflareSqliteDatabase(ctx.storage));
      this.#harness = await openAgentHarness(storage, BACKGROUND_CONTEXT);
      return storage;
    });
  }

  getConfig(): Promise<Readonly<ConversationConfigState> | undefined> {
    return this.#harness.snapshot(ConversationConfig, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
  }

  async setConfig(value: ConversationConfigState): Promise<Readonly<ConversationConfigState>> {
    const next = { model: value.model, ...value };
    const conversation = await this.#harness.root(BACKGROUND_CONTEXT, {
      init: async (tx, conversationId) => {
        Object.assign(await tx.doc(ConversationConfig, conversationId), next);
      },
    });
    await conversation.commit(async (tx) => {
      Object.assign(await tx.doc(ConversationConfig, conversation.id), next);
    }, BACKGROUND_CONTEXT);
    const stored = await this.getConfig();
    if (stored === undefined) throw new Error("Root conversation configuration is missing");
    return stored;
  }
}
