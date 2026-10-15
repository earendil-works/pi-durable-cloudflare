import { DurableObject } from "cloudflare:workers";
import type { AttachedReplicatedState } from "@earendil-works/chord";
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
  type TaskGraph,
  type TaskId,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { normalizeUsername } from "./identity.ts";
import { scheduledDeadline } from "./schedule.ts";
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
import { KeyedSerialQueue } from "./serial.ts";

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

type LegacyPartyServerAttachment = {
  readonly __user?: unknown;
};

type WSMessage = string | ArrayBuffer;

const isSessionConnectionState = (value: unknown): value is SessionConnectionState => {
  if (typeof value !== "object" || value === null || !("username" in value)) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.username === "string" &&
    (state.conversationId === undefined ||
      (typeof state.conversationId === "number" &&
        Number.isSafeInteger(state.conversationId) &&
        state.conversationId > 0)) &&
    (state.typing === undefined || state.typing === true)
  );
};

const connectionState = (socket: WebSocket): SessionConnectionState | null => {
  const attachment: unknown = socket.deserializeAttachment();
  // Hibernated sockets can survive a deployment from the former PartyServer implementation.
  if (isSessionConnectionState(attachment)) return attachment;
  if (typeof attachment !== "object" || attachment === null || !("__user" in attachment)) {
    return null;
  }
  const legacy = attachment as LegacyPartyServerAttachment;
  return isSessionConnectionState(legacy.__user) ? legacy.__user : null;
};

const setConnectionState = (socket: WebSocket, state: SessionConnectionState): void => {
  socket.serializeAttachment(state);
};

const usernameForConnection = (connectionId: string, request: Request): string => {
  const requested = new URL(request.url).searchParams.get("username") ?? "";
  const username = normalizeUsername(requested);
  if (username.length > 0) return username;
  const suffix = connectionId.replace(/[^a-z0-9]/giu, "").slice(0, 6) || "guest";
  return `Guest-${suffix}`;
};

const isReservedCloseCode = (code: number): boolean =>
  code === 1005 || code === 1006 || code === 1015;

