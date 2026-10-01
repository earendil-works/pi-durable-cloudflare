import {
  type KeyboardEvent,
  type MouseEvent,
  type SubmitEvent,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  MAX_PROMPT_CHARACTERS,
  type ConversationSummary,
  ROOT_CONVERSATION_ID,
} from "../protocol.ts";
import type { ConversationSnapshot } from "./session-state.ts";
import { MessageText, TranscriptList } from "./Transcript.tsx";
import { usePiSession } from "./usePiSession.ts";

interface ChatSessionProps {
  readonly sessionId: string;
  readonly username: string;
}

const conversationLabel = ({ id, parent, owner }: ConversationSummary): string => {
  if (id === ROOT_CONVERSATION_ID) return `Main conversation (id: ${id})`;
  if (owner !== undefined) return `Subagent (id: ${id}, owner: ${owner.conversationId})`;
  if (parent !== undefined) return `Fork (id: ${id}, from: ${parent.at})`;
  return `Conversation (id: ${id})`;
};

const statusLabel = {
  connecting: "Connecting",
  connected: "Connected",
  failed: "Connection failed",
} as const;

const TYPING_IDLE_MS = 1_500;

const typingLabel = (usernames: readonly string[]): string => {
  if (usernames.length === 1) return `${usernames[0]} is typing…`;
  if (usernames.length === 2) return `${usernames[0]}, ${usernames[1]} are typing…`;
  return usernames.length > 2 ? "Many are typing…" : "";
};

