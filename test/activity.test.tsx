import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskGraph } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { ActivityPanel } from "../src/client/ActivityPanel.tsx";

const graph = {
  tasks: {
    "4": {
      id: 4,
      kind: "pi.tool",
      conversationId: 1,
      background: false,
      abortRequested: false,
      state: { status: "waiting", phase: "execute", on: [5], policy: "failFast" },
      conversations: [2],
    },
    "5": {
      id: 5,
      kind: "pi.generation",
      conversationId: 1,
      owner: 4,
      background: false,
      abortRequested: false,
      state: { status: "running", phase: "stream" },
      conversations: [],
    },
    "6": {
      id: 6,
      kind: "pi.generation",
      conversationId: 2,
      background: true,
      abortRequested: true,
      state: { status: "pending", phase: "start" },
      conversations: [],
    },
    "7": {
      id: 7,
      kind: "app.deliver-scheduled-instruction",
      conversationId: 1,
      background: true,
      abortRequested: false,
      state: { status: "sleeping", phase: "wait", until: Date.UTC(2026, 9, 1, 9) },
      blocked: "restart_limit",
      conversations: [],
    },
    "8": {
      id: 8,
      kind: "app.retired-task",
      conversationId: 1,
      background: true,
      abortRequested: false,
      state: { status: "pending", phase: "start" },
      blocked: "missing_task",
      conversations: [],
    },
  },
} as unknown as TaskGraph;

describe("activity rendering", () => {
  it("renders task ownership and conversation-owned work as one accessible tree", () => {
    const markup = renderToStaticMarkup(
      createElement(ActivityPanel, {
        graph,
        activeConversationId: 1,
        onClose: () => undefined,
        onOpenConversation: () => undefined,
        onRetryTask: async () => true,
      }),
    );

    expect(markup).toContain("Activity");
    expect(markup).toContain("5 active tasks");
    expect(markup).toContain("pi.tool");
    expect(markup).toContain("Waiting for #5");
    expect(markup).toContain(
      `Sleeping until ${new Date(Date.UTC(2026, 9, 1, 9)).toLocaleString()} · wait`,
    );
    expect(markup).toContain('aria-label="Children of task 4"');
    expect(markup).toContain('href="?conversation=2"');
    expect(markup).toContain("Parked · cut off by repeated crashes");
    expect(markup).toContain("Blocked · no installed task definition");
    // Only the task parked by the restart limit offers a retry; another blocked task does not.
    expect(markup.match(/>Retry</g)).toHaveLength(1);
    expect(markup).toContain("Background");
    expect(markup).toContain("Aborting");
  });

  it("explains when there is no active work", () => {
    const markup = renderToStaticMarkup(
      createElement(ActivityPanel, {
        graph: { tasks: {} },
        activeConversationId: 1,
        onClose: () => undefined,
        onOpenConversation: () => undefined,
        onRetryTask: async () => true,
      }),
    );

    expect(markup).toContain("No active tasks");
  });
});