const reciprocateClose = (socket: WebSocket, code: number, reason: string): void => {
  if (isReservedCloseCode(code)) return;
  try {
    socket.close(code, reason);
  } catch {
    // The socket is already closed or the peer is no longer reachable.
  }
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

export class Session extends DurableObject<Env> {
  #harness!: Harness;
  #activity!: AttachedReplicatedState<TaskGraph>;
  readonly #eventStreams = new Map<WebSocket, AgentEventStream>();
  readonly #typingConnections = new Set<WebSocket>();
  readonly #connectionOperations = new KeyedSerialQueue<WebSocket>();
  readonly #alarmTaskWatches = new Set<TaskId>();
  #alarmUpdate: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => this.#initialize());
  }

  async #initialize(): Promise<void> {
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const chatOptions = createChatHarnessOptions((timestamp) =>
      this.#setAlarmNoLaterThan(timestamp),
    );
    const harness = await Harness.open(
      storage,
      {
        ...chatOptions,
        onReport: (error) => reportError("Harness background task failed", error),
      },
      BACKGROUND_CONTEXT,
    );

    // A storage error closes the harness. Reset the object so the next event reopens it.
    void harness.closed.then((end) => {
      if (end.reason === "failed") this.ctx.abort("Harness failed");
    });

    let activity: AttachedReplicatedState<TaskGraph> | undefined;
    try {
      this.#harness = harness;
      activity = await harness.taskGraph(BACKGROUND_CONTEXT);
      this.#activity = activity;
      activity.subscribe((value, _context, delivery) => {
        if (delivery.kind === "update")
          this.#broadcast({ type: "session.activity", activity: value });
      });
      // Subagents are created by background tool tasks, not client commands.
      // Notify connected clients when their conversation records are committed.
      harness.subscribeCommits((publication) => {
        for (const change of publication.changes) {
          if (change.type !== "conversation" || change.value.owner === undefined) continue;
          this.#broadcast({
            type: "conversation.created",
            conversation: conversationSummary(change.value),
          });
        }
      });
      await this.#restoreEventStreams();
      await this.#refreshAlarm();
    } catch (error) {
      activity?.dispose();
      await harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const connectionId = new URL(request.url).searchParams.get("_pk") || crypto.randomUUID();

    this.ctx.acceptWebSocket(server);
    setConnectionState(server, { username: usernameForConnection(connectionId, request) });
    try {
      await this.#connect(server);
    } catch (error) {
      reportError("Session WebSocket connection failed", error);
      try {
        server.close(1011, "Session setup failed");
      } catch {
        // The accepted socket may already have closed while setup was running.
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  override async alarm(): Promise<void> {
    await this.#refreshAlarm();
  }

  override async webSocketMessage(socket: WebSocket, message: WSMessage): Promise<void> {
    try {
      await this.#connectionOperations.run(socket, () => this.#processMessage(socket, message));
    } catch (error) {
      reportError("Session WebSocket message failed", error);
    }
  }

  async #processMessage(socket: WebSocket, message: WSMessage): Promise<void> {
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

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    try {
      await this.#connectionOperations.run(socket, async () => {
        this.#setTyping(socket, false);
        await this.#stopEventStream(socket);
      });
    } catch (error) {
      reportError("Session WebSocket close failed", error);
    } finally {
      reciprocateClose(socket, code, reason);
    }
  }

  override async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    try {
      await this.#connectionOperations.run(socket, async () => {
        reportError("Session WebSocket failed", error);
        this.#setTyping(socket, false);
        await this.#stopEventStream(socket);
      });
    } catch (handlerError) {
      reportError("Session WebSocket error cleanup failed", handlerError);
    }
  }

  async #connect(server: WebSocket): Promise<void> {
    const root = await this.#harness.root(BACKGROUND_CONTEXT);
    await this.#sendSessionSnapshot(server);
    await this.#watchConversation(server, root.id);
  }

  async #handleCommand(socket: WebSocket, command: ClientCommand): Promise<void> {
    switch (command.type) {
      case "presence.typing":
        if (connectionState(socket)?.conversationId === command.conversationId) {
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
          const doc = await tx.doc(ConversationCommandReceipts, command.requestId, null);
          const existing = doc.receipt;
          if (existing !== undefined) {
            if (existing.command !== command.type) {
              throw new Error(
                `Request ${command.requestId} was already used for ${existing.command}`,
              );
            }
            return existing.conversationId;
          }
          const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
          doc.receipt = {
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
          const doc = await tx.doc(ConversationCommandReceipts, command.requestId, null);
          const existing = doc.receipt;
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
          doc.receipt = {
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
            content: attributedPrompt(
              connectionState(socket)?.username ?? "Guest",
              command.content,
            ),
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

  async #sendSessionSnapshot(socket: WebSocket): Promise<void> {
    this.#send(socket, {
      type: "session.snapshot",
      session: { conversations: await this.#sessionSnapshot(), activity: this.#activity.value },
    });
  }

  async #broadcastSessionSnapshot(): Promise<void> {
    this.#broadcast({
      type: "session.snapshot",
      session: { conversations: await this.#sessionSnapshot(), activity: this.#activity.value },
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
    socket: WebSocket,
    conversationId: ConversationId,
    restoreTyping = false,
  ): Promise<void> {
    this.#setTyping(socket, false);
    await this.#stopEventStream(socket);
    const username = connectionState(socket)?.username ?? "Guest";
    setConnectionState(socket, { username });
    const stream = await watchEvents(this.#harness, conversationId, BACKGROUND_CONTEXT);
    this.#eventStreams.set(socket, stream);
    setConnectionState(socket, {
      username,
      conversationId,
      ...(restoreTyping ? { typing: true } : {}),
    });
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
  async #sendInbox(socket: WebSocket, conversationId: ConversationId): Promise<void> {
    const inbox = await this.#harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT);
    this.#send(socket, { type: "conversation.inbox", conversationId, items: queuedInputs(inbox) });
  }

  async #stopEventStream(socket: WebSocket): Promise<void> {
    const stream = this.#eventStreams.get(socket);
    if (stream === undefined) return;
    this.#eventStreams.delete(socket);
    await stream.stop();
  }

  async #restoreEventStreams(): Promise<void> {
    for (const socket of this.#connections()) {
      const attachment = connectionState(socket);
      if (attachment?.conversationId !== undefined) {
        const conversationId = attachment.conversationId as ConversationId;
        await this.#watchConversation(socket, conversationId, attachment.typing === true);
      }
    }
  }

  #connections(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.READY_STATE_OPEN);
  }

  #broadcast(event: ServerEvent): void {
    const message = JSON.stringify(event);
    for (const socket of this.#connections()) this.#sendMessage(socket, message);
  }

  #send(socket: WebSocket, event: ServerEvent): void {
    this.#sendMessage(socket, JSON.stringify(event));
  }

  #sendMessage(socket: WebSocket, message: string): void {
    if (socket.readyState !== WebSocket.READY_STATE_OPEN) return;
    try {
      socket.send(message);
    } catch {
      try {
        socket.close(1011, "Unexpected send error");
      } catch {
        // The socket may already have closed after the ready-state check.
      }
    }
  }

  #setTyping(socket: WebSocket, typing: boolean): void {
    const state = connectionState(socket);
    if (state === null || state.conversationId === undefined) return;
    const conversationId = state.conversationId;
    const changed = typing
      ? !this.#typingConnections.has(socket)
      : this.#typingConnections.delete(socket);
    if (typing) this.#typingConnections.add(socket);
    if (socket.readyState === WebSocket.READY_STATE_OPEN) {
      setConnectionState(socket, {
        username: state.username,
        conversationId,
        ...(typing ? { typing: true } : {}),
      });
    }
    if (changed) this.#broadcastTyping(conversationId as ConversationId);
  }

  #broadcastTyping(conversationId: ConversationId): void {
    const connections = this.#connections().filter(
      (connection) => connectionState(connection)?.conversationId === conversationId,
    );
    const typers = connections.filter((connection) => this.#typingConnections.has(connection));
    for (const receiver of connections) {
      const usernames = [
        ...new Set(
          typers
            .filter((connection) => connection !== receiver)
            .map((connection) => connectionState(connection)?.username)
            .filter((username): username is string => username !== undefined),
        ),
      ].sort((left, right) => left.localeCompare(right));
      this.#send(receiver, { type: "presence.typing", conversationId, usernames });
    }
  }

  #refreshAlarm(): Promise<void> {
    return this.#serializeAlarmUpdate(async () => {
      const { tasks } = await this.#harness.inspect(BACKGROUND_CONTEXT);
      const now = Date.now();
      let nextAlarm: number | undefined;
      const tasksToResume: TaskId[] = [];

      for (const task of tasks) {
        if (task.state.kind === "blocked") continue;
        const scheduled = scheduledDeadline(task);
        const waitsForFuture =
          scheduled !== undefined && scheduled > now && !task.record.abortRequested;
        const deadline = waitsForFuture ? scheduled : now + RECOVERY_ALARM_DELAY_MS;
        nextAlarm = nextAlarm === undefined ? deadline : Math.min(nextAlarm, deadline);
        if (!waitsForFuture) tasksToResume.push(task.record.id);
      }

      await this.#replaceAlarm(nextAlarm);
      // waitForTask starts the scheduler, so persist its recovery alarm first.
      for (const taskId of tasksToResume) this.#refreshAlarmWhenTaskSettles(taskId);
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
