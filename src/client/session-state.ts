import type { JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type {
  AgentState,
  AgentEvent,
  CompactionReason,
  EntryRecord,
  JsonObject,
  MessageChange,
  SnapshotEvent,
  ToolDiagnostic,
  UsageState,
} from "@earendil-works/pi-durable";
import { CompactionEntry, ResetEntry, ToolResultEntry } from "@earendil-works/pi-durable";
import {
  ROOT_CONVERSATION_ID,
  parseScheduledInstruction,
  type ConnectionStatus,
  type ConversationSummary,
  type QueuedInput,
  type ServerEvent,
} from "../protocol.ts";

export interface TranscriptEntry {
  readonly id: number;
  readonly conversationId: number;
  readonly kind: string;
  readonly role:
    | "user"
    | "assistant"
    | "system"
    | "tool"
    | "scheduled"
    | "compaction"
    | "reset"
    | "event";
  readonly text: string;
  readonly timestamp?: number;
  readonly canFork: boolean;
  readonly diagnostics?: readonly ToolDiagnostic[];
}

export interface LiveConversation {
  readonly active: boolean;
  readonly text: string;
  readonly retry?: {
    readonly at: number;
    readonly error: string;
  };
}

export interface ToolProgress {
  readonly callId: string;
  readonly name: string;
  readonly status: "pending" | "running" | "done";
  readonly args?: JsonObject;
  readonly output?: string;
  readonly details?: JsonValue;
  readonly diagnostics?: readonly ToolDiagnostic[];
}

export interface LiveCompaction {
  readonly taskId: number;
  readonly reason: CompactionReason;
  readonly blocking: boolean;
}

export interface ConversationSnapshot {
  readonly id: number;
  readonly entries: readonly TranscriptEntry[];
  readonly partial?: AssistantMessage;
  readonly live: LiveConversation | null;
  readonly tools: readonly ToolProgress[];
  readonly compactions: readonly LiveCompaction[];
  /** Inputs submitted during a running turn, waiting to be placed after it. */
  readonly queued: readonly QueuedInput[];
  readonly typing: readonly string[];
  readonly agent?: Readonly<AgentState>;
  readonly usage?: Readonly<UsageState>;
  readonly failure?: {
    readonly taskId: number;
    readonly kind: string;
    readonly message: string;
  };
}

export interface SessionState {
  readonly status: ConnectionStatus;
  readonly conversations: readonly ConversationSummary[];
  readonly activeConversationId?: number;
  readonly snapshots: Readonly<Record<number, ConversationSnapshot>>;
  readonly error?: string;
}

export type SessionAction =
  | { readonly type: "connection"; readonly status: ConnectionStatus }
  | { readonly type: "select"; readonly conversationId: number }
  | { readonly type: "event"; readonly event: ServerEvent }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "clear-error" };

export const initialSessionState: SessionState = {
  status: "connecting",
  conversations: [],
  snapshots: {},
};

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "connection":
      return { ...state, status: action.status };
    case "select":
      return { ...state, activeConversationId: action.conversationId, error: undefined };
    case "error":
      return { ...state, error: action.message };
    case "clear-error":
      return { ...state, error: undefined };
    case "event":
      return reduceServerEvent(state, action.event);
  }
}

function reduceServerEvent(state: SessionState, event: ServerEvent): SessionState {
  switch (event.type) {
    case "session.snapshot": {
      const conversations = event.session.conversations;
      const selectedStillExists = conversations.some(({ id }) => id === state.activeConversationId);
      const activeConversationId = selectedStillExists
        ? state.activeConversationId
        : (conversations.find(({ id }) => id === ROOT_CONVERSATION_ID)?.id ?? conversations[0]?.id);
      return { ...state, conversations, activeConversationId };
    }
    case "conversation.events": {
      const before =
        state.snapshots[event.conversationId] ?? emptyConversation(event.conversationId);
      const conversation = event.events.reduce(reduceAgentEvent, before);
      return {
        ...state,
        snapshots: { ...state.snapshots, [event.conversationId]: conversation },
      };
    }
    case "conversation.inbox": {
      const before =
        state.snapshots[event.conversationId] ?? emptyConversation(event.conversationId);
      return {
        ...state,
        snapshots: {
          ...state.snapshots,
          [event.conversationId]: { ...before, queued: event.items },
        },
      };
    }
    case "presence.typing": {
      const before =
        state.snapshots[event.conversationId] ?? emptyConversation(event.conversationId);
      return {
        ...state,
        snapshots: {
          ...state.snapshots,
          [event.conversationId]: { ...before, typing: event.usernames },
        },
      };
    }
    case "command.result":
      if (!event.ok) return { ...state, error: event.error.message };
      return event.conversationId === undefined ||
        (event.command !== "conversation.create" && event.command !== "conversation.fork")
        ? state
        : { ...state, activeConversationId: event.conversationId, error: undefined };
    case "error":
      return { ...state, error: event.error.message };
  }
}

