import type { ToolDiagnostic } from "@earendil-works/pi-durable";
import type { TranscriptEntry, TranscriptToolCall, ToolProgress } from "./session-state.ts";

interface TranscriptListProps {
  readonly entries: readonly TranscriptEntry[];
  readonly tools: readonly ToolProgress[];
  readonly runActive: boolean;
  readonly onFork?: (entryId: number) => void;
}

export function TranscriptList({ entries, tools, runActive, onFork }: TranscriptListProps) {
  const { resultsByRequest, groupedResultIds } = correlateToolResults(entries);
  const progress = new Map(tools.map((tool) => [tool.callId, tool]));

  return (
    <ol className="transcript-list">
      {entries.map((entry) => {
        if (groupedResultIds.has(entry.id)) return null;

        if (entry.toolCalls !== undefined && entry.toolCalls.length > 0) {
          const results = resultsByRequest.get(entry.id);
          return (
            <li className="transcript-turn" key={entry.id}>
              {entry.text.length > 0 ? (
                <TranscriptMessage
                  entry={entry}
                  onFork={onFork === undefined ? undefined : () => onFork(entry.id)}
                />
              ) : (
                <ToolRequest
                  entry={entry}
                  onFork={onFork === undefined ? undefined : () => onFork(entry.id)}
                />
              )}
              <ol className="tool-executions" aria-label="Tool calls">
                {entry.toolCalls.map((call) => (
                  <li key={call.callId}>
                    <ToolExecution
                      call={call}
                      progress={progress.get(call.callId)}
                      result={results?.get(call.callId)}
                      runActive={runActive}
                    />
                  </li>
                ))}
              </ol>
            </li>
          );
        }

        if (entry.toolResult !== undefined) {
          return (
            <li key={entry.id}>
              <ToolExecution
                call={{
                  callId: entry.toolResult.callId,
                  name: entry.toolResult.name,
                  args: {},
                }}
                result={entry}
                runActive={false}
                showArguments={false}
              />
            </li>
          );
        }

        return (
          <li key={entry.id}>
            <TranscriptMessage
              entry={entry}
              onFork={onFork === undefined ? undefined : () => onFork(entry.id)}
            />
          </li>
        );
      })}
    </ol>
  );
}

function correlateToolResults(entries: readonly TranscriptEntry[]): {
  readonly resultsByRequest: ReadonlyMap<number, ReadonlyMap<string, TranscriptEntry>>;
  readonly groupedResultIds: ReadonlySet<number>;
} {
  const pending = new Map<string, number[]>();
  const resultsByRequest = new Map<number, Map<string, TranscriptEntry>>();
  const groupedResultIds = new Set<number>();

  for (const entry of entries) {
    for (const call of entry.toolCalls ?? []) {
      const requests = pending.get(call.callId) ?? [];
      requests.push(entry.id);
      pending.set(call.callId, requests);
    }
    if (entry.toolResult === undefined) continue;

    const requests = pending.get(entry.toolResult.callId);
    const requestId = requests?.shift();
    if (requestId === undefined) continue;
    const results = resultsByRequest.get(requestId) ?? new Map<string, TranscriptEntry>();
    results.set(entry.toolResult.callId, entry);
    resultsByRequest.set(requestId, results);
    groupedResultIds.add(entry.id);
    if (requests?.length === 0) pending.delete(entry.toolResult.callId);
  }

  return { resultsByRequest, groupedResultIds };
}

interface ToolExecutionProps {
  readonly call: TranscriptToolCall;
  readonly progress?: ToolProgress;
  readonly result?: TranscriptEntry;
  readonly runActive: boolean;
  readonly showArguments?: boolean;
}

type ToolDisplayStatus = "waiting" | "running" | "completed" | "failed" | "missing";

