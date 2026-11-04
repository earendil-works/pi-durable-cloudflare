import { useCallback, useEffect, useReducer, useRef } from "react";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import {
  ConversationTranscript,
  type ConversationView,
  type Cursor,
  type EntryRecord,
  type Page,
  type TaskGraph,
} from "@earendil-works/pi-durable";
import PartySocket from "partysocket";
import {
  MAX_ENTRY_PAGE,
  MAX_PROMPT_CHARACTERS,
  parseServerEventEnvelope,
  ROOT_CONVERSATION_ID,
  type ClientCommand,
  type ConnectionStatus,
  type ConversationSummary,
} from "../protocol.ts";
import { CommandOutbox, type RetriableCommand } from "./command-outbox.ts";
import {
  initialSessionState,
  sessionReducer,
  type ConversationSnapshot,
  type TranscriptGap,
} from "./session-state.ts";

type EntryPage = Page<EntryRecord, Cursor>;

/** A `conversation.entries` command waiting for its result. */
type PendingPage = {
  readonly resolve: (page: EntryPage) => void;
  readonly reject: (error: Error) => void;
};

const terminalProtocolClose = (code: number): boolean => code === 1002 || code === 1009;

export interface PiSession {
  readonly status: ConnectionStatus;
  readonly conversations: readonly ConversationSummary[];
  readonly activeConversationId: number | undefined;
  readonly activeConversation: ConversationSnapshot | undefined;
  readonly activity: TaskGraph | undefined;
  readonly error: string | undefined;
  openConversation(conversationId: number): void;
  createConversation(): void;
  forkConversation(conversationId: number, entryId: number): void;
  setTyping(conversationId: number, typing: boolean): void;
  submitPrompt(conversationId: number, content: string): Promise<boolean>;
  /** Loads the page of the transcript before the oldest entry loaded. */
  loadEarlier(conversationId: number): void;
  /** Loads the next page of entries missing in `gap`. */
  fillGap(conversationId: number, gap: TranscriptGap): void;
}