const emptyConversation = (id: number): ConversationSnapshot => ({
  id,
  entries: [],
  live: null,
  tools: [],
  compactions: [],
  queued: [],
  typing: [],
});

function reduceAgentEvent(
  conversation: ConversationSnapshot,
  event: AgentEvent,
): ConversationSnapshot {
  switch (event.type) {
    case "snapshot":
      return snapshotConversation(conversation, event);
    case "run_start":
    case "turn_start":
      return {
        ...conversation,
        failure: undefined,
        live: {
          active: true,
          text: conversation.live?.text ?? "",
          retry: conversation.live?.retry,
        },
      };
    case "run_end":
      return { ...conversation, live: null, partial: undefined, tools: [] };
    case "message_start":
      return event.message.role === "assistant"
        ? withPartial(conversation, event.message, conversation.live?.retry)
        : conversation;
    case "message_update":
      return conversation.partial === undefined
        ? conversation
        : withPartial(
            conversation,
            applyMessageChanges(conversation.partial, event.changes, event.usage),
            conversation.live?.retry,
          );
    case "message_end":
      return clearCommittedPartial(appendEntry(conversation, event.entry), event.entry);
    case "entry_appended":
      return appendEntry(conversation, event.entry);
    case "tool_execution_start":
      return updateTool(conversation, event.toolCallId, {
        callId: event.toolCallId,
        name: event.toolName,
        status: "running",
        args: event.args,
      });
    case "tool_execution_update":
      return updateToolProgress(conversation, event);
    case "tool_execution_end":
      return updateTool(conversation, event.toolCallId, {
        ...(conversation.tools.find(({ callId }) => callId === event.toolCallId) ?? {
          callId: event.toolCallId,
          name: event.toolName,
        }),
        status: "done",
      });
    case "auto_retry_start":
      return {
        ...conversation,
        live: {
          active: true,
          text: conversation.live?.text ?? "",
          retry: { at: event.at, error: event.errorMessage },
        },
      };
    case "auto_retry_end":
      return conversation.live === null
        ? conversation
        : { ...conversation, live: { ...conversation.live, retry: undefined } };
    case "agent_changed":
      return { ...conversation, agent: event.agent };
    case "usage_changed":
      return { ...conversation, usage: event.usage };
    case "task_failed":
      return {
        ...conversation,
        failure: {
          taskId: event.taskId,
          kind: event.kind,
          message: event.message,
        },
      };
    case "compaction_start":
      return conversation.compactions.some(({ taskId }) => taskId === event.taskId)
        ? conversation
        : {
            ...conversation,
            compactions: [
              ...conversation.compactions,
              { taskId: event.taskId, reason: event.reason, blocking: event.blocking },
            ],
          };
    case "compaction_end":
      return {
        ...conversation,
        compactions: conversation.compactions.filter(({ taskId }) => taskId !== event.taskId),
      };
    default:
      return conversation;
  }
}

/** Replace everything the agent snapshot describes; the queue arrives separately as `conversation.inbox`. */
function snapshotConversation(
  conversation: ConversationSnapshot,
  event: SnapshotEvent,
): ConversationSnapshot {
  const partial = event.generation?.message;
  return {
    id: conversation.id,
    entries: event.entries.map(transcriptEntry),
    live: liveConversation(event.run !== undefined, partial, event.generation?.retry),
    tools: event.tools.map((tool) => ({
      callId: tool.callId,
      name: tool.name,
      status: tool.status,
      ...(tool.output === undefined ? {} : { output: tool.output }),
      ...(tool.details === undefined ? {} : { details: tool.details }),
      ...(tool.diagnostics === undefined ? {} : { diagnostics: tool.diagnostics }),
    })),
    compactions: event.compactions.map(({ taskId, reason, blocking }) => ({
      taskId,
      reason,
      blocking,
    })),
    agent: event.agent,
    usage: event.usage,
    queued: conversation.queued,
    typing: conversation.typing,
    ...(partial === undefined ? {} : { partial }),
  };
}

