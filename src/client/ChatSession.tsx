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
import { type ConversationSummary, ROOT_CONVERSATION_ID } from "../protocol.ts";
import type { ToolDiagnostic } from "@earendil-works/pi-durable";
import type { ConversationSnapshot, ToolProgress, TranscriptEntry } from "./session-state.ts";
import { usePiSession } from "./usePiSession.ts";

interface ChatSessionProps {
  readonly sessionId: string;
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

const conversationIdFromLocation = (): number | undefined => {
  const value = new URLSearchParams(window.location.search).get("conversation");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

export function ChatSession({ sessionId }: ChatSessionProps) {
  const [initialConversationId] = useState(conversationIdFromLocation);
  const session = usePiSession(sessionId, initialConversationId);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const transcriptRef = useRef<HTMLElement | null>(null);
  const pinToLatestRef = useRef(true);
  const renderedConversationRef = useRef<number | undefined>(undefined);
  const activeConversationId = session.activeConversationId;
  const activeConversation = session.activeConversation;
  const activeSummary = session.conversations.find(({ id }) => id === activeConversationId);
  const isConnected = session.status === "connected";
  const canSubmit =
    isConnected && activeConversationId !== undefined && !submitting && draft.trim().length > 0;

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript === null) return;

    if (renderedConversationRef.current !== activeConversationId) {
      renderedConversationRef.current = activeConversationId;
      pinToLatestRef.current = true;
    }
    if (pinToLatestRef.current) transcript.scrollTop = transcript.scrollHeight;
  });

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
    if (transcript === null) return;
    const distanceFromLatest =
      transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
    pinToLatestRef.current = distanceFromLatest <= 48;
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
        >
          {activeConversation === undefined ? (
            <p className="transcript-empty">Loading conversation…</p>
          ) : activeConversation.entries.length === 0 && activeConversation.live === null ? (
            <p className="transcript-empty">
              This conversation is empty. Send a message to begin. You can fork the conversation
              from any committed user or assistant message.
            </p>
          ) : (
            <ol className="transcript-list">
              {activeConversation.entries.map((entry) => (
                <li key={entry.id}>
                  <TranscriptMessage
                    entry={entry}
                    onFork={
                      activeConversationId === undefined
                        ? undefined
                        : () => session.forkConversation(activeConversationId, entry.id)
                    }
                  />
                </li>
              ))}
            </ol>
          )}

          {activeConversation?.live === null || activeConversation?.live === undefined ? null : (
            <article
              className="transcript-message transcript-message--assistant transcript-message--live"
              aria-busy={activeConversation.live.active}
            >
              <header>
                <strong>Assistant</strong>
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

          {activeConversation === undefined || activeConversation.tools.length === 0 ? null : (
            <ToolActivity tools={activeConversation.tools} />
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
                      <strong>User</strong> <span>Queued</span>
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
            value={draft}
            placeholder="Send a message…"
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={submitWithKeyboardShortcut}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            disabled={!isConnected || activeConversationId === undefined}
          />
          <button type="submit" disabled={!canSubmit}>
            {submitting ? "Sending…" : "Send"}
          </button>
        </form>
      </main>
    </div>
  );
}

function ConversationDetails({ conversation }: { readonly conversation: ConversationSnapshot }) {
  const config = conversation.config;
  const totals = usageTotals(conversation.usage);
  const model =
    config?.model === undefined
      ? "Provider default"
      : `${config.model.provider}/${config.model.modelId}`;
  const tools =
    config === undefined || config.activeTools.length === 0
      ? "None"
      : config.activeTools.join(", ");

  return (
    <section className="runtime-information" aria-label="Runtime information">
      <dl>
        <div className="runtime-primary">
          <RuntimeDatum label="Model" value={model} />
          <RuntimeDatum label="Thinking" value={config?.thinkingLevel ?? "off"} />
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

function ToolActivity({ tools }: { readonly tools: readonly ToolProgress[] }) {
  return (
    <section className="tool-activity" aria-labelledby="tool-activity-heading">
      <h3 id="tool-activity-heading">Tool activity</h3>
      <ol>
        {tools.map((tool) => (
          <li key={tool.callId}>
            <article aria-busy={tool.status === "running"}>
              <header>
                <strong>{tool.name}</strong> <span>{capitalize(tool.status)}</span>
              </header>
              {tool.args === undefined ? null : (
                <details>
                  <summary>Arguments</summary>
                  <pre>{JSON.stringify(tool.args, null, 2)}</pre>
                </details>
              )}
              {tool.output === undefined || tool.output.length === 0 ? null : (
                <pre>{tool.output}</pre>
              )}
              {tool.details === undefined ? null : (
                <details>
                  <summary>Details</summary>
                  <pre>{JSON.stringify(tool.details, null, 2)}</pre>
                </details>
              )}
              {tool.diagnostics === undefined || tool.diagnostics.length === 0 ? null : (
                <Diagnostics diagnostics={tool.diagnostics} />
              )}
            </article>
          </li>
        ))}
      </ol>
    </section>
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

const roleLabel: Record<TranscriptEntry["role"], string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
  tool: "Tool",
  scheduled: "Scheduled",
  compaction: "Context summary",
  reset: "Context reset",
  event: "Event",
};

function TranscriptMessage({
  entry,
  onFork,
}: {
  readonly entry: TranscriptEntry;
  readonly onFork?: () => void;
}) {
  const timestamp = entry.timestamp === undefined ? undefined : new Date(entry.timestamp);

  return (
    <article className={`transcript-message transcript-message--${entry.role}`}>
      <header>
        <strong>{roleLabel[entry.role]}</strong>
        {timestamp === undefined ? null : (
          <time dateTime={timestamp.toISOString()}>{timestamp.toLocaleString()}</time>
        )}
      </header>
      <MessageText text={entry.text} />
      {entry.diagnostics === undefined ? null : <Diagnostics diagnostics={entry.diagnostics} />}
      {!entry.canFork || onFork === undefined ? null : (
        <footer>
          <button className="text-button" type="button" onClick={onFork}>
            Fork from here
          </button>
        </footer>
      )}
    </article>
  );
}

function Diagnostics({ diagnostics }: { readonly diagnostics: readonly ToolDiagnostic[] }) {
  return (
    <ul>
      {diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.code ?? "diagnostic"}-${index}`}>
          <strong>{capitalize(diagnostic.severity)}</strong>: {diagnostic.message}
        </li>
      ))}
    </ul>
  );
}

function MessageText({ text }: { readonly text: string }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </>
  );
}

const capitalize = (value: string): string =>
  value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