export function usePiSession(
  sessionId: string,
  username: string,
  initialConversationId?: number,
): PiSession {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const socketRef = useRef<PartySocket | null>(null);
  const outboxRef = useRef<CommandOutbox | null>(null);
  outboxRef.current ??= new CommandOutbox();
  const outbox = outboxRef.current;
  const selectedConversationRef = useRef(initialConversationId ?? ROOT_CONVERSATION_ID);
  // A conversation's view as last received, to apply operations to, and the transcript the client holds, which keeps
  // entries that left the view's window and pages in older ones.
  const viewsRef = useRef(new Map<number, ConversationView>());
  const transcriptsRef = useRef(new Map<number, ConversationTranscript>());
  const pagesRef = useRef(new Map<string, PendingPage>());

  const requestPage = useCallback(
    (
      conversationId: number,
      query: { minEntryId?: number; maxEntryId?: number; order?: "ascending" | "descending" },
      limit: number,
    ): Promise<EntryPage> => {
      const socket = socketRef.current;
      if (socket === null || socket.readyState !== socket.OPEN) {
        return Promise.reject(new Error("The session is not connected"));
      }
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        pagesRef.current.set(requestId, { resolve, reject });
        socket.send(
          JSON.stringify({
            type: "conversation.entries",
            requestId,
            conversationId,
            ...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
            ...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
            order: query.order ?? "descending",
            limit: Math.min(limit, MAX_ENTRY_PAGE),
          } satisfies ClientCommand),
        );
      });
    },
    [],
  );

  const transcriptFor = useCallback(
    (conversationId: number): ConversationTranscript => {
      let transcript = transcriptsRef.current.get(conversationId);
      if (transcript === undefined) {
        transcript = new ConversationTranscript((query, limit) =>
          requestPage(conversationId, query, limit),
        );
        transcriptsRef.current.set(conversationId, transcript);
      }
      return transcript;
    },
    [requestPage],
  );

  const showView = useCallback(
    (conversationId: number, view: ConversationView) => {
      viewsRef.current.set(conversationId, view);
      dispatch({ type: "view", conversationId, view: transcriptFor(conversationId).merge(view) });
    },
    [transcriptFor],
  );

  useEffect(() => {
    let disposed = false;
    let terminal = false;
    let conversationOpened = false;
    let failureMessage = "The session connection failed.";
    const socket = new PartySocket({
      host: window.location.host,
      party: "sessions",
      prefix: "api",
      room: sessionId,
      query: { username },
      maxEnqueuedMessages: 16,
      shouldReconnectOnClose: (event) => !terminal && !terminalProtocolClose(event.code),
    });
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      conversationOpened = false;
      dispatch({ type: "connection", status: "connected" });
      dispatch({ type: "clear-error" });
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        terminal = true;
        failureMessage = "Server sent a binary protocol frame.";
        socket.close(1002, "Binary protocol frame");
        return;
      }

      let parsed;
      try {
        parsed = parseServerEventEnvelope(event.data);
      } catch (error) {
        console.error("Invalid session protocol frame", error);
        terminal = true;
        failureMessage = "Server sent an invalid protocol frame.";
        socket.close(1002, "Invalid protocol frame");
        return;
      }

      if (parsed.type === "conversation.view") {
        showView(parsed.conversationId, parsed.view);
        return;
      }
      if (parsed.type === "conversation.ops") {
        const view = viewsRef.current.get(parsed.conversationId);
        if (view !== undefined) showView(parsed.conversationId, applyImmutable(view, parsed.ops));
        return;
      }
      if (parsed.type === "command.result" && parsed.command === "conversation.entries") {
        const pending = pagesRef.current.get(parsed.requestId);
        pagesRef.current.delete(parsed.requestId);
        if (parsed.ok)
          pending?.resolve({ items: parsed.page?.items ?? [], next: parsed.page?.next });
        else pending?.reject(new Error(parsed.error.message));
        return;
      }

      if (
        parsed.type === "error" &&
        (parsed.error.code === "invalid_message" ||
          parsed.error.code === "invalid_command" ||
          parsed.error.code === "frame_too_large")
      ) {
        terminal = true;
        failureMessage = parsed.error.message;
      }
      dispatch({ type: "event", event: parsed });
      if (parsed.type === "session.snapshot" && !conversationOpened) {
        conversationOpened = true;
        const desiredConversationId = selectedConversationRef.current;
        const selectedStillExists = parsed.session.conversations.some(
          ({ id }) => id === desiredConversationId,
        );
        const conversationId = selectedStillExists
          ? desiredConversationId
          : (parsed.session.conversations.find(({ id }) => id === ROOT_CONVERSATION_ID)?.id ??
            parsed.session.conversations[0]?.id);
        if (conversationId !== undefined) {
          selectedConversationRef.current = conversationId;
          if (conversationId !== ROOT_CONVERSATION_ID) {
            dispatch({ type: "select", conversationId });
            socket.send(
              JSON.stringify({
                type: "conversation.open",
                requestId: crypto.randomUUID(),
                conversationId,
              } satisfies ClientCommand),
            );
          }
        }
        // Restore the previous watch first. Replayed create/fork commands then leave the server
        // watching the newest acknowledged conversation rather than the pre-disconnect one.
        outbox.replay((command) => socket.send(JSON.stringify(command)));
      }
      if (parsed.type === "command.result") {
        const acknowledged = outbox.acknowledge(parsed);
        if (
          acknowledged !== undefined &&
          parsed.ok &&
          parsed.conversationId !== undefined &&
          (acknowledged.type === "conversation.create" || acknowledged.type === "conversation.fork")
        ) {
          selectedConversationRef.current = parsed.conversationId;
        }
      }
    });
    socket.addEventListener("error", () => {
      if (!terminal) dispatch({ type: "connection", status: "connecting" });
    });
    socket.addEventListener("close", (event) => {
      for (const pending of pagesRef.current.values()) {
        pending.reject(new Error("The session connection closed"));
      }
      pagesRef.current.clear();
      if (disposed) return;
      if (terminalProtocolClose(event.code)) {
        terminal = true;
        if (failureMessage === "The session connection failed." && event.reason.length > 0) {
          failureMessage = event.reason;
        }
      }
      if (terminal) {
        if (socketRef.current === socket) socketRef.current = null;
        outbox.clear();
        dispatch({ type: "connection", status: "failed" });
        dispatch({ type: "error", message: failureMessage });
      } else {
        dispatch({ type: "connection", status: "connecting" });
      }
    });

    return () => {
      disposed = true;
      outbox.clear();
      socket.close(1000, "Session view closed");
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [outbox, sessionId, username, showView]);

  const send = useCallback((command: ClientCommand): boolean => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== socket.OPEN) {
      dispatch({ type: "error", message: "The session is not connected" });
      return false;
    }
    dispatch({ type: "clear-error" });
    socket.send(JSON.stringify(command));
    return true;
  }, []);

  const sendRetriable = useCallback(
    (command: RetriableCommand, complete?: (accepted: boolean) => void): boolean => {
      outbox.enqueue(command, complete);
      if (send(command)) return true;
      outbox.cancel(command.requestId);
      return false;
    },
    [outbox, send],
  );

  const openConversation = useCallback(
    (conversationId: number) => {
      selectedConversationRef.current = conversationId;
      dispatch({ type: "select", conversationId });
      send({ type: "conversation.open", requestId: crypto.randomUUID(), conversationId });
    },
    [send],
  );

  const createConversation = useCallback(() => {
    sendRetriable({ type: "conversation.create", requestId: crypto.randomUUID() });
  }, [sendRetriable]);

  const forkConversation = useCallback(
    (conversationId: number, entryId: number) => {
      sendRetriable({
        type: "conversation.fork",
        requestId: crypto.randomUUID(),
        conversationId,
        entryId,
      });
    },
    [sendRetriable],
  );

  const setTyping = useCallback((conversationId: number, typing: boolean) => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== socket.OPEN) return;
    socket.send(
      JSON.stringify({ type: "presence.typing", conversationId, typing } satisfies ClientCommand),
    );
  }, []);

  const submitPrompt = useCallback(
    (conversationId: number, content: string): Promise<boolean> => {
      if (content.trim().length === 0) {
        dispatch({ type: "error", message: "A prompt must contain text" });
        return Promise.resolve(false);
      }
      if (content.length > MAX_PROMPT_CHARACTERS) {
        dispatch({
          type: "error",
          message: `A prompt cannot exceed ${MAX_PROMPT_CHARACTERS.toLocaleString()} characters`,
        });
        return Promise.resolve(false);
      }
      if (outbox.has("prompt.submit")) {
        throw new Error("A prompt submission is already pending");
      }
      const command = {
        type: "prompt.submit",
        requestId: crypto.randomUUID(),
        conversationId,
        content,
      } satisfies Extract<ClientCommand, { readonly type: "prompt.submit" }>;
      return new Promise((resolve) => {
        sendRetriable(command, resolve);
      });
    },
    [outbox, sendRetriable],
  );

  const loadEarlier = useCallback((conversationId: number) => {
    const transcript = transcriptsRef.current.get(conversationId);
    if (transcript === undefined) return;
    transcript.loadEarlier(BACKGROUND_CONTEXT).then(
      (view) => dispatch({ type: "view", conversationId, view }),
      (error: Error) => dispatch({ type: "error", message: error.message }),
    );
  }, []);

  const fillGap = useCallback((conversationId: number, gap: TranscriptGap) => {
    const transcript = transcriptsRef.current.get(conversationId);
    if (transcript === undefined) return;
    transcript.fillGap(gap, BACKGROUND_CONTEXT).then(
      (view) => dispatch({ type: "view", conversationId, view }),
      (error: Error) => dispatch({ type: "error", message: error.message }),
    );
  }, []);

  const activeConversation =
    state.activeConversationId === undefined
      ? undefined
      : state.snapshots[state.activeConversationId];

  return {
    status: state.status,
    conversations: state.conversations,
    activeConversationId: state.activeConversationId,
    activeConversation,
    activity: state.activity,
    error: state.error,
    openConversation,
    createConversation,
    forkConversation,
    setTyping,
    submitPrompt,
    loadEarlier,
    fillGap,
  };
}
