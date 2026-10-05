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
      }),
    );

    expect(markup).toContain("Activity");
    expect(markup).toContain("3 active tasks");
    expect(markup).toContain("pi.tool");
    expect(markup).toContain("Waiting for #5");
    expect(markup).toContain('aria-label="Children of task 4"');
    expect(markup).toContain('href="?conversation=2"');
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
      }),
    );

    expect(markup).toContain("No active tasks");
  });
});
