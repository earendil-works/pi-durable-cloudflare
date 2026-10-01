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
  type ConversationId,
  createRegistry,
  Harness,
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

async function openHarness(responses: readonly FauxResponseStep[]): Promise<Harness> {
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

/** Search as a tool call in `conversationId` would. */
const searchFrom = (harness: Harness, conversationId: ConversationId, term: string) =>
  searchConversations(
    { commit: (change, commitContext) => harness.commit(change, commitContext), conversationId },
    term,
    context,
  );

describe("conversation search", () => {
  it("finds messages once across forks and skips the asking conversation", async () => {
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

      // The fork inherits both root entries but wrote neither, so each appears once, in the root.
      await expect(searchFrom(harness, fork.id, "database")).resolves.toEqual({
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
      await expect(searchFrom(harness, root.id, "database")).resolves.toEqual({
        truncated: false,
        matches: [],
      });
      await expect(searchFrom(harness, fork.id, "  ")).rejects.toThrow(
        "Search term must contain text",
      );
    } finally {
      await harness.close(context);
    }
  });
});

describe("recall subagent", () => {
  it("answers from a child whose search skips the asking conversation", async () => {
    const harness = await openHarness([
      // Seed, in the root: the decision.
      fauxAssistantMessage([fauxText("Decision: Postgres, one database per tenant.")]),
      // Asking conversation delegates.
      fauxAssistantMessage(
        [fauxToolCall(RECALL_TOOL_NAME, { question: "Did we pick postgres?" })],
        { stopReason: "toolUse" },
      ),
      // Child searches, then answers.
      fauxAssistantMessage([fauxToolCall("search_conversations", { term: "postgres" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Yes, Postgres, per the earlier conversation.")]),
      // Asking conversation reports.
      fauxAssistantMessage([fauxText("Yes, you picked Postgres.")]),
    ]);
    try {
      const root = await harness.root(context);
      await root.setModel(model, context);
      await ask(root, "Let's decide on the database.");
      const asking = await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      await asking.setModel(model, context);
      await asking.setActiveTools([RECALL_TOOL_NAME], context);

      // The question mentions postgres, so a search that included the asking conversation would find it.
      await ask(asking, "Did we pick postgres?");
      const [final, toolResult] = (
        await harness.commit((tx) => tx.scanEntries({ conversationId: asking.id }, 3), context)
      ).items;
      expect(final?.model?.[0]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Yes, you picked Postgres." }],
      });
      const children = (
        await harness.commit(
          (tx) => tx.scanConversations({ ownerConversationId: asking.id }, 10),
          context,
        )
      ).items;
      expect(children).toHaveLength(1);
      const child = children[0]!;
      expect(toolResult?.model?.[0]).toMatchObject({
        role: "toolResult",
        toolName: RECALL_TOOL_NAME,
        content: [{ type: "text", text: "Yes, Postgres, per the earlier conversation." }],
        details: { conversationId: child.id },
      });

      // The child's search found only the root's decision: not the question, not the child itself.
      const childEntries = (
        await harness.commit((tx) => tx.scanEntries({ conversationId: child.id }, 20), context)
      ).items;
      const search = childEntries.find((entry) => entry.model?.[0]?.role === "toolResult")
        ?.model?.[0];
      expect(search).toMatchObject({ role: "toolResult", toolName: "search_conversations" });
      const text =
        search?.role === "toolResult" && search.content[0]?.type === "text"
          ? search.content[0].text
          : "";
      const { matches } = JSON.parse(text) as { matches: Array<{ conversationId: number }> };
      expect(matches.map(({ conversationId }) => conversationId)).toEqual([root.id]);
    } finally {
      await harness.close(context);
    }
  });
});
