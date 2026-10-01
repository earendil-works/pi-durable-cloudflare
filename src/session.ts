import { type Connection, type ConnectionContext, Server, type WSMessage } from "partyserver";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  defineDocFamily,
  type EntryId,
  Harness,
  InboxDoc,
  type TaskId,
  watchEvents,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { normalizeUsername } from "./identity.ts";
import { planHarnessAlarm } from "./schedule.ts";
import { createChatHarnessOptions } from "./chat.ts";
import {
  InvalidClientCommand,
  MAX_CLIENT_FRAME_CHARACTERS,
  parseClientCommand,
  type ClientCommand,
  type ConversationSummary,
  queuedInputs,
  type ServerEvent,
} from "./protocol.ts";
import { createCloudflareSqliteDatabase } from "./sqlite.ts";

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const reportError = (
  message: string,
  error: unknown,
  details: Readonly<Record<string, unknown>> = {},
): void => {
  console.error(
    JSON.stringify({
      message,
      ...details,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
};

const RECOVERY_ALARM_DELAY_MS = 60_000;
const CONVERSATION_PAGE_SIZE = 100;

type ConversationCommandReceipt =
  | {
      command: "conversation.create";
      conversationId: ConversationId;
    }
  | {
      command: "conversation.fork";
      conversationId: ConversationId;
      parentConversationId: ConversationId;
      entryId: EntryId;
    };

const ConversationCommandReceipts = defineDocFamily<
  {
    receipt?: ConversationCommandReceipt;
  },
  null
>({
  family: true,
  kind: "app.conversation-command-receipt",
  version: 1,
  scope: "session",
  initial: () => ({}),
});

type SessionConnectionState = {
  readonly username: string;
  readonly conversationId?: number;
  readonly typing?: true;
};

const usernameForConnection = (connection: Connection, request: Request): string => {
  const requested = new URL(request.url).searchParams.get("username") ?? "";
  const username = normalizeUsername(requested);
  if (username.length > 0) return username;
  const suffix = connection.id.replace(/[^a-z0-9]/giu, "").slice(0, 6) || "guest";
  return `Guest-${suffix}`;
};

const attributedPrompt = (username: string, content: string): string => `[${username}]\n${content}`;

const conversationSummary = (conversation: ConversationRecord): ConversationSummary => ({
  id: conversation.id,
  ...(conversation.parent === undefined
    ? {}
    : {
        parent: {
          conversationId: conversation.parent.conversationId,
          at: conversation.parent.at,
        },
      }),
  ...(conversation.owner === undefined
    ? {}
    : { owner: { conversationId: conversation.owner.conversationId } }),
});

export class Session extends Server<Env> {
  static override options = { hibernate: true };

  #harness!: Harness;
  readonly #eventStreams = new Map<WebSocket, AgentEventStream>();
  readonly #typingConnections = new Set<WebSocket>();
  readonly #alarmTaskWatches = new Set<TaskId>();
  #watchTaskSettlements = false;
  #alarmUpdate: Promise<void> = Promise.resolve();

  override async onStart(): Promise<void> {
    const storage = await SqliteStorage.open(createCloudflareSqliteDatabase(this.ctx.storage));
    this.#harness = await Harness.open(
      storage,
      createChatHarnessOptions({
        scheduleCreated: () => this.#refreshAlarm(),
      }),
      BACKGROUND_CONTEXT,
    );
    // Tool calls create subagent conversations outside any socket command; announce them to every open sidebar.
    this.#harness.subscribeCommits((publication) => {
      const subagentCreated = publication.changes.some(
        (change) => change.type === "conversation" && change.value.owner !== undefined,
      );
      if (!subagentCreated) return;
      // Commit listeners must not call Session APIs; read the list after this listener returns.
      queueMicrotask(() => {
        this.#broadcastSessionSnapshot().catch((error: unknown) =>
          reportError("Session snapshot broadcast failed", error),
        );
      });
    });
    await this.#restoreEventStreams();
    await this.#refreshAlarm();
    this.#watchTaskSettlements = true;
    this.#harness.resume();
    await this.#refreshAlarm();
  }

  override async onAlarm(): Promise<void> {
    this.#harness.resume();
    await this.#refreshAlarm();
  }

  override onRequest(): Response {
    return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
  }

  override async onMessage(
    socket: Connection<SessionConnectionState>,
    message: WSMessage,
  ): Promise<void> {
    if (typeof message !== "string") {
      this.#send(socket, {
        type: "error",
        error: { code: "invalid_message", message: "Binary messages are not supported" },
      });
      socket.close(1002, "Binary protocol frame");
      return;
    }

    if (message.length > MAX_CLIENT_FRAME_CHARACTERS) {
      this.#send(socket, {
        type: "error",
        error: { code: "frame_too_large", message: "Command frame exceeds the size limit" },
      });
      socket.close(1009, "Command frame too large");
      return;
    }

    let command: ClientCommand;
    try {
      command = parseClientCommand(message);
    } catch (error) {
      if (!(error instanceof InvalidClientCommand)) throw error;
      this.#send(socket, {
        type: "error",
        error: { code: "invalid_command", message: error.message },
      });
      socket.close(1002, "Invalid command frame");
      return;
    }

    try {
      await this.#handleCommand(socket, command);
    } catch (error) {
      reportError("Session command failed", error, { command: command.type });
      if (command.type === "presence.typing") return;
      this.#send(socket, {
        type: "command.result",
        command: command.type,
        requestId: command.requestId,
        ok: false,
        error: {
          code: "command_failed",
          message: error instanceof Error ? error.message : "Command failed",
        },
      });
    }
  }

  override async onClose(socket: Connection<SessionConnectionState>): Promise<void> {
    this.#setTyping(socket, false);
    await this.#stopEventStream(socket);
  }

  override async onError(
    socket: Connection<SessionConnectionState>,
    error: unknown,
  ): Promise<void> {
    reportError("Session WebSocket failed", error);
    this.#setTyping(socket, false);
    await this.#stopEventStream(socket);
  }

  override async onConnect(
    server: Connection<SessionConnectionState>,
    context: ConnectionContext,
  ): Promise<void> {
    const root = await this.#harness.root(BACKGROUND_CONTEXT);
    server.setState({ username: usernameForConnection(server, context.request) });
    await this.#sendSessionSnapshot(server);
    await this.#watchConversation(server, root.id);
  }

  async #handleCommand(
    socket: Connection<SessionConnectionState>,
    command: ClientCommand,
  ): Promise<void> {
    switch (command.type) {
      case "presence.typing":
        if (socket.state?.conversationId === command.conversationId) {
          this.#setTyping(socket, command.typing);
        }
        return;
      case "conversation.open":
        await this.#requireConversation(command.conversationId as ConversationId);
        await this.#watchConversation(socket, command.conversationId as ConversationId);
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
        });
        return;
      case "conversation.create": {
        const conversationId = await this.#harness.commit(async (tx) => {
          const receipt = await tx.doc(ConversationCommandReceipts, command.requestId, null);
          const existing = receipt.receipt;
          if (existing !== undefined) {
            if (existing.command !== command.type) {
              throw new Error(
                `Request ${command.requestId} was already used for ${existing.command}`,
              );
            }
            return existing.conversationId;
          }
          const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
          receipt.receipt = {
            command: command.type,
            conversationId: conversation.id,
          };
          return conversation.id;
        }, BACKGROUND_CONTEXT);
        await this.#watchConversation(socket, conversationId);
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId,
        });
        return;
      }
      case "conversation.fork": {
        const parentConversationId = command.conversationId as ConversationId;
        const entryId = command.entryId as EntryId;
        const conversationId = await this.#harness.commit(async (tx) => {
          const receipt = await tx.doc(ConversationCommandReceipts, command.requestId, null);
          const existing = receipt.receipt;
          if (existing !== undefined) {
            if (
              existing.command !== command.type ||
              existing.parentConversationId !== parentConversationId ||
              existing.entryId !== entryId
            ) {
              throw new Error(`Request ${command.requestId} was already used for another command`);
            }
            return existing.conversationId;
          }
          const fork = await tx.forkConversation(parentConversationId, entryId, {
            ownership: { kind: "ownerless" },
          });
          receipt.receipt = {
            command: command.type,
            conversationId: fork.id,
            parentConversationId,
            entryId,
          };
          return fork.id;
        }, BACKGROUND_CONTEXT);
        await this.#watchConversation(socket, conversationId);
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId,
        });
        return;
      }
      case "prompt.submit": {
        this.#setTyping(socket, false);
        const conversation = await this.#requireConversation(
          command.conversationId as ConversationId,
        );
        await this.#setAlarmNoLaterThan(Date.now() + RECOVERY_ALARM_DELAY_MS);
        const submission = await conversation.submit(
          {
            type: "input",
            content: attributedPrompt(socket.state?.username ?? "Guest", command.content),
            requestId: command.requestId,
            // Queue behind a running turn instead of rejecting; the inbox places it after the current answer.
            whenBusy: "followUp",
          },
          BACKGROUND_CONTEXT,
        );
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: conversation.id,
          submissionId: submission.id,
        });
        void submission
          .wait(BACKGROUND_CONTEXT)
          .then(() => this.#refreshAlarm())
          .catch((error: unknown) => reportError("Prompt alarm reconciliation failed", error));
        try {
          await this.#refreshAlarm();
        } catch (error) {
          reportError("Prompt alarm reconciliation failed", error);
        }
      }
    }
  }

  async #requireConversation(id: ConversationId): Promise<Conversation> {
    const conversation = await this.#harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`);
    return conversation;
  }

  async #sendSessionSnapshot(socket: Connection<SessionConnectionState>): Promise<void> {
    this.#send(socket, {
      type: "session.snapshot",
      session: { conversations: await this.#sessionSnapshot() },
    });
  }

  async #broadcastSessionSnapshot(): Promise<void> {
    this.#broadcast({
      type: "session.snapshot",
      session: { conversations: await this.#sessionSnapshot() },
    });
  }

  #sessionSnapshot(): Promise<readonly ConversationSummary[]> {
    return this.#harness.commit(async (tx) => {
      const conversations: ConversationSummary[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, CONVERSATION_PAGE_SIZE, cursor);
        conversations.push(...page.items.map(conversationSummary));
        cursor = page.next;
      } while (cursor !== undefined);
      return conversations;
    }, BACKGROUND_CONTEXT);
  }

  async #watchConversation(
    socket: Connection<SessionConnectionState>,
    conversationId: ConversationId,
    restoreTyping = false,
  ): Promise<void> {
    this.#setTyping(socket, false);
    await this.#stopEventStream(socket);
    const username = socket.state?.username ?? "Guest";
    socket.setState({ username });
    const stream = await watchEvents(this.#harness, conversationId, BACKGROUND_CONTEXT);
    this.#eventStreams.set(socket, stream);
    socket.setState({ username, conversationId, ...(restoreTyping ? { typing: true } : {}) });
    if (restoreTyping) this.#typingConnections.add(socket);
    this.#send(socket, {
      type: "conversation.events",
      conversationId,
      events: [stream.snapshot],
    });
    await this.#sendInbox(socket, conversationId);
    stream.start(async (events) => {
      if (this.#eventStreams.get(socket) !== stream) return;
      this.#send(socket, { type: "conversation.events", conversationId, events });
      if (events.some(({ type }) => type === "inbox_update" || type === "snapshot")) {
        await this.#sendInbox(socket, conversationId);
      }
    });
    void stream.closed.finally(() => {
      if (this.#eventStreams.get(socket) === stream) this.#eventStreams.delete(socket);
    });
    this.#broadcastTyping(conversationId);
  }

  /** Inbox events carry only submission IDs; the queued text lives in the conversation's `pi.inbox` document. */
  async #sendInbox(
    socket: Connection<SessionConnectionState>,
    conversationId: ConversationId,
  ): Promise<void> {
    const inbox = await this.#harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT);
    this.#send(socket, { type: "conversation.inbox", conversationId, items: queuedInputs(inbox) });
  }

  async #stopEventStream(socket: Connection<SessionConnectionState>): Promise<void> {
    const stream = this.#eventStreams.get(socket);
    if (stream === undefined) return;
    this.#eventStreams.delete(socket);
    await stream.stop();
  }

  async #restoreEventStreams(): Promise<void> {
    for (const socket of this.getConnections<SessionConnectionState>()) {
      const attachment = socket.state;
      if (
        attachment !== null &&
        typeof attachment.conversationId === "number" &&
        Number.isSafeInteger(attachment.conversationId) &&
        attachment.conversationId > 0
      ) {
        const conversationId = attachment.conversationId as ConversationId;
        await this.#watchConversation(socket, conversationId, attachment.typing === true);
      }
    }
  }

  #broadcast(event: ServerEvent): void {
    this.broadcast(JSON.stringify(event));
  }

  #send(socket: Connection<SessionConnectionState>, event: ServerEvent): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }

  #setTyping(socket: Connection<SessionConnectionState>, typing: boolean): void {
    const state = socket.state;
    if (state === null || state.conversationId === undefined) return;
    const conversationId = state.conversationId;
    const changed = typing
      ? !this.#typingConnections.has(socket)
      : this.#typingConnections.delete(socket);
    if (typing) this.#typingConnections.add(socket);
    if (socket.readyState === WebSocket.OPEN) {
      socket.setState({
        username: state.username,
        conversationId,
        ...(typing ? { typing: true } : {}),
      });
    }
    if (changed) this.#broadcastTyping(conversationId as ConversationId);
  }

  #broadcastTyping(conversationId: ConversationId): void {
    const connections = [...this.getConnections<SessionConnectionState>()].filter(
      (connection) => connection.state?.conversationId === conversationId,
    );
    const typers = connections.filter((connection) => this.#typingConnections.has(connection));
    for (const receiver of connections) {
      const usernames = [
        ...new Set(
          typers
            .filter((connection) => connection !== receiver)
            .map((connection) => connection.state?.username)
            .filter((username): username is string => username !== undefined),
        ),
      ].sort((left, right) => left.localeCompare(right));
      this.#send(receiver, { type: "presence.typing", conversationId, usernames });
    }
  }

  #refreshAlarm(): Promise<void> {
    return this.#serializeAlarmUpdate(async () => {
      const inspection = await this.#harness.inspect(BACKGROUND_CONTEXT);
      const plan = planHarnessAlarm(inspection.tasks, Date.now());
      if (this.#watchTaskSettlements) {
        for (const taskId of plan.recoveryTasks) this.#refreshAlarmWhenTaskSettles(taskId);
      }
      const recovery =
        plan.recoveryTasks.length > 0 ? Date.now() + RECOVERY_ALARM_DELAY_MS : undefined;
      const next =
        plan.nextDeadline === undefined
          ? recovery
          : recovery === undefined
            ? plan.nextDeadline
            : Math.min(plan.nextDeadline, recovery);
      await this.#replaceAlarm(next);
    });
  }

  #setAlarmNoLaterThan(timestamp: number): Promise<void> {
    return this.#serializeAlarmUpdate(() =>
      this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.getAlarm();
        if (current === null || timestamp < current) await transaction.setAlarm(timestamp);
      }),
    );
  }

  #serializeAlarmUpdate(operation: () => Promise<void>): Promise<void> {
    const update = this.#alarmUpdate.then(operation, operation);
    this.#alarmUpdate = update;
    return update;
  }

  #refreshAlarmWhenTaskSettles(taskId: TaskId): void {
    if (this.#alarmTaskWatches.has(taskId)) return;
    this.#alarmTaskWatches.add(taskId);
    void this.#harness
      .waitForTask(taskId, BACKGROUND_CONTEXT)
      .then(() => this.#refreshAlarm())
      .catch((error: unknown) =>
        reportError("Harness task alarm reconciliation failed", error, { taskId }),
      )
      .finally(() => this.#alarmTaskWatches.delete(taskId));
  }

  #replaceAlarm(timestamp: number | undefined): Promise<void> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.getAlarm();
      if (timestamp === undefined) {
        if (current !== null) await transaction.deleteAlarm();
      } else if (current !== timestamp) {
        await transaction.setAlarm(timestamp);
      }
    });
  }
}