function ToolExecution({
  call,
  progress,
  result,
  runActive,
  showArguments = true,
}: ToolExecutionProps) {
  const committed = result?.toolResult;
  const status: ToolDisplayStatus =
    committed !== undefined
      ? committed.isError
        ? "failed"
        : "completed"
      : progress?.status === "running"
        ? "running"
        : progress?.status === "done"
          ? "completed"
          : runActive
            ? "waiting"
            : "missing";
  const output = result?.text ?? progress?.output;
  const details = committed?.details ?? progress?.details;
  const diagnostics = result?.diagnostics ?? progress?.diagnostics;
  const timestamp = result?.timestamp === undefined ? undefined : new Date(result.timestamp);

  return (
    <article
      className={`tool-execution tool-execution--${status}`}
      aria-busy={status === "waiting" || status === "running"}
    >
      <header>
        <strong>{call.name}</strong>
        <span className="tool-status">{toolStatusLabel[status]}</span>
        {timestamp === undefined ? null : <MessageTime timestamp={timestamp} />}
      </header>
      {showArguments ? (
        <details>
          <summary>Arguments</summary>
          <pre>{JSON.stringify(call.args, null, 2)}</pre>
        </details>
      ) : null}
      {output === undefined || output.length === 0 ? null : <MessageText text={output} />}
      {details === undefined ? null : (
        <details>
          <summary>Details</summary>
          <pre>{JSON.stringify(details, null, 2)}</pre>
        </details>
      )}
      {committed?.nestedCalls === undefined ? null : (
        <details>
          <summary>Nested tool calls</summary>
          <pre>{JSON.stringify(committed.nestedCalls, null, 2)}</pre>
        </details>
      )}
      {diagnostics === undefined || diagnostics.length === 0 ? null : (
        <Diagnostics diagnostics={diagnostics} />
      )}
    </article>
  );
}

const toolStatusLabel: Record<ToolDisplayStatus, string> = {
  waiting: "Waiting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  missing: "No result",
};

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

function ToolRequest({
  entry,
  onFork,
}: {
  readonly entry: TranscriptEntry;
  readonly onFork?: () => void;
}) {
  const timestamp = entry.timestamp === undefined ? undefined : new Date(entry.timestamp);

  return (
    <article className="transcript-message transcript-message--assistant transcript-message--tool-request">
      <header>
        <EntryTitle
          entryId={entry.id}
          label="Assistant"
          detail="Tool request"
          timestamp={timestamp}
        />
        {onFork === undefined ? null : <ForkAction onFork={onFork} />}
      </header>
    </article>
  );
}

export function TranscriptMessage({
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
        <EntryTitle entryId={entry.id} label={roleLabel[entry.role]} timestamp={timestamp} />
        {!entry.canFork || onFork === undefined ? null : <ForkAction onFork={onFork} />}
      </header>
      <MessageText text={entry.text} />
      {entry.diagnostics === undefined ? null : <Diagnostics diagnostics={entry.diagnostics} />}
    </article>
  );
}

function EntryTitle({
  entryId,
  label,
  detail,
  timestamp,
}: {
  readonly entryId: number;
  readonly label: string;
  readonly detail?: string;
  readonly timestamp?: Date;
}) {
  return (
    <div className="transcript-message-title" title={`Entry (id: ${entryId})`}>
      <strong>{label}</strong>
      {detail === undefined ? null : <span>{detail}</span>}
      {timestamp === undefined ? null : <MessageTime timestamp={timestamp} />}
    </div>
  );
}

function ForkAction({ onFork }: { readonly onFork: () => void }) {
  return (
    <button
      className="text-button transcript-fork"
      type="button"
      aria-label="Fork from this entry"
      onClick={onFork}
    >
      Fork
    </button>
  );
}

function MessageTime({ timestamp }: { readonly timestamp: Date }) {
  return (
    <time dateTime={timestamp.toISOString()} title={formatAbsoluteTime(timestamp)}>
      {formatMessageTime(timestamp)}
    </time>
  );
}

export function Diagnostics({ diagnostics }: { readonly diagnostics: readonly ToolDiagnostic[] }) {
  return (
    <ul className="diagnostics">
      {diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.code ?? "diagnostic"}-${index}`}>
          <strong>{capitalize(diagnostic.severity)}</strong>: {diagnostic.message}
        </li>
      ))}
    </ul>
  );
}

export function MessageText({ text }: { readonly text: string }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </>
  );
}

const formatMessageTime = (timestamp: Date): string => {
  const now = new Date();
  const isToday =
    timestamp.getDate() === now.getDate() &&
    timestamp.getMonth() === now.getMonth() &&
    timestamp.getFullYear() === now.getFullYear();
  return timestamp.toLocaleString(undefined, {
    ...(isToday ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatAbsoluteTime = (timestamp: Date): string =>
  timestamp.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

const capitalize = (value: string): string =>
  value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
