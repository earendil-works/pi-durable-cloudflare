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
  defineExtension,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  SEARCH_HISTORY_TOOL_NAME,
  conversationSearchExtension,
  searchHistoryTool,
  searchConversations,
  searchConversationsTool,
} from "../src/search.ts";

const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };

async function openHarness(responses: readonly FauxResponseStep[]): Promise<Harness> {
  const faux = fauxProvider();
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "history-search",
      tools: [searchHistoryTool, searchConversationsTool],
    }),
  );
  registry.install(conversationSearchExtension);
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

const searchFrom = (harness: Harness, term: string) =>
  searchConversations(
    { commit: (change, commitContext) => harness.commit(change, commitContext) },
    term,
    context,
  );

describe("conversation search", () => {
  it("finds user and assistant messages once across top-level conversations and forks", async () => {
    const harness = await openHarness([
      fauxAssistantMessage([fauxText("Postgres with one database per tenant.")]),
      fauxAssistantMessage([fauxText("Weather looks fine.")]),
    ]);
    try {
      const root = await harness.root(context);
      await root.configure({ model }, context);
      const question = await ask(root, "Which DATABASE should we use?");
      const fork = await root.fork(question.answer, { ownership: { kind: "ownerless" } }, context);
      await ask(fork, "What about the weather?");

      // The fork inherits both root entries but wrote neither, so each appears once, in the root.
      await expect(searchFrom(harness, "database")).resolves.toEqual({
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
      await expect(searchFrom(harness, "  ")).rejects.toThrow("Search term must contain text");
    } finally {
      await harness.close(context);
    }
  });
});

describe("history search subagent", () => {
  it("searches ordinary top-level turns but excludes search turns and subagents", async () => {
    const harness = await openHarness([
      // Seed, in the root: the decision.
      fauxAssistantMessage([fauxText("Decision: Postgres, one database per tenant.")]),
      // An ordinary turn in the conversation that will later search.
      fauxAssistantMessage([fauxText("Postgres replicas should stay regional.")]),
      // Asking conversation delegates.
      fauxAssistantMessage(
        [fauxToolCall(SEARCH_HISTORY_TOOL_NAME, { question: "Did we pick postgres?" })],
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
      await root.configure({ model }, context);
      const rootDecision = await ask(root, "Let's decide on the database.");
      const asking = await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      await asking.configure({ model, tools: [searchHistoryTool] }, context);

      const localDecision = await ask(asking, "Keep the Postgres replicas regional.");
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
        toolName: SEARCH_HISTORY_TOOL_NAME,
        content: [{ type: "text", text: "Yes, Postgres, per the earlier conversation." }],
        details: { conversationId: child.id },
      });

      // The child found ordinary turns in both top-level conversations. It did not find its own
      // conversation or the user and assistant messages of the turn that invoked search.
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
      const { matches } = JSON.parse(text) as {
        matches: Array<{ conversationId: number; entryId: number; role: string; snippet: string }>;
      };
      expect(matches).toEqual([
        {
          conversationId: root.id,
          entryId: rootDecision.answer,
          role: "assistant",
          snippet: "Decision: Postgres, one database per tenant.",
        },
        {
          conversationId: asking.id,
          entryId: localDecision.answer,
          role: "assistant",
          snippet: "Postgres replicas should stay regional.",
        },
        {
          conversationId: asking.id,
          entryId: localDecision.entry,
          role: "user",
          snippet: "Keep the Postgres replicas regional.",
        },
      ]);

      // Completed search turns remain outside the corpus for later searches too.
      await expect(searchFrom(harness, "postgres")).resolves.toEqual({
        truncated: false,
        matches,
      });
    } finally {
      await harness.close(context);
    }
  });
});