function updateTool(
  conversation: ConversationSnapshot,
  callId: string,
  tool: ToolProgress,
): ConversationSnapshot {
  const index = conversation.tools.findIndex((candidate) => candidate.callId === callId);
  return {
    ...conversation,
    tools:
      index < 0
        ? [...conversation.tools, tool]
        : conversation.tools.map((candidate, candidateIndex) =>
            candidateIndex === index ? tool : candidate,
          ),
  };
}

function updateToolProgress(
  conversation: ConversationSnapshot,
  event: Extract<AgentEvent, { readonly type: "tool_execution_update" }>,
): ConversationSnapshot {
  const current = conversation.tools.find(({ callId }) => callId === event.toolCallId) ?? {
    callId: event.toolCallId,
    name: event.toolName,
    status: "running" as const,
  };
  let output = current.output;
  if (event.output !== undefined) {
    output =
      "set" in event.output
        ? event.output.set
        : (output ?? "").slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
  }
  return updateTool(conversation, event.toolCallId, {
    ...current,
    ...(output === undefined ? {} : { output }),
    ...("details" in event ? { details: event.details } : {}),
    ...("diagnostics" in event ? { diagnostics: event.diagnostics } : {}),
  });
}

function withPartial(
  conversation: ConversationSnapshot,
  partial: AssistantMessage,
  retry: LiveConversation["retry"],
): ConversationSnapshot {
  return {
    ...conversation,
    partial,
    live: liveConversation(true, partial, retry),
  };
}

function liveConversation(
  active: boolean,
  partial: AssistantMessage | undefined,
  retry: LiveConversation["retry"],
): LiveConversation | null {
  if (!active && partial === undefined && retry === undefined) return null;
  return {
    active,
    text: partial === undefined ? "" : assistantText(partial.content),
    ...(retry === undefined ? {} : { retry }),
  };
}

function clearCommittedPartial(
  conversation: ConversationSnapshot,
  entry: EntryRecord,
): ConversationSnapshot {
  if (entry.model?.[0]?.role !== "assistant" || conversation.partial === undefined)
    return conversation;
  return {
    ...conversation,
    partial: undefined,
    live:
      conversation.live === null
        ? null
        : { active: conversation.live.active, text: "", retry: conversation.live.retry },
  };
}

function appendEntry(conversation: ConversationSnapshot, entry: EntryRecord): ConversationSnapshot {
  if (conversation.entries.some(({ id }) => id === entry.id)) return conversation;
  const next = transcriptEntry(entry);
  if (entry.head === undefined)
    return { ...conversation, entries: [...conversation.entries, next] };
  const kept = conversation.entries.findIndex(
    (candidate) => candidate.id >= entry.head! && candidate.kind !== "pi.reset",
  );
  return {
    ...conversation,
    entries: [next, ...conversation.entries.slice(kept < 0 ? conversation.entries.length : kept)],
  };
}

function applyMessageChanges(
  current: AssistantMessage,
  changes: readonly MessageChange[],
  usage: AssistantMessage["usage"],
): AssistantMessage {
  let message = structuredClone(current);
  for (const change of changes) {
    if (change.type === "message") {
      message = structuredClone(change.message);
      continue;
    }
    if (change.type === "block") {
      message.content[change.contentIndex] = structuredClone(change.block);
    } else if (
      change.type === "text_start" ||
      change.type === "thinking_start" ||
      change.type === "toolcall_start"
    ) {
      message.content.splice(change.contentIndex, 0, structuredClone(change.block));
    } else if (change.type === "text_delta") {
      const block = message.content[change.contentIndex];
      if (block?.type !== "text") throw new Error("Text delta does not target a text block");
      block.text += change.delta;
    } else if (change.type === "thinking_delta") {
      const block = message.content[change.contentIndex];
      if (block?.type !== "thinking") {
        throw new Error("Thinking delta does not target a thinking block");
      }
      block.thinking += change.delta;
    } else if (change.type === "toolcall_delta") {
      applyToolCallDelta(message, change);
    } else {
      throw new Error(`Unsupported message change: ${change.type}`);
    }
  }
  message.usage = usage;
  return message;
}

function applyToolCallDelta(
  message: AssistantMessage,
  change: Extract<MessageChange, { readonly type: "toolcall_delta" }>,
): void {
  const block = message.content[change.contentIndex];
  if (block?.type !== "toolCall") throw new Error("Tool-call delta does not target a tool call");
  if (change.path.length === 0) throw new Error("Tool-call delta path is empty");

  let target: unknown = block.arguments;
  for (const segment of change.path.slice(0, -1)) {
    if (!isMutableContainer(target)) throw new Error("Tool-call delta path is invalid");
    target = mutableValue(target, segment);
  }
  if (!isMutableContainer(target)) throw new Error("Tool-call delta target is invalid");
  const last = change.path.at(-1)!;
  const current = mutableValue(target, last);
  if (typeof current !== "string") throw new Error("Tool-call delta target is not a string");
  setMutableValue(target, last, current + change.delta);
}

