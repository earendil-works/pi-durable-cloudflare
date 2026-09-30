import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AgentEventStream,
  ConversationBusy,
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type EntryId,
  type Harness as PiHarness,
  type TaskId,
  watchEvents,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { planHarnessAlarm } from "./schedule.ts";
import { initializeConversation, openChatHarness } from "./chat.ts";
import {
  InvalidClientCommand,
  MAX_CLIENT_FRAME_CHARACTERS,
  parseClientCommand,
  type ClientCommand,
  type ConversationSummary,
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

type SocketAttachment = { readonly conversationId: number };

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
});

export class Session extends DurableObject<Env> {
  #harness!: PiHarness;
  readonly #eventStreams = new Map<WebSocket, AgentEventStream>();
  readonly #alarmTaskWatches = new Set<TaskId>();
  #watchTaskSettlements = false;
  #alarmUpdate: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const ready = ctx.blockConcurrencyWhile(async () => {
      const storage = await SqliteStorage.open(createCloudflareSqliteDatabase(ctx.storage));
      this.#harness = await openChatHarness(storage, BACKGROUND_CONTEXT, {
        scheduleCreated: () => this.#refreshAlarm(),
      });
      await this.#restoreEventStreams();
      await this.#refreshAlarm();
    });
    void ready
      .then(async () => {
        this.#watchTaskSettlements = true;
        this.#harness.resume();
        await this.#refreshAlarm();
      })
      .catch((error: unknown) => reportError("Harness recovery failed", error));
  }

  override async alarm(): Promise<void> {
    this.#harness.resume();
    await this.#refreshAlarm();
  }

  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (/^\/api\/sessions\/[^/]+\/connect\/?$/.test(pathname)) {
      return this.#connect(request);
    }

    return json({ error: "Not found" }, 404);
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
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
      const code = error instanceof ConversationBusy ? "conversation_busy" : "command_failed";
      if (!(error instanceof ConversationBusy)) {
        reportError("Session command failed", error, { command: command.type });
      }
      this.#send(socket, {
        type: "command.result",
        command: command.type,
        requestId: command.requestId,
        ok: false,
        error: { code, message: error instanceof Error ? error.message : "Command failed" },
      });
    }
  }

  override webSocketClose(socket: WebSocket): Promise<void> {
    return this.#stopEventStream(socket);
  }

  override webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    reportError("Session WebSocket failed", error);
    return this.#stopEventStream(socket);
  }

  async #connect(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected a WebSocket upgrade" }, 426, { Upgrade: "websocket" });
    }

    const root = await this.#harness.root(BACKGROUND_CONTEXT, { init: initializeConversation });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    await this.#sendSessionSnapshot(server);
    await this.#watchConversation(server, root.id);
    return new Response(null, { status: 101, webSocket: client });
  }

  async #handleCommand(socket: WebSocket, command: ClientCommand): Promise<void> {
    switch (command.type) {
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
        const conversation = await this.#harness.createConversation(
          { ownership: { kind: "ownerless" }, init: initializeConversation },
          BACKGROUND_CONTEXT,
        );
        await this.#broadcastSessionSnapshot();
        await this.#watchConversation(socket, conversation.id);
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: conversation.id,
        });
        return;
      }
      case "conversation.fork": {
        const conversation = await this.#requireConversation(
          command.conversationId as ConversationId,
        );
        const fork = await conversation.fork(
          command.entryId as EntryId,
          { ownership: { kind: "ownerless" } },
          BACKGROUND_CONTEXT,
        );
        await this.#broadcastSessionSnapshot();
        await this.#watchConversation(socket, fork.id);
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: fork.id,
        });
        return;
      }
      case "prompt.submit": {
        const conversation = await this.#requireConversation(
          command.conversationId as ConversationId,
        );
        await this.#setAlarmNoLaterThan(Date.now() + RECOVERY_ALARM_DELAY_MS);
        const submission = await conversation.submit(
          {
            type: "input",
            content: command.content,
            requestId: command.requestId,
            whenBusy: "reject",
          },
          BACKGROUND_CONTEXT,
        );
        void submission
          .wait(BACKGROUND_CONTEXT)
          .then(() => this.#refreshAlarm())
          .catch((error: unknown) => reportError("Prompt alarm reconciliation failed", error));
        await this.#refreshAlarm();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: conversation.id,
          submissionId: submission.id,
        });
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

  async #watchConversation(socket: WebSocket, conversationId: ConversationId): Promise<void> {
    await this.#stopEventStream(socket);
    socket.serializeAttachment({});
    const stream = await watchEvents(this.#harness, conversationId, BACKGROUND_CONTEXT);
    this.#eventStreams.set(socket, stream);
    socket.serializeAttachment({ conversationId } satisfies SocketAttachment);
    this.#send(socket, {
      type: "conversation.events",
      conversationId,
      events: [stream.snapshot],
    });
    stream.start(async (events) => {
      if (this.#eventStreams.get(socket) !== stream) return;
      this.#send(socket, { type: "conversation.events", conversationId, events });
    });
    void stream.closed.finally(() => {
      if (this.#eventStreams.get(socket) === stream) this.#eventStreams.delete(socket);
    });
  }

  async #stopEventStream(socket: WebSocket): Promise<void> {
    const stream = this.#eventStreams.get(socket);
    if (stream === undefined) return;
    this.#eventStreams.delete(socket);
    await stream.stop();
  }

  async #restoreEventStreams(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Partial<SocketAttachment> | null;
      if (
        attachment !== null &&
        typeof attachment.conversationId === "number" &&
        Number.isSafeInteger(attachment.conversationId) &&
        attachment.conversationId > 0
      ) {
        await this.#watchConversation(socket, attachment.conversationId as ConversationId);
      }
    }
  }

  #broadcast(event: ServerEvent): void {
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }

  #send(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
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
