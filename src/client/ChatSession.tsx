import { type FormEvent, Fragment, useState } from "react";
import { ROOT_CONVERSATION_ID } from "../protocol.ts";
import type { ConversationSnapshot, ToolProgress, TranscriptEntry } from "./session-state.ts";
import { usePiSession } from "./usePiSession.ts";

interface ChatSessionProps {
  readonly sessionId: string;
}

const conversationLabel = (
  id: number,
  parent: { readonly conversationId: number; readonly at: number } | undefined,
): string => {
  if (id === ROOT_CONVERSATION_ID) return "Main conversation";
  if (parent !== undefined) return `Fork ${id} from message ${parent.at}`;
  return `Conversation ${id}`;
};

const statusLabel = {
  connecting: "Connecting",
  connected: "Connected",
  failed: "Connection failed",
} as const;

export function ChatSession({ sessionId }: ChatSessionProps) {
  const session = usePiSession(sessionId);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const activeSummary = session.conversations.find(({ id }) => id === session.activeConversationId);
  const activeConversationId = session.activeConversationId;
  const busy = session.activeConversation?.live?.active ?? false;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const content = draft.trim();
    if (content.length === 0 || activeConversationId === undefined) return;
    setSubmitting(true);
    try {
      const accepted = await session.submitPrompt(activeConversationId, content);
      if (accepted) setDraft((current) => (current === draft ? "" : current));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <header>
        <a href="/">pi-durable</a>
        <h1>Session</h1>
        <p>
          <output aria-live="polite">{statusLabel[session.status]}</output>
        </p>
      </header>

      {session.error === undefined ? null : <p role="alert">{session.error}</p>}

      <aside>
        <nav aria-labelledby="conversations-heading">
          <h2 id="conversations-heading">Conversations</h2>
          <button
            type="button"
            onClick={session.createConversation}
            disabled={session.status !== "connected"}
          >
            New conversation
          </button>
          {session.conversations.length === 0 ? (
            <p>No conversations are available yet.</p>
          ) : (
            <ul>
              {session.conversations.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    aria-pressed={conversation.id === session.activeConversationId}
                    onClick={() => session.openConversation(conversation.id)}
                  >
                    {conversationLabel(conversation.id, conversation.parent)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
      </aside>

      <main>
        <section aria-labelledby="transcript-heading">
          <h2 id="transcript-heading">
            {activeSummary === undefined
              ? "Transcript"
              : conversationLabel(activeSummary.id, activeSummary.parent)}
          </h2>

          {session.activeConversation === undefined ? null : (
            <ConversationDetails conversation={session.activeConversation} />
          )}

          {session.activeConversation === undefined ? (
            <p>Loading conversation…</p>
          ) : session.activeConversation.entries.length === 0 &&
            session.activeConversation.live === null ? (
            <p>
              This conversation is empty. Send a message to begin. You can fork the conversation
              from any committed user or assistant message.
            </p>
          ) : (
            <ol>
              {session.activeConversation.entries.map((entry) => (
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

          {session.activeConversation?.live === null ||
          session.activeConversation?.live === undefined ? null : (
            <article aria-busy={session.activeConversation.live.active}>
              <header>
                <strong>Assistant</strong>
              </header>
              {session.activeConversation.live.text.length === 0 ? (
                <p>Responding…</p>
              ) : (
                <MessageText text={session.activeConversation.live.text} />
              )}
              {session.activeConversation.live.retry === undefined ? null : (
                <p role="status">Retrying: {session.activeConversation.live.retry.error}</p>
              )}
            </article>
          )}

          {session.activeConversation === undefined ||
          session.activeConversation.tools.length === 0 ? null : (
            <ToolActivity tools={session.activeConversation.tools} />
          )}

          {session.activeConversation?.failure === undefined ? null : (
            <p role="alert">
              {session.activeConversation.failure.kind} failed:{" "}
              {session.activeConversation.failure.message}
            </p>
          )}
        </section>

        <form onSubmit={submit}>
          <label htmlFor="prompt">Message</label>
          <textarea
            id="prompt"
            name="prompt"
            rows={4}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            disabled={session.status !== "connected" || session.activeConversationId === undefined}
          />
          <button
            type="submit"
            disabled={
              session.status !== "connected" ||
              session.activeConversationId === undefined ||
              busy ||
              submitting ||
              draft.trim().length === 0
            }
          >
            Send
          </button>
        </form>
      </main>
    </>
  );
}

function ConversationDetails({ conversation }: { readonly conversation: ConversationSnapshot }) {
  const config = conversation.config;
  const usage = conversation.usage;
  const totals = usageTotals(usage);
  return (
    <section aria-labelledby="conversation-details-heading">
      <h3 id="conversation-details-heading">Runtime</h3>
      <dl>
        <dt>Model</dt>
        <dd>
          {config?.model === undefined
            ? "Provider default"
            : `${config.model.provider}/${config.model.modelId}`}
        </dd>
        <dt>Thinking</dt>
        <dd>{config?.thinkingLevel ?? "off"}</dd>
        <dt>Tools</dt>
        <dd>
          {config === undefined || config.activeTools.length === 0
            ? "None"
            : config.activeTools.join(", ")}
        </dd>
        <dt>Tokens</dt>
        <dd>{totals.tokens.toLocaleString()}</dd>
        <dt>Cost</dt>
        <dd>{formatCost(totals.cost)}</dd>
      </dl>
    </section>
  );
}

function ToolActivity({ tools }: { readonly tools: readonly ToolProgress[] }) {
  return (
    <section aria-labelledby="tool-activity-heading">
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
                <ul>
                  {tool.diagnostics.map((diagnostic, index) => (
                    <li key={`${diagnostic.code ?? "diagnostic"}-${index}`}>
                      <strong>{capitalize(diagnostic.severity)}</strong>: {diagnostic.message}
                    </li>
                  ))}
                </ul>
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

function TranscriptMessage({
  entry,
  onFork,
}: {
  readonly entry: TranscriptEntry;
  readonly onFork?: () => void;
}) {
  return (
    <article>
      <header>
        <strong>{entry.role === "tool" ? "Tool" : capitalize(entry.role)}</strong>
        {entry.timestamp === undefined ? null : (
          <Fragment>
            {" "}
            <time dateTime={new Date(entry.timestamp).toISOString()}>
              {new Date(entry.timestamp).toLocaleString()}
            </time>
          </Fragment>
        )}
      </header>
      <MessageText text={entry.text} />
      {!entry.canFork || onFork === undefined ? null : (
        <footer>
          <button type="button" onClick={onFork}>
            Fork from here
          </button>
        </footer>
      )}
    </article>
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
