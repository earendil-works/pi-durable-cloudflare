import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, type Message, Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  ConversationConfig,
  type ConversationId,
  type Cursor,
  type EntryRecord,
  type ToolExecutionApi,
  type ToolRegistration,
  UserEntry,
} from "@earendil-works/pi-durable";

export const SEARCH_CONVERSATIONS_TOOL_NAME = "search_conversations";
export const RECALL_TOOL_NAME = "recall";

const PAGE_SIZE = 50;
const MAX_MATCHES = 20;
const SNIPPET_RADIUS = 80;

export type ConversationMatch = {
  readonly conversationId: number;
  readonly entryId: number;
  readonly role: "user" | "assistant";
  readonly snippet: string;
};

function messageText(message: Message | undefined): string {
  if (message === undefined || message.role === "toolResult") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function match(entry: EntryRecord, term: string): ConversationMatch | undefined {
  const role = UserEntry.is(entry) ? "user" : AssistantEntry.is(entry) ? "assistant" : undefined;
  if (role === undefined) return undefined;
  const text = messageText(entry.model?.[0]);
  const index = text.toLowerCase().indexOf(term);
  if (index === -1) return undefined;
  return {
    conversationId: entry.conversationId,
    entryId: entry.id,
    role,
    snippet: snippet(text, index, term.length),
  };
}

/**
 * Case-insensitive substring search over the user and assistant messages of ownerless conversations, the ones the UI
 * lists. Owned conversations, such as recall's own child, are skipped. Each page is read in its own commit so a scan
 * never holds the Session's commit line for long.
 */
export async function searchConversations(
  api: Pick<ToolExecutionApi, "commit">,
  term: string,
  context: Context,
): Promise<{ readonly matches: readonly ConversationMatch[]; readonly truncated: boolean }> {
  const needle = term.trim().toLowerCase();
  if (needle.length === 0) throw new Error("Search term must contain text");
  const matches: ConversationMatch[] = [];
  let conversationCursor: Cursor | undefined;
  do {
    const conversations = await api.commit(
      (tx) => tx.scanConversations({}, PAGE_SIZE, conversationCursor),
      context,
    );
    for (const conversation of conversations.items) {
      if (conversation.owner !== undefined) continue;
      let entryCursor: Cursor | undefined;
      do {
        const entries = await api.commit(
          (tx) => tx.scanEntries({ conversationId: conversation.id }, PAGE_SIZE, entryCursor),
          context,
        );
        for (const entry of entries.items) {
          // A fork's scan includes its inherited history; count each entry once, in the conversation that wrote it.
          if (entry.conversationId !== conversation.id) continue;
          const found = match(entry, needle);
          if (found === undefined) continue;
          if (matches.length === MAX_MATCHES) return { matches, truncated: true };
          matches.push(found);
        }
        entryCursor = entries.next;
      } while (entryCursor !== undefined);
    }
    conversationCursor = conversations.next;
  } while (conversationCursor !== undefined);
  return { matches, truncated: false };
}

export const searchConversationsTool: ToolRegistration = {
  name: SEARCH_CONVERSATIONS_TOOL_NAME,
  description:
    "Find user and assistant messages containing a term, across all conversations in this session. " +
    `Case-insensitive substring match; returns at most ${MAX_MATCHES} matches with snippets.`,
  parameters: Type.Object({
    term: Type.String({ description: "Word or phrase to find, for example postgres" }),
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    const { term } = args as { term: string };
    const result = await searchConversations(api, term, context);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
};

/**
 * Delegates a question about past conversations to a subagent: a child conversation owned by this tool call, which
 * searches with `search_conversations` and answers. The parent receives only the answer, not the raw matches.
 */
export const recallTool: ToolRegistration = {
  name: RECALL_TOOL_NAME,
  description:
    "Answer a question about what was said in other conversations of this session, such as earlier decisions. " +
    "A subagent searches the conversations and replies with a short answer that cites conversation IDs.",
  parameters: Type.Object({
    question: Type.String({ description: "What to find out from past conversations" }),
  }),
  // Safe to rerun after a crash: a rerun finds the child it created and the submission it made.
  replay: "safe",
  execute: async (args, api, context) => {
    const { question } = args as { question: string };
    const parent = await api.snapshot(ConversationConfig, api.conversationId, context);
    const childId: ConversationId = await api.commit(async (tx) => {
      // Ownership is the durable record of the child, so a rerun reuses it instead of creating another.
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (existing !== undefined) return existing.id;
      const child = await tx.createConversation({
        ownership: { kind: "task", taskId: api.taskId },
      });
      const config = await tx.doc(ConversationConfig, child.id);
      if (parent?.model !== undefined) config.model = { ...parent.model };
      config.activeTools = [SEARCH_CONVERSATIONS_TOOL_NAME];
      return child.id;
    }, context);
    // A UI watching the parent sees the child in the call's details.
    await api.details({ conversationId: childId }, context);

    const child = await api.conversation(childId, context);
    if (child === undefined) throw new Error(`Recall conversation ${childId} is missing`);
    const submission = await child.submit(
      {
        type: "input",
        content:
          `Answer this question using search_conversations: ${question}\n\n` +
          "Try a few relevant terms. Reply briefly, cite conversation IDs, and say so if nothing relevant was found.",
        // The task ID is stable across reruns, so a rerun gets back this submission.
        requestId: `recall:${api.taskId}`,
      },
      context,
    );
    const settled = await submission.wait(context);
    if (settled.status !== "done" || settled.type !== "input") {
      throw new Error(`Recall did not answer: ${settled.status}`);
    }
    const answer = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
    const text = messageText(answer?.model?.[0] as AssistantMessage | undefined);
    return {
      content: [{ type: "text", text }],
      details: { conversationId: childId },
    };
  },
};