type MutableContainer = Record<string | number, unknown> | unknown[];

const isMutableContainer = (value: unknown): value is MutableContainer =>
  typeof value === "object" && value !== null;

function mutableValue(target: MutableContainer, segment: string | number): unknown {
  if (Array.isArray(target)) {
    if (typeof segment !== "number") throw new Error("Array delta path requires a numeric index");
    return target[segment];
  }
  return target[String(segment)];
}

function setMutableValue(target: MutableContainer, segment: string | number, value: unknown): void {
  if (Array.isArray(target)) {
    if (typeof segment !== "number") throw new Error("Array delta path requires a numeric index");
    target[segment] = value;
  } else {
    target[String(segment)] = value;
  }
}

function transcriptEntry(entry: EntryRecord): TranscriptEntry {
  const first = entry.model?.[0];
  const base = {
    id: entry.id,
    conversationId: entry.conversationId,
    kind: entry.kind,
    ...(first === undefined ? {} : { timestamp: first.timestamp }),
    canFork: false,
  };
  if (CompactionEntry.is(entry)) {
    const text = first === undefined ? "" : messageText(first);
    return { ...base, role: "compaction", text: compactionSummary(text) };
  }
  if (ResetEntry.is(entry)) {
    const text = first === undefined ? "" : messageText(first);
    return { ...base, role: "reset", text: text || "Context reset" };
  }
  if (ToolResultEntry.is(entry) && first?.role === "toolResult") {
    const diagnostics = toolResultDiagnostics(entry.data);
    return {
      ...base,
      role: "tool",
      text: toolResultText(first.content, diagnostics.length > 0),
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
    };
  }
  const rawText =
    entry.model?.map(messageText).filter(Boolean).join("\n\n") ||
    (entry.data === undefined ? entry.kind : JSON.stringify(entry.data));
  const scheduled = first?.role === "user" ? parseScheduledInstruction(rawText) : undefined;
  const role = scheduled === undefined ? messageRole(first) : "scheduled";
  const text = scheduled ?? rawText;
  return { ...base, role, text, canFork: role === "user" || role === "assistant" };
}

/** Compaction entries wrap the summary in the Harness's fixed `<summary>` framing. */
function compactionSummary(text: string): string {
  const match = /<summary>\n([\s\S]*)\n<\/summary>$/.exec(text);
  return match?.[1] ?? text;
}

/** Tool result content ends with a rendered `<harness>` block whenever the entry carries diagnostics. */
function toolResultText(content: readonly unknown[], hasDiagnostics: boolean): string {
  const parts = hasDiagnostics ? content.slice(0, -1) : content;
  return contentText(parts);
}

function toolResultDiagnostics(data: EntryRecord["data"]): readonly ToolDiagnostic[] {
  if (!isRecord(data) || !Array.isArray(data.diagnostics)) return [];
  return data.diagnostics.filter(isToolDiagnostic);
}

const DIAGNOSTIC_SEVERITIES: ReadonlySet<unknown> = new Set(["info", "warn", "error"]);

function isToolDiagnostic(value: unknown): value is ToolDiagnostic {
  return (
    isRecord(value) &&
    DIAGNOSTIC_SEVERITIES.has(value.severity) &&
    typeof value.message === "string" &&
    (value.code === undefined || typeof value.code === "string")
  );
}

function messageRole(message: Message | undefined): TranscriptEntry["role"] {
  switch (message?.role) {
    case "user":
    case "assistant":
    case "system":
      return message.role;
    case "toolResult":
      return "tool";
    default:
      return "event";
  }
}

function messageText(message: Message): string {
  switch (message.role) {
    case "system": {
      const content = contentText(message.content);
      const sections = Object.values(message.sections ?? {}).filter(
        (value): value is string => typeof value === "string",
      );
      return [content, ...sections].filter(Boolean).join("\n\n");
    }
    case "user":
      return contentText(message.content);
    case "assistant":
      return assistantText(message.content) || message.errorMessage || "";
    case "toolResult":
      return contentText(message.content);
  }
}

function contentText(content: string | readonly unknown[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "image") return "[Image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function assistantText(content: readonly unknown[]): string {
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "toolCall" && typeof part.name === "string")
        return `Tool call: ${part.name}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
