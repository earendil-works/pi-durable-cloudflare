import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  createRegistry,
  Harness,
  type Harness as PiHarness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  RECALL_TOOL_NAME,
  recallTool,
  searchConversations,
  searchConversationsTool,
} from "../src/recall.ts";

const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };

async function openHarness(responses: readonly FauxResponseStep[]): Promise<PiHarness> {
  const faux = fauxProvider();
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.tools.add(recallTool);
  registry.tools.add(searchConversationsTool);
  return Harness.open(new MemoryStorage(), { models, registry }, context);
}

async function ask(conversation: Conversation, content: string) {
  const submission = await conversation.submit({ type: "input", content }, context);
  const settled = await submission.wait(context);
  if (settled.status !== "done" || settled.type !== "input") {
    throw new Error(`Submission did not finish: ${settled.status}`);
  }
  return settled;
}

describe("conversation search", () => {
  it("finds user and assistant messages once, including in forks, with snippets", async () => {
    const harness = await openHarness([
      fauxAssistantMessage([fauxText("Postgres with one database per tenant.")]),
      fauxAssistantMessage([fauxText("Weather looks fine.")]),
    ]);
    try {
      const root = await harness.root(context);
      await root.setModel(model, context);
      const question = await ask(root, "Which DATABASE should we use?");
      const fork = await root.fork(question.answer, { ownership: { kind: "ownerless" } }, context);
      await ask(fork, "What about the weather?");

      const result = await searchConversations(harness, "database", context);

      // The fork inherits both root entries but wrote neither, so each appears once, in the root.
      expect(result).toEqual({
        truncated: false,
        matches: [
          {
            conversationId: root.id,
            entryId: question.answer,
            role: "assistant",
            snippet: "Postgres with one database per tenant.",
          },
          {
            conversationId: root.id,
            entryId: question.entry,
            role: "user",
            snippet: "Which DATABASE should we use?",
          },
        ],
      });
      await expect(searchConversations(harness, "  ", context)).rejects.toThrow(
        "Search term must contain text",
      );
    } finally {
      await harness.close(context);
    }
  });
});

describe("recall subagent", () => {
  it("answers from a child conversation that searches, and keeps the child out of search", async () => {
    const harness = await openHarness([
      // Seed: an earlier answer mentioning the decision.
      fauxAssistantMessage([fauxText("Decision: Postgres, one database per tenant.")]),
      // Parent delegates.
      fauxAssistantMessage(
        [fauxToolCall(RECALL_TOOL_NAME, { question: "Which database did we pick?" })],
        { stopReason: "toolUse" },
      ),
      // Child searches, then answers from the result.
      fauxAssistantMessage([fauxToolCall("search_conversations", { term: "postgres" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Postgres, per conversation 1.")]),
      // Parent reports.
      fauxAssistantMessage([fauxText("You picked Postgres (conversation 1).")]),
    ]);
    try {
      const root = await harness.root(context);
      await root.setModel(model, context);
      await ask(root, "Let's decide on the database.");
      await root.setActiveTools([RECALL_TOOL_NAME], context);

      await ask(root, "What did we decide about the database?");

      const tail = await root.commit(
        (tx) => tx.scanEntries({ conversationId: root.id }, 3),
        context,
      );
      const [final, toolResult] = tail.items;
      expect(final?.model?.[0]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "You picked Postgres (conversation 1)." }],
      });
      const children = await root.commit(
        (tx) =>
          tx.scanConversations({ ownerConversationId: root.id }, 10).then(({ items }) => items),
        context,
      );
      expect(children).toHaveLength(1);
      expect(toolResult?.model?.[0]).toMatchObject({
        role: "toolResult",
        toolName: RECALL_TOOL_NAME,
        content: [{ type: "text", text: "Postgres, per conversation 1." }],
        details: { conversationId: children[0]!.id },
      });

      // The child's own messages mention postgres too, but it is owned, so search does not return them.
      const { matches } = await searchConversations(harness, "postgres", context);
      expect(matches.map(({ conversationId }) => conversationId)).toEqual([root.id, root.id]);
    } finally {
      await harness.close(context);
    }
  });
});
