import { useState, type MouseEvent, type ReactNode, type Ref } from "react";
import type { BlockedReason, TaskGraph, TaskGraphNode } from "@earendil-works/pi-durable";

interface ActivityPanelProps {
  readonly graph: TaskGraph | undefined;
  readonly activeConversationId: number | undefined;
  readonly onClose: () => void;
  readonly closeButtonRef?: Ref<HTMLButtonElement>;
  readonly onOpenConversation: (conversationId: number) => void;
  /** Runs a parked task again; resolves whether the server accepted it. */
  readonly onRetryTask: (taskId: number) => Promise<boolean>;
}

const blockedReasons: Record<BlockedReason, string> = {
  missing_task: "Blocked · no installed task definition",
  task_too_old: "Blocked · task definition too old",
  migration_failed: "Blocked · task migration failed",
  restart_limit: "Parked · cut off by repeated crashes",
};

const taskStatus = (node: TaskGraphNode): string => {
  const state = node.state;
  switch (state.status) {
    case "pending":
      return `Pending · ${state.phase}`;
    case "running":
      return `Running · ${state.phase}`;
    case "sleeping":
      return `Sleeping until ${new Date(state.until).toLocaleString()} · ${state.phase}`;
    case "waiting":
      return `Waiting for ${state.on.map((id) => `#${id}`).join(", ")} · ${state.policy === "failFast" ? "fail fast" : "all settled"}`;
    case "completing":
      return `Finishing · ${state.outcome}`;
  }
};

export function ActivityPanel({
  graph,
  activeConversationId,
  onClose,
  closeButtonRef,
  onOpenConversation,
  onRetryTask,
}: ActivityPanelProps) {
  const [retrying, setRetrying] = useState<ReadonlySet<number>>(new Set());
  const nodes = Object.values(graph?.tasks ?? {}).sort((left, right) => left.id - right.id);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<number, TaskGraphNode[]>();
  const roots: TaskGraphNode[] = [];

  for (const node of nodes) {
    const directOwner = node.owner === undefined ? undefined : nodesById.get(node.owner);
    const conversationOwner =
      directOwner === undefined
        ? nodes.find((candidate) => candidate.conversations.includes(node.conversationId))
        : undefined;
    const parent = directOwner ?? conversationOwner;
    if (parent === undefined || parent.id === node.id) {
      roots.push(node);
      continue;
    }
    const siblings = children.get(parent.id) ?? [];
    siblings.push(node);
    children.set(parent.id, siblings);
  }

  const followConversation = (event: MouseEvent<HTMLAnchorElement>, conversationId: number) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    onOpenConversation(conversationId);
  };

  const retry = (taskId: number) => {
    setRetrying((current) => new Set(current).add(taskId));
    // A retried task leaves the parked state through the next activity update, which hides the button.
    void onRetryTask(taskId).finally(() =>
      setRetrying((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      }),
    );
  };

  const conversationLink = (conversationId: number, label: string) => (
    <a
      href={`?conversation=${conversationId}`}
      aria-current={conversationId === activeConversationId ? "page" : undefined}
      onClick={(event) => followConversation(event, conversationId)}
    >
      {label}
    </a>
  );

  const task = (node: TaskGraphNode): ReactNode => {
    const owned = children.get(node.id) ?? [];
    return (
      <li key={node.id}>
        <article className="activity-task">
          <header>
            <strong>{node.kind}</strong>
            <span>#{node.id}</span>
          </header>
          <p className="activity-task-status">{taskStatus(node)}</p>
          {node.blocked === undefined ? null : (
            <p className="activity-task-blocked">{blockedReasons[node.blocked]}</p>
          )}
          {node.blocked === "restart_limit" ? (
            <button
              type="button"
              className="activity-task-retry"
              disabled={retrying.has(node.id)}
              onClick={() => retry(node.id)}
            >
              {retrying.has(node.id) ? "Retrying…" : "Retry"}
            </button>
          ) : null}
          <p className="activity-task-conversation">
            {conversationLink(node.conversationId, `Conversation #${node.conversationId}`)}
            {node.owner === undefined ? null : ` · Owner task #${node.owner}`}
          </p>
          {node.background || node.abortRequested ? (
            <ul className="activity-task-flags" aria-label="Task flags">
              {node.background ? <li>Background</li> : null}
              {node.abortRequested ? <li>Aborting</li> : null}
            </ul>
          ) : null}
          {node.conversations.length === 0 ? null : (
            <p className="activity-task-owned">
              Owns{" "}
              {node.conversations.map((conversationId, index) => (
                <span key={conversationId}>
                  {index === 0 ? null : ", "}
                  {conversationLink(conversationId, `conversation #${conversationId}`)}
                </span>
              ))}
            </p>
          )}
        </article>
        {owned.length === 0 ? null : (
          <ol
            className="activity-tree activity-tree--nested"
            aria-label={`Children of task ${node.id}`}
          >
            {owned.map(task)}
          </ol>
        )}
      </li>
    );
  };

  const countLabel = `${nodes.length} active task${nodes.length === 1 ? "" : "s"}`;
  return (
    <aside className="activity-panel" id="activity-panel" aria-labelledby="activity-heading">
      <header className="activity-header">
        <div>
          <h2 id="activity-heading">Activity</h2>
          <p>{countLabel}</p>
        </div>
        <button ref={closeButtonRef} type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="activity-content">
        {graph === undefined ? (
          <p className="activity-empty">Loading activity…</p>
        ) : roots.length === 0 ? (
          <p className="activity-empty">No active tasks</p>
        ) : (
          <ol className="activity-tree" aria-label="Active task graph">
            {roots.map(task)}
          </ol>
        )}
      </div>
    </aside>
  );
}
