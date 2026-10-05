import { useCallback, useEffect, useReducer, useRef } from "react";
import type { TaskGraph } from "@earendil-works/pi-durable";
import PartySocket from "partysocket";
import {
  MAX_PROMPT_CHARACTERS,
  parseServerEventEnvelope,
  ROOT_CONVERSATION_ID,
  type ClientCommand,
  type ConnectionStatus,
  type ConversationSummary,
} from "../protocol.ts";
import { CommandOutbox, type RetriableCommand } from "./command-outbox.ts";
import { initialSessionState, sessionReducer, type ConversationSnapshot } from "./session-state.ts";

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
  }, [outbox, sessionId, username]);

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
  };
}
