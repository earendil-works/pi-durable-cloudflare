import type { AgentEvent, InboxState } from "@earendil-works/pi-durable";

export const ROOT_CONVERSATION_ID = 1;
export const MAX_PROMPT_CHARACTERS = 100_000;
export const MAX_REQUEST_ID_CHARACTERS = 256;
// JSON may escape each prompt code unit as six characters.
export const MAX_CLIENT_FRAME_CHARACTERS =
  MAX_PROMPT_CHARACTERS * 6 + MAX_REQUEST_ID_CHARACTERS + 1024;
const SCHEDULED_INSTRUCTION_PREFIX = "Scheduled instruction due now: ";
const RECURRENCE_NOTE_PREFIX = "\n\nThis instruction recurs.";

/** Input submitted when a scheduled instruction is due. Self-contained; no system-prompt support needed. */
export function formatScheduledInstruction(scheduled: {
  readonly id: string;
  readonly instruction: string;
  readonly recurring?: true;
}): string {
  const text = `${SCHEDULED_INSTRUCTION_PREFIX}${scheduled.instruction}`;
  if (scheduled.recurring !== true) return text;
  return `${text}${RECURRENCE_NOTE_PREFIX} After carrying it out, schedule its next occurrence with recurring: true and sourceScheduleId ${JSON.stringify(scheduled.id)}.`;
}

/** The instruction text of a scheduled delivery input, or `undefined` for ordinary input. */
export function parseScheduledInstruction(content: string): string | undefined {
  if (!content.startsWith(SCHEDULED_INSTRUCTION_PREFIX)) return undefined;
  const text = content.slice(SCHEDULED_INSTRUCTION_PREFIX.length);
  const note = text.lastIndexOf(RECURRENCE_NOTE_PREFIX);
  return note === -1 ? text : text.slice(0, note);
}

/** Display text of queued user input content: a string or text/image parts. */
function userInputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
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

/** A user input waiting in a conversation's inbox for the current turn to finish. */
export interface QueuedInput {
  readonly submissionId: number;
  readonly mode: "steer" | "followUp";
  readonly text: string;
}

/** Queued user inputs of a conversation's `pi.inbox` document; passive writes are not user messages. */
export function queuedInputs(inbox: Readonly<InboxState> | undefined): QueuedInput[] {
  const items: QueuedInput[] = [];
  for (const item of inbox?.items ?? []) {
    if (item.mode === "write") continue;
    items.push({ submissionId: item.id, mode: item.mode, text: userInputText(item.content) });
  }
  return items;
}

export type ConnectionStatus = "connecting" | "connected" | "failed";

export interface ConversationSummary {
  readonly id: number;
  readonly parent?: {
    readonly conversationId: number;
    readonly at: number;
  };
}

export type ClientCommand =
  | {
      readonly type: "conversation.open";
      readonly requestId: string;
      readonly conversationId: number;
    }
  | {
      readonly type: "conversation.create";
      readonly requestId: string;
    }
  | {
      readonly type: "conversation.fork";
      readonly requestId: string;
      readonly conversationId: number;
      readonly entryId: number;
    }
  | {
      readonly type: "prompt.submit";
      readonly requestId: string;
      readonly conversationId: number;
      readonly content: string;
    };
export type ClientCommandType = ClientCommand["type"];

export type CommandResult =
  | {
      readonly type: "command.result";
      readonly command: ClientCommandType;
      readonly requestId: string;
      readonly ok: true;
      readonly conversationId?: number;
      readonly submissionId?: number;
    }
  | {
      readonly type: "command.result";
      readonly command: ClientCommandType;
      readonly requestId: string;
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };

export type ServerEvent =
  | {
      readonly type: "session.snapshot";
      readonly session: {
        readonly conversations: readonly ConversationSummary[];
      };
    }
  | {
      readonly type: "conversation.events";
      readonly conversationId: number;
      readonly events: readonly AgentEvent[];
    }
  | {
      readonly type: "conversation.inbox";
      readonly conversationId: number;
      readonly items: readonly QueuedInput[];
    }
  | CommandResult
  | {
      readonly type: "error";
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };

export class InvalidClientCommand extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRequestId = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REQUEST_ID_CHARACTERS) {
    throw new InvalidClientCommand(
      `requestId must be a non-empty string of at most ${MAX_REQUEST_ID_CHARACTERS} characters`,
    );
  }
  return value;
};

const requireId = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidClientCommand(`${name} must be a positive integer`);
  }
  return value;
};

const optionalId = (value: unknown, name: string): number | undefined =>
  value === undefined ? undefined : requireId(value, name);