const conversationIdFromLocation = (): number | undefined => {
  const value = new URLSearchParams(window.location.search).get("conversation");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

export function ChatSession({ sessionId, username }: ChatSessionProps) {
  const [initialConversationId] = useState(conversationIdFromLocation);
  const session = usePiSession(sessionId, username, initialConversationId);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const transcriptRef = useRef<HTMLElement | null>(null);
  const pinToLatestRef = useRef(true);
  const renderedConversationRef = useRef<number | undefined>(undefined);
  const transcriptHeightRef = useRef(0);
  const autoScrollingRef = useRef(false);
  const autoScrollFrameRef = useRef<number | undefined>(undefined);
  const autoScrollStartRef = useRef(0);
  const autoScrollTargetRef = useRef(0);
  const autoScrollStartedAtRef = useRef(0);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typingConversationRef = useRef<number | undefined>(undefined);
  const activeConversationId = session.activeConversationId;
  const activeConversation = session.activeConversation;
  const activeSummary = session.conversations.find(({ id }) => id === activeConversationId);
  const isConnected = session.status === "connected";
  const canSubmit =
    isConnected && activeConversationId !== undefined && !submitting && draft.trim().length > 0;

  const stopTyping = (): void => {
    if (typingTimeoutRef.current !== undefined) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = undefined;
    const conversationId = typingConversationRef.current;
    typingConversationRef.current = undefined;
    if (conversationId !== undefined) session.setTyping(conversationId, false);
  };

  const updateDraft = (content: string): void => {
    setDraft(content);
    if (!isConnected || activeConversationId === undefined || content.length === 0) {
      stopTyping();
      return;
    }
    if (typingConversationRef.current !== activeConversationId) {
      stopTyping();
      typingConversationRef.current = activeConversationId;
      session.setTyping(activeConversationId, true);
    }
    if (typingTimeoutRef.current !== undefined) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  };

  const stopAutoScroll = (): void => {
    if (autoScrollFrameRef.current !== undefined) cancelAnimationFrame(autoScrollFrameRef.current);
    autoScrollFrameRef.current = undefined;
    autoScrollingRef.current = false;
  };

  const followLatest = (transcript: HTMLElement): void => {
    const target = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
    if (Math.abs(target - transcript.scrollTop) <= 1) {
      transcript.scrollTop = target;
      stopAutoScroll();
      return;
    }
    autoScrollStartRef.current = transcript.scrollTop;
    autoScrollTargetRef.current = target;
    autoScrollStartedAtRef.current = performance.now();
    if (autoScrollFrameRef.current !== undefined) return;
    autoScrollingRef.current = true;
    const step = (time: number): void => {
      const elapsed = time - autoScrollStartedAtRef.current;
      const progress = Math.min(elapsed / 180, 1);
      const eased = progress * progress * (3 - 2 * progress);
      const start = autoScrollStartRef.current;
      const target = autoScrollTargetRef.current;
      transcript.scrollTop = start + (target - start) * eased;
      if (progress >= 1 || Math.abs(target - transcript.scrollTop) <= 1) {
        transcript.scrollTop = target;
        autoScrollFrameRef.current = undefined;
        autoScrollingRef.current = false;
        return;
      }
      autoScrollFrameRef.current = requestAnimationFrame(step);
    };
    autoScrollFrameRef.current = requestAnimationFrame(step);
  };

  useEffect(() => () => stopTyping(), [activeConversationId, isConnected]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript === null) return;

    const conversationChanged = renderedConversationRef.current !== activeConversationId;
    const previousHeight = transcriptHeightRef.current;
    transcriptHeightRef.current = transcript.scrollHeight;
    if (conversationChanged) {
      renderedConversationRef.current = activeConversationId;
      pinToLatestRef.current = true;
      stopAutoScroll();
      transcript.scrollTop = transcript.scrollHeight;
      return;
    }
    if (!pinToLatestRef.current || transcript.scrollHeight === previousHeight) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      stopAutoScroll();
      transcript.scrollTop = transcript.scrollHeight;
      return;
    }

    followLatest(transcript);
  });

  useEffect(() => () => stopAutoScroll(), []);

  const openLinkedConversation = useEffectEvent(() => {
    const conversationId = conversationIdFromLocation() ?? ROOT_CONVERSATION_ID;
    if (
      conversationId !== activeConversationId &&
      session.conversations.some(({ id }) => id === conversationId)
    ) {
      session.openConversation(conversationId);
    }
  });

  useEffect(() => {
    const handlePopState = (): void => openLinkedConversation();
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const submit = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const content = draft.trim();
    if (content.length === 0 || activeConversationId === undefined || !isConnected || submitting) {
      return;
    }
    stopTyping();
    setSubmitting(true);
    try {
      const accepted = await session.submitPrompt(activeConversationId, content);
      if (accepted) setDraft((current) => (current === draft ? "" : current));
    } finally {
      setSubmitting(false);
    }
  };

  const trackTranscriptPosition = (): void => {
    const transcript = transcriptRef.current;
    if (transcript === null || autoScrollingRef.current) return;
    const distanceFromLatest =
      transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
    pinToLatestRef.current = distanceFromLatest <= 48;
  };

  const interruptAutoScroll = (): void => {
    if (autoScrollingRef.current) stopAutoScroll();
  };

  const submitWithKeyboardShortcut = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key !== "Enter" ||
      (!event.metaKey && !event.ctrlKey) ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const followConversationLink = (
    event: MouseEvent<HTMLAnchorElement>,
    conversationId: number,
  ): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    if (conversationId !== session.activeConversationId) {
      window.history.pushState(null, "", event.currentTarget.href);
      session.openConversation(conversationId);
    }
  };

  return (
    <div className="session-workspace">
      <aside className="session-sidebar">
        <header className="session-header">
          <a className="product-link" href="/">
            pi-durable
          </a>
          <h1>Session</h1>
          <p className="participant-name">
            Joining as <strong>{username}</strong>
          </p>
          <p className="connection-status" role="status">
            {statusLabel[session.status]}
          </p>
        </header>

        {session.error === undefined ? null : (
          <p className="session-error" role="alert">
            {session.error}
          </p>
        )}

        <nav className="conversation-navigation" aria-labelledby="conversations-heading">
          <div className="conversation-navigation-header">
            <h2 id="conversations-heading">Conversations</h2>
            <button type="button" onClick={session.createConversation} disabled={!isConnected}>
              New conversation
            </button>
          </div>
          <div className="conversation-list" tabIndex={0}>
            {session.conversations.length === 0 ? (
              <p className="conversation-list-empty">No conversations yet.</p>
            ) : (
              <ul>
                {session.conversations.map((conversation) => (
                  <li key={conversation.id}>
                    <a
                      href={`?conversation=${conversation.id}`}
                      aria-current={conversation.id === activeConversationId ? "page" : undefined}
                      onClick={(event) => followConversationLink(event, conversation.id)}
                    >
                      {conversationLabel(conversation)}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </nav>
      </aside>

      <main className="conversation-view">
        <header className="conversation-header">
          <h2 id="transcript-heading">
            {activeSummary === undefined ? "Conversation" : conversationLabel(activeSummary)}
          </h2>
          {activeConversation === undefined ? null : (
            <ConversationDetails conversation={activeConversation} />
          )}
        </header>

        <section
          ref={transcriptRef}
          className="transcript"
          aria-labelledby="transcript-heading"
          role="log"
          tabIndex={0}
          onScroll={trackTranscriptPosition}
          onWheel={interruptAutoScroll}
          onTouchStart={interruptAutoScroll}
          onPointerDown={interruptAutoScroll}
        >
          {activeConversation === undefined ? (
            <p className="transcript-empty">Loading conversation…</p>
          ) : activeConversation.entries.length === 0 && activeConversation.live === null ? (
            <p className="transcript-empty">
              Send a message to begin. You can fork the conversation from any user or assistant
              message.
            </p>
          ) : (
            <TranscriptList
              entries={activeConversation.entries}
              tools={activeConversation.tools}
              runActive={activeConversation.live !== null}
              onFork={
                activeConversationId === undefined
                  ? undefined
                  : (entryId) => session.forkConversation(activeConversationId, entryId)
              }
            />
          )}

          {activeConversation?.live === null || activeConversation?.live === undefined ? null : (
            <article
              className="transcript-message transcript-message--assistant transcript-message--live"
              aria-busy={activeConversation.live.active}
            >
              <header>
                <div className="transcript-message-title">
                  <strong>Assistant</strong>
                </div>
                <button
                  className="text-button transcript-fork transcript-fork--placeholder"
                  type="button"
                  aria-hidden="true"
                  tabIndex={-1}
                  disabled
                >
                  Fork
                </button>
              </header>
              {activeConversation.live.text.length === 0 ? (
                <p className="responding">Responding…</p>
              ) : (
                <MessageText text={activeConversation.live.text} />
              )}
              {activeConversation.live.retry === undefined ? null : (
                <p role="status">Retrying: {activeConversation.live.retry.error}</p>
              )}
            </article>
          )}

          {activeConversation === undefined ||
          activeConversation.compactions.length === 0 ? null : (
            <p className="compaction-status" role="status">
              {compactionStatusText(activeConversation.compactions)}
            </p>
          )}

          {activeConversation?.failure === undefined ? null : (
            <p className="transcript-error" role="alert">
              {activeConversation.failure.kind} failed: {activeConversation.failure.message}
            </p>
          )}

          {activeConversation === undefined || activeConversation.queued.length === 0 ? null : (
            <ol className="transcript-list queued-inputs" aria-label="Queued messages">
              {activeConversation.queued.map((input) => (
                <li key={input.submissionId}>
                  <article className="transcript-message transcript-message--user transcript-message--queued">
                    <header>
                      <div className="transcript-message-title">
                        <strong>User</strong>
                        <span>Queued</span>
                      </div>
                    </header>
                    <MessageText text={input.text} />
                  </article>
                </li>
              ))}
            </ol>
          )}
        </section>

        <form className="prompt-bar" onSubmit={submit}>
          <label className="visually-hidden" htmlFor="prompt">
            Message
          </label>
          <textarea
            id="prompt"
            name="prompt"
            rows={3}
            maxLength={MAX_PROMPT_CHARACTERS}
            value={draft}
            placeholder="Send a message…"
            onChange={(event) => updateDraft(event.currentTarget.value)}
            onKeyDown={submitWithKeyboardShortcut}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            disabled={!isConnected || activeConversationId === undefined}
          />
          <button type="submit" disabled={!canSubmit}>
            {submitting ? "Sending…" : "Send"}
          </button>
          <p className="typing-indicator" aria-live="polite">
            {typingLabel(activeConversation?.typing ?? [])}
          </p>
        </form>
      </main>
    </div>
  );
}

function ConversationDetails({ conversation }: { readonly conversation: ConversationSnapshot }) {
  const agent = conversation.agent;
  const totals = usageTotals(conversation.usage);
  const model =
    agent?.model === undefined
      ? "Provider default"
      : `${agent.model.provider}/${agent.model.modelId}`;
  const tools =
    agent?.tools === undefined
      ? "Host default"
      : Array.isArray(agent.tools)
        ? agent.tools.length === 0
          ? "None"
          : agent.tools.join(", ")
        : `Host default except ${agent.tools.remove.join(", ")}`;

  return (
    <section className="runtime-information" aria-label="Runtime information">
      <dl>
        <div className="runtime-primary">
          <RuntimeDatum label="Model" value={model} />
          <RuntimeDatum label="Thinking" value={agent?.thinkingLevel ?? "off"} />
          <RuntimeDatum label="Tokens" value={totals.tokens.toLocaleString()} />
          <RuntimeDatum label="Cost" value={formatCost(totals.cost)} />
        </div>
        <div className="runtime-tools">
          <dt>Tools:</dt>
          <dd>{tools}</dd>
        </div>
      </dl>
    </section>
  );
}

function RuntimeDatum({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}:</dt>
      <dd>{value}</dd>
    </div>
  );
}

function usageTotals(usage: ConversationSnapshot["usage"]): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) {
    for (const value of Object.values(bucket)) {
      tokens += value.totalTokens;
      cost += value.cost.total;
    }
  }
  return { tokens, cost };
}

const costFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const formatCost = (cost: number): string => costFormatter.format(cost);

function compactionStatusText(compactions: ConversationSnapshot["compactions"]): string {
  return compactions.some(({ blocking }) => blocking)
    ? "Compacting context before responding…"
    : "Compacting context in the background…";
}
