import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  parseServerEventEnvelope,
  ROOT_CONVERSATION_ID,
  type ClientCommand,
  type ConnectionStatus,
  type ConversationSummary,
} from "../protocol.ts";
import { initialSessionState, sessionReducer, type ConversationSnapshot } from "./session-state.ts";

const socketUrl = (sessionId: string): string => {
  const url = new URL(
    `/api/sessions/${encodeURIComponent(sessionId)}/connect`,
    window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
};

interface PendingPrompt {
  readonly requestId: string;
  readonly resolve: (accepted: boolean) => void;
}

export interface PiSession {
  readonly status: ConnectionStatus;
  readonly conversations: readonly ConversationSummary[];
  readonly activeConversationId: number | undefined;
  readonly activeConversation: ConversationSnapshot | undefined;
  readonly error: string | undefined;
  openConversation(conversationId: number): void;
  createConversation(): void;
  forkConversation(conversationId: number, entryId: number): void;
  submitPrompt(conversationId: number, content: string): Promise<boolean>;
}

export function usePiSession(sessionId: string, initialConversationId?: number): PiSession {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingPromptRef = useRef<PendingPrompt | null>(null);

  useEffect(() => {
    let disposed = false;
    let initialConversationOpened = false;
    let failureMessage = "Connection closed. Reload this page to continue.";
    const socket = new WebSocket(socketUrl(sessionId));
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      dispatch({ type: "connection", status: "connected" });
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        failureMessage = "Server sent a binary protocol frame. Reload this page to continue.";
        socket.close(1002, "Binary protocol frame");
        return;
      }

      let parsed;
      try {
        parsed = parseServerEventEnvelope(event.data);
      } catch (error) {
        console.error("Invalid session protocol frame", error);
        failureMessage = "Server sent an invalid protocol frame. Reload this page to continue.";
        socket.close(1002, "Invalid protocol frame");
        return;
      }

      dispatch({ type: "event", event: parsed });
      if (parsed.type === "session.snapshot" && !initialConversationOpened) {
        initialConversationOpened = true;
        if (
          initialConversationId !== undefined &&
          initialConversationId !== ROOT_CONVERSATION_ID &&
          parsed.session.conversations.some(({ id }) => id === initialConversationId)
        ) {
          dispatch({ type: "select", conversationId: initialConversationId });
          socket.send(
            JSON.stringify({
              type: "conversation.open",
              requestId: crypto.randomUUID(),
              conversationId: initialConversationId,
            } satisfies ClientCommand),
          );
        }
      }
      if (parsed.type === "command.result" && parsed.command === "prompt.submit") {
        const pending = pendingPromptRef.current;
        if (pending?.requestId === parsed.requestId) {
          pendingPromptRef.current = null;
          pending.resolve(parsed.ok);
        }
      }
    });
    socket.addEventListener("error", () => {
      failureMessage = "Connection failed. Reload this page to continue.";
    });
    socket.addEventListener("close", () => {
      if (socketRef.current === socket) socketRef.current = null;
      const pending = pendingPromptRef.current;
      pendingPromptRef.current = null;
      pending?.resolve(false);
      if (disposed) return;
      dispatch({ type: "connection", status: "failed" });
      dispatch({ type: "error", message: failureMessage });
    });

    return () => {
      disposed = true;
      const pending = pendingPromptRef.current;
      pendingPromptRef.current = null;
      pending?.resolve(false);
      socket.close(1000, "Session view closed");
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [initialConversationId, sessionId]);

  const send = useCallback((command: ClientCommand): boolean => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      dispatch({ type: "error", message: "The session is not connected" });
      return false;
    }
    dispatch({ type: "clear-error" });
    socket.send(JSON.stringify(command));
    return true;
  }, []);

  const openConversation = useCallback(
    (conversationId: number) => {
      dispatch({ type: "select", conversationId });
      send({ type: "conversation.open", requestId: crypto.randomUUID(), conversationId });
    },
    [send],
  );

  const createConversation = useCallback(() => {
    send({ type: "conversation.create", requestId: crypto.randomUUID() });
  }, [send]);

  const forkConversation = useCallback(
    (conversationId: number, entryId: number) => {
      send({
        type: "conversation.fork",
        requestId: crypto.randomUUID(),
        conversationId,
        entryId,
      });
    },
    [send],
  );

  const submitPrompt = useCallback(
    (conversationId: number, content: string): Promise<boolean> => {
      if (pendingPromptRef.current !== null) {
        throw new Error("A prompt submission is already pending");
      }
      const requestId = crypto.randomUUID();
      return new Promise((resolve) => {
        pendingPromptRef.current = { requestId, resolve };
        if (!send({ type: "prompt.submit", requestId, conversationId, content })) {
          pendingPromptRef.current = null;
          resolve(false);
        }
      });
    },
    [send],
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
    error: state.error,
    openConversation,
    createConversation,
    forkConversation,
    submitPrompt,
  };
}
