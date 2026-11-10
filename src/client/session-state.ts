import type { JsonValue } from "@earendil-works/chord/json";
import type { AssistantMessage, Message, NestedToolCalls } from "@earendil-works/pi-ai";
import type {
  AgentState,
  CompactionReason,
  EntryRecord,
  InboxState,
  LiveState,
  RunFailure,
  TaskGraph,
  ToolDiagnostic,
  TranscriptItem,
  TranscriptView,
  UsageState,
} from "@earendil-works/pi-durable";
import { CompactionEntry, ResetEntry, ToolResultEntry } from "@earendil-works/pi-durable";
import {
  ROOT_CONVERSATION_ID,
  parseScheduledInstruction,
  queuedInputs,
  type ConnectionStatus,
  type ConversationSummary,
  type QueuedInput,
  type ServerEvent,
} from "../protocol.ts";

export interface TranscriptToolCall {
  readonly callId: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface TranscriptToolResult {
  readonly callId: string;
  readonly name: string;
  readonly isError: boolean;
  readonly details?: unknown;
  readonly nestedCalls?: NestedToolCalls;
}

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
  readonly toolCalls?: readonly TranscriptToolCall[];
  readonly toolResult?: TranscriptToolResult;
}

/** Entries the client has not loaded, between two it has: `after` and `upTo` are exclusive. */
export type TranscriptGap = Extract<TranscriptItem, { readonly kind: "gap" }>;

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
  readonly output?: string;
  readonly details?: JsonValue;
  readonly diagnostics?: readonly ToolDiagnostic[];
}

export interface LiveCompaction {
  readonly taskId: number;
  readonly reason: CompactionReason;
  readonly blocking: boolean;
}

/** What the client renders of one conversation, derived from its view. */
export interface ConversationSnapshot {
  readonly id: number;
  readonly entries: readonly TranscriptEntry[];
  /** The transcript continues before the oldest entry loaded. */
  readonly earlier: boolean;
  /** Ranges between loaded entries that are still missing, as after a reconnect. */
  readonly gaps: readonly TranscriptGap[];
  readonly partial?: AssistantMessage;
  readonly live: LiveConversation | null;
  readonly tools: readonly ToolProgress[];
  readonly compactions: readonly LiveCompaction[];
  /** Inputs submitted during a running turn, waiting to be placed after it. */
  readonly queued: readonly QueuedInput[];
  readonly typing: readonly string[];
  readonly agent?: Readonly<AgentState>;
  readonly usage?: Readonly<UsageState>;
  /** Why the last run or compaction ended without a result, until a later one starts. */
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
  readonly activity?: TaskGraph;
  readonly error?: string;
}

export type SessionAction =
  | { readonly type: "connection"; readonly status: ConnectionStatus }
  | { readonly type: "select"; readonly conversationId: number }
  | { readonly type: "event"; readonly event: ServerEvent }
  /** A conversation's view with the client's whole transcript (`ConversationTranscript.merge()`). */
  | { readonly type: "view"; readonly conversationId: number; readonly view: TranscriptView }
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
    case "view": {
      const typing = state.snapshots[action.conversationId]?.typing ?? [];
      return {
        ...state,
        snapshots: {
          ...state.snapshots,
          [action.conversationId]: conversationSnapshot(action.conversationId, action.view, typing),
        },
      };
    }
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
      return {
        ...state,
        conversations,
        activeConversationId,
        ...(event.session.activity === undefined ? {} : { activity: event.session.activity }),
      };
    }
    case "conversation.created": {
      const conversations = [
        ...state.conversations.filter(({ id }) => id !== event.conversation.id),
        event.conversation,
      ].sort((left, right) => left.id - right.id);
      return { ...state, conversations };
    }
    case "session.activity":
      return { ...state, activity: event.activity };
    // Views and their operations are merged into the conversation's transcript first; see `view` actions.
    case "conversation.view":
    case "conversation.ops":
      return state;
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
  earlier: false,
  gaps: [],
  live: null,
  tools: [],
  compactions: [],
  queued: [],
  typing: [],
});

