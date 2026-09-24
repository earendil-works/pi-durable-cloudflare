import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationRecord, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createCloudflareSqliteDatabase } from "./sqlite.ts";

export class Session extends DurableObject<Env> {
  readonly storage: Promise<SqliteStorage>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = ctx.blockConcurrencyWhile(() =>
      SqliteStorage.open(createCloudflareSqliteDatabase(ctx.storage)),
    );
  }

  async createRoot() {
    const storage = await this.storage;
    const existing = await storage.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    if (existing !== undefined) return { created: false, conversation: existing };

    const conversation: ConversationRecord = { id: ROOT_CONVERSATION_ID };
    try {
      await storage.commit([{ type: "conversation", value: conversation }], BACKGROUND_CONTEXT);
      return { created: true, conversation };
    } catch (error) {
      const concurrentlyCreated = await storage.conversation(
        ROOT_CONVERSATION_ID,
        BACKGROUND_CONTEXT,
      );
      if (concurrentlyCreated !== undefined)
        return { created: false, conversation: concurrentlyCreated };
      throw error;
    }
  }

  async root(): Promise<ConversationRecord | undefined> {
    return (await this.storage).conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
  }
}
