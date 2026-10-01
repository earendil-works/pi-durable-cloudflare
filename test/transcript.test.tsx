import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TranscriptList } from "../src/client/Transcript.tsx";
import type { TranscriptEntry, ToolProgress } from "../src/client/session-state.ts";

const toolRequest: TranscriptEntry = {
  id: 2,
  conversationId: 1,
  kind: "pi.assistant",
  role: "assistant",
  text: "I will check.",
  timestamp: 1,
  canFork: true,
  toolCalls: [
    {
      callId: "call-1",
      name: "get_weather",
      args: { location: "Vienna" },
    },
  ],
};

const runningTool: ToolProgress = {
  callId: "call-1",
  name: "get_weather",
  status: "running",
  output: "Checking conditions",
};

function render(
  entries: readonly TranscriptEntry[],
  tools: readonly ToolProgress[],
  onFork?: (entryId: number) => void,
): string {
  return renderToStaticMarkup(
    createElement(TranscriptList, { entries, tools, runActive: true, onFork }),
  );
}

describe("transcript rendering", () => {
  it("keeps the fork action inside the entry header", () => {
    const userEntry: TranscriptEntry = {
      id: 1,
      conversationId: 1,
      kind: "pi.user",
      role: "user",
      text: "Hello",
      timestamp: 1,
      canFork: true,
    };
    const transcript = render([userEntry], [], () => undefined);
    const fork = transcript.indexOf(">Fork</button>");
    const headerEnd = transcript.indexOf("</header>");

    expect(fork).toBeGreaterThan(0);
    expect(fork).toBeLessThan(headerEnd);
    expect(transcript).toContain('aria-label="Fork from this entry"');
    expect(transcript).toContain('title="Entry (id: 1)"');
    expect(transcript).not.toContain("<footer");
  });

  it("replaces inline progress with the committed result for the same tool call", () => {
    const running = render([toolRequest], [runningTool]);

    expect(running).toContain("get_weather");
    expect(running).toContain("Running");
    expect(running).toContain("Checking conditions");
    expect(running).toContain("Vienna");
    expect(running).not.toContain("Tool activity");
    expect(running).not.toContain("Tool call:");

    const result: TranscriptEntry = {
      id: 3,
      conversationId: 1,
      kind: "pi.tool-result",
      role: "tool",
      text: "Sunny, 21°C",
      timestamp: 2,
      canFork: false,
      toolResult: {
        callId: "call-1",
        name: "get_weather",
        isError: false,
        details: { source: "forecast" },
      },
    };
    const completed = render([toolRequest, result], [{ ...runningTool, status: "done" }]);

    expect(completed.match(/get_weather/g)).toHaveLength(1);
    expect(completed).toContain("Completed");
    expect(completed).toContain("Sunny, 21°C");
    expect(completed).toContain("forecast");
    expect(completed).not.toContain("Running");
    expect(completed).not.toContain("Checking conditions");
  });
  it("pairs reused provider call IDs with results in transcript order", () => {
    const secondRequest: TranscriptEntry = {
      ...toolRequest,
      id: 4,
      text: "I will check again.",
      toolCalls: [
        {
          callId: "call-1",
          name: "get_weather",
          args: { location: "Graz" },
        },
      ],
    };
    const result = (id: number, text: string): TranscriptEntry => ({
      id,
      conversationId: 1,
      kind: "pi.tool-result",
      role: "tool",
      text,
      canFork: false,
      toolResult: {
        callId: "call-1",
        name: "get_weather",
        isError: false,
      },
    });

    const transcript = render(
      [toolRequest, result(3, "Vienna result"), secondRequest, result(5, "Graz result")],
      [],
    );

    expect(transcript.match(/Vienna result/g)).toHaveLength(1);
    expect(transcript.match(/Graz result/g)).toHaveLength(1);
    expect(transcript.indexOf("Vienna result")).toBeLessThan(transcript.indexOf("Graz result"));
  });
});