const commandTypes = new Set<ClientCommandType>([
  "conversation.open",
  "conversation.create",
  "conversation.fork",
  "prompt.submit",
]);

const requireCommandType = (value: unknown): ClientCommandType => {
  if (typeof value !== "string" || !commandTypes.has(value as ClientCommandType)) {
    throw new Error("Command result command is invalid");
  }
  return value as ClientCommandType;
};

const requireError = (value: unknown): { readonly code: string; readonly message: string } => {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") {
    throw new Error("Server error payload is invalid");
  }
  return { code: value.code, message: value.message };
};

export function parseClientCommand(message: string): ClientCommand {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch (error) {
    throw new InvalidClientCommand("Message must contain valid JSON", { cause: error });
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new InvalidClientCommand("Message must be a command object");
  }

  const requestId = requireRequestId(value.requestId);
  switch (value.type) {
    case "conversation.open":
      return {
        type: value.type,
        requestId,
        conversationId: requireId(value.conversationId, "conversationId"),
      };
    case "conversation.create":
      return { type: value.type, requestId };
    case "conversation.fork":
      return {
        type: value.type,
        requestId,
        conversationId: requireId(value.conversationId, "conversationId"),
        entryId: requireId(value.entryId, "entryId"),
      };
    case "prompt.submit": {
      if (typeof value.content !== "string" || value.content.trim().length === 0) {
        throw new InvalidClientCommand("content must contain text");
      }
      if (value.content.length > MAX_PROMPT_CHARACTERS) {
        throw new InvalidClientCommand(`content cannot exceed ${MAX_PROMPT_CHARACTERS} characters`);
      }
      return {
        type: value.type,
        requestId,
        conversationId: requireId(value.conversationId, "conversationId"),
        content: value.content,
      };
    }
    default:
      throw new InvalidClientCommand(`Unknown command type: ${value.type}`);
  }
}

/** Validate the application envelope. Agent event payloads remain owned by pi-durable's typed protocol. */
export function parseServerEventEnvelope(message: string): ServerEvent {
  const value: unknown = JSON.parse(message);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Server message is not an event object");
  }

  switch (value.type) {
    case "session.snapshot": {
      if (!isRecord(value.session) || !Array.isArray(value.session.conversations)) {
        throw new Error("Session snapshot payload is invalid");
      }
      const conversations = value.session.conversations.map((conversation) => {
        if (!isRecord(conversation)) throw new Error("Conversation summary is invalid");
        const id = requireId(conversation.id, "conversation.id");
        if (conversation.parent === undefined) return { id };
        if (!isRecord(conversation.parent)) throw new Error("Conversation parent is invalid");
        return {
          id,
          parent: {
            conversationId: requireId(
              conversation.parent.conversationId,
              "conversation.parent.conversationId",
            ),
            at: requireId(conversation.parent.at, "conversation.parent.at"),
          },
        };
      });
      return { type: value.type, session: { conversations } };
    }
    case "conversation.events": {
      const conversationId = requireId(value.conversationId, "conversationId");
      if (
        !Array.isArray(value.events) ||
        !value.events.every((event) => isRecord(event) && typeof event.type === "string")
      ) {
        throw new Error("Conversation events payload is invalid");
      }
      return {
        type: value.type,
        conversationId,
        events: value.events as unknown as readonly AgentEvent[],
      };
    }
    case "conversation.inbox": {
      const conversationId = requireId(value.conversationId, "conversationId");
      if (!Array.isArray(value.items)) throw new Error("Conversation inbox payload is invalid");
      const items = value.items.map((item): QueuedInput => {
        if (
          !isRecord(item) ||
          (item.mode !== "steer" && item.mode !== "followUp") ||
          typeof item.text !== "string"
        ) {
          throw new Error("Queued input is invalid");
        }
        return {
          submissionId: requireId(item.submissionId, "submissionId"),
          mode: item.mode,
          text: item.text,
        };
      });
      return { type: value.type, conversationId, items };
    }
    case "command.result": {
      const requestId = requireRequestId(value.requestId);
      const command = requireCommandType(value.command);
      if (value.ok === true) {
        const conversationId = optionalId(value.conversationId, "conversationId");
        const submissionId = optionalId(value.submissionId, "submissionId");
        return {
          type: value.type,
          command,
          requestId,
          ok: true,
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(submissionId === undefined ? {} : { submissionId }),
        };
      }
      if (value.ok === false) {
        return {
          type: value.type,
          command,
          requestId,
          ok: false,
          error: requireError(value.error),
        };
      }
      throw new Error("Command result payload is invalid");
    }
    case "error":
      return { type: value.type, error: requireError(value.error) };
    default:
      throw new Error(`Unknown server event: ${value.type}`);
  }
}