/**
 * Everything the client draws of a conversation is state in its view: the transcript, and `pi.live` for the run,
 * the streamed answer, tool progress, compactions and failures; `pi.inbox`, `pi.agent`, and `pi.usage` beside it.
 */
export function conversationSnapshot(
  id: number,
  view: TranscriptView,
  typing: readonly string[] = [],
): ConversationSnapshot {
  const live = (view.docs["pi.live"] ?? {}) as unknown as LiveState;
  const partial = live.generation?.message as AssistantMessage | undefined;
  const failure = conversationFailure(live);
  const agent = view.docs["pi.agent"] as AgentState | undefined;
  const usage = view.docs["pi.usage"] as unknown as UsageState | undefined;
  return {
    id,
    entries: view.items.flatMap((item) =>
      item.kind === "entry" ? [transcriptEntry(item.entry)] : [],
    ),
    earlier: view.items[0]?.kind === "earlier",
    gaps: view.items.filter((item): item is TranscriptGap => item.kind === "gap"),
    live: liveConversation(live.run !== undefined, partial, live.generation?.retry),
    tools: (live.tools ?? []).map((slot) => ({
      callId: slot.callId,
      name: slot.name,
      status: slot.status,
      ...(slot.output === undefined ? {} : { output: slot.output }),
      ...(slot.details === undefined ? {} : { details: slot.details }),
      ...(slot.diagnostics === undefined ? {} : { diagnostics: slot.diagnostics }),
    })),
    compactions: (live.compactions ?? []).map(({ taskId, trigger, blocking }) => ({
      taskId,
      reason: trigger,
      blocking,
    })),
    queued: queuedInputs(view.docs["pi.inbox"] as InboxState | undefined),
    typing,
    ...(partial === undefined ? {} : { partial }),
    ...(agent === undefined ? {} : { agent }),
    ...(usage === undefined ? {} : { usage }),
    ...(failure === undefined ? {} : { failure }),
  };
}

const RUN_FAILURE_REASONS: Record<RunFailure["reason"], string> = {
  model_error: "The model request failed",
  no_model: "No model is available",
  aborted: "The run was aborted",
  reset: "The context was reset",
  faulted: "The run faulted",
  orphaned: "The run's task cannot run here",
  interrupted: "The server stopped while the model was answering",
  restart_limit: "The run was cut off too often",
  nothing_to_answer: "There was nothing to answer",
  turn_limit: "The run reached its tool round limit",
};

function conversationFailure(live: LiveState): ConversationSnapshot["failure"] {
  const run = live.runFailure;
  if (run !== undefined) {
    const reason = RUN_FAILURE_REASONS[run.reason] ?? run.reason;
    return {
      taskId: run.taskId,
      kind: "Run",
      message: run.detail === undefined ? reason : `${reason}: ${run.detail}`,
    };
  }
  const compaction = live.compactionFailure;
  return compaction === undefined
    ? undefined
    : { taskId: compaction.taskId, kind: "Compaction", message: compaction.error };
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
      toolResult: {
        callId: first.toolCallId,
        name: first.toolName,
        isError: first.isError,
        ...(first.details === undefined ? {} : { details: first.details }),
        ...(first.nestedCalls === undefined ? {} : { nestedCalls: first.nestedCalls }),
      },
    };
  }
  const rawText =
    entry.model?.map(messageText).filter(Boolean).join("\n\n") ||
    (first?.role === "assistant"
      ? ""
      : entry.data === undefined
        ? entry.kind
        : JSON.stringify(entry.data));
  const scheduled = first?.role === "user" ? parseScheduledInstruction(rawText) : undefined;
  const role = scheduled === undefined ? messageRole(first) : "scheduled";
  const text = scheduled ?? rawText;
  const toolCalls =
    first?.role === "assistant"
      ? first.content.flatMap((part) =>
          part.type === "toolCall"
            ? [{ callId: part.id, name: part.name, args: part.arguments }]
            : [],
        )
      : [];
  return {
    ...base,
    role,
    text,
    canFork: role === "user" || role === "assistant",
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
  };
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
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
