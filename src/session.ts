import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type ConversationRecord,
  createSession,
  defineDoc,
  ROOT_CONVERSATION_ID,
  type Session as PiSession,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createCloudflareSqliteDatabase } from "./sqlite.ts";

const SessionMetadata = defineDoc<{ primaryConversationId?: ConversationId }>({
  kind: "example.session",
  version: 1,
  scope: "session",
  initial: () => ({}),
});

const PRIMARY_CONVERSATION_MISSING = "PRIMARY_CONVERSATION_MISSING";

class PrimaryConversationMissingError extends Error {
  readonly code = PRIMARY_CONVERSATION_MISSING;

  constructor(conversationId: ConversationId) {
    super(`Primary conversation ${conversationId} is missing`);
    this.name = "PrimaryConversationMissingError";
  }
}

export class Session extends DurableObject<Env> {
  readonly storage: Promise<SqliteStorage>;
  #session!: PiSession;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = ctx.blockConcurrencyWhile(async () => {
      const storage = await SqliteStorage.open(createCloudflareSqliteDatabase(ctx.storage));
      this.#session = createSession(storage);
      return storage;
    });
  }

  createPrimaryConversation(): Promise<{ created: boolean; conversation: ConversationRecord }> {
    return this.#session.commit(async (tx) => {
      // Adopt Durable Objects created before primary-conversation metadata existed.
      const legacy = await tx.conversation(ROOT_CONVERSATION_ID);
      const metadata = await tx.doc(SessionMetadata);
      if (metadata.primaryConversationId !== undefined) {
        const existing = await tx.conversation(metadata.primaryConversationId);
        if (existing === undefined) {
          throw new PrimaryConversationMissingError(metadata.primaryConversationId);
        }
        return { created: false, conversation: existing };
      }

      if (legacy !== undefined) {
        metadata.primaryConversationId = legacy.id;
        return { created: false, conversation: legacy };
      }

      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      metadata.primaryConversationId = conversation.id;
      return { created: true, conversation };
    }, BACKGROUND_CONTEXT);
  }

  async primaryConversation(): Promise<ConversationRecord | undefined> {
    const metadata = await this.#session.snapshot(SessionMetadata, BACKGROUND_CONTEXT);
    const conversationId = metadata?.primaryConversationId;
    if (conversationId !== undefined) {
      const conversation = await this.#session.commit(
        (tx) => tx.conversation(conversationId),
        BACKGROUND_CONTEXT,
      );
      if (conversation === undefined) throw new PrimaryConversationMissingError(conversationId);
      return conversation;
    }

    // A read also performs the one-time legacy migration so existing GETs keep working.
    const legacy = await this.#session.commit(
      (tx) => tx.conversation(ROOT_CONVERSATION_ID),
      BACKGROUND_CONTEXT,
    );
    if (legacy === undefined) return undefined;

    return this.#session.commit(async (tx) => {
      const current = await tx.doc(SessionMetadata);
      if (current.primaryConversationId !== undefined) {
        const conversation = await tx.conversation(current.primaryConversationId);
        if (conversation === undefined) {
          throw new PrimaryConversationMissingError(current.primaryConversationId);
        }
        return conversation;
      }
      current.primaryConversationId = legacy.id;
      return legacy;
    }, BACKGROUND_CONTEXT);
  }
}
