import { describe, expect, it } from "vitest";
import { initialSessionState, sessionReducer } from "../src/client/session-state.ts";
import { parseServerEventEnvelope, formatScheduledInstruction } from "../src/protocol.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "faux",
  provider: "faux",
  model: "faux",
  usage,
  stopReason: "stop",
  timestamp: 2,
});

const event = (value: unknown) => parseServerEventEnvelope(JSON.stringify(value));

describe("session event reducer", () => {
  it("hydrates a late join and applies streamed message events", () => {
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "session.snapshot",
        session: { conversations: [{ id: 1 }] },
      }),
    });

    state = sessionReducer(state, {
      type: "event",
      event: event({
        type: "conversation.events",
        conversationId: 1,
        events: [
          {
            type: "snapshot",
            entries: [
              {
                id: 2,
                conversationId: 1,
                kind: "pi.user",
                model: [{ role: "user", content: "Hello", timestamp: 1 }],
              },
            ],
            run: { inputs: [3] },
            generation: { attempt: 1, message: assistant("Hel") },
            tools: [],
            inbox: [],
            config: { thinkingLevel: "off", activeTools: [] },
            usage: { models: {}, tools: {} },
          },
        ],
      }),
    });

    expect(state.snapshots[1]).toMatchObject({
      entries: [{ role: "user", text: "Hello" }],
      live: { active: true, text: "Hel" },
      tools: [],
      config: { thinkingLevel: "off", activeTools: [] },
      usage: { models: {}, tools: {} },
    });

    state = sessionReducer(state, {
      type: "event",
      event: event({
        type: "conversation.events",
        conversationId: 1,
        events: [
          {
            type: "message_update",
            usage,
            changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }],
          },
          {
            type: "message_end",
            entry: {
              id: 4,
              conversationId: 1,
              kind: "pi.assistant",
              model: [assistant("Hello")],
            },
          },
          { type: "run_end", inputs: [3] },
        ],
      }),
    });

    expect(state.snapshots[1]).toMatchObject({
      entries: [
        { role: "user", text: "Hello" },
        { role: "assistant", text: "Hello" },
      ],
      live: null,
    });
  });

  it("labels scheduled deliveries rather than user messages", () => {
    const state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "conversation.events",
        conversationId: 1,
        events: [
          {
            type: "snapshot",
            entries: [
              {
                id: 2,
                conversationId: 1,
                kind: "pi.user",
                model: [
                  {
                    role: "user",
                    content: formatScheduledInstruction({
                      id: "schedule:2",
                      instruction: "Look outside the window",
                    }),
                    timestamp: 1,
                  },
                ],
              },
              {
                id: 3,
                conversationId: 1,
                kind: "pi.user",
                model: [
                  {
                    role: "user",
                    content: formatScheduledInstruction({
                      id: "schedule:3",
                      instruction: "Check again tomorrow",
                      recurring: true,
                    }),
                    timestamp: 2,
                  },
                ],
              },
            ],
            tools: [],
            inbox: [],
            config: { thinkingLevel: "off", activeTools: ["schedule"] },
            usage: { models: {}, tools: {} },
          },
        ],
      }),
    });

    expect(state.snapshots[1]?.entries).toEqual([
      expect.objectContaining({
        role: "scheduled",
        text: "Look outside the window",
        canFork: false,
      }),
      expect.objectContaining({
        role: "scheduled",
        text: "Check again tomorrow",
        canFork: false,
      }),
    ]);
  });

  it("does not change the selected conversation for prompt acknowledgements", () => {
    let state = sessionReducer(initialSessionState, { type: "select", conversationId: 2 });
    state = sessionReducer(state, {
      type: "event",
      event: event({
        type: "command.result",
        command: "prompt.submit",
        requestId: "prompt-1",
        ok: true,
        conversationId: 1,
        submissionId: 3,
      }),
    });
    expect(state.activeConversationId).toBe(2);

    state = sessionReducer(state, {
      type: "event",
      event: event({
        type: "command.result",
        command: "conversation.create",
        requestId: "create-1",
        ok: true,
        conversationId: 4,
      }),
    });
    expect(state.activeConversationId).toBe(4);
  });

  it("rejects command results without a valid command discriminator", () => {
    expect(() =>
      event({
        type: "command.result",
        requestId: "prompt-1",
        ok: true,
        conversationId: 1,
      }),
    ).toThrow("Command result command is invalid");
  });

  it("inserts streamed blocks and applies nested tool-call deltas", () => {
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "conversation.events",
        conversationId: 1,
        events: [
          {
            type: "message_start",
            message: assistant("tail"),
          },
          {
            type: "message_update",
            usage,
            changes: [
              { type: "text_start", contentIndex: 0, block: { type: "text", text: "" } },
              { type: "text_delta", contentIndex: 0, delta: "Hello" },
              {
                type: "toolcall_start",
                contentIndex: 1,
                block: {
                  type: "toolCall",
                  id: "call-1",
                  name: "search",
                  arguments: { query: "hel", options: { region: "e" } },
                },
              },
              {
                type: "toolcall_delta",
                contentIndex: 1,
                path: ["query"],
                delta: "lo",
              },
              {
                type: "toolcall_delta",
                contentIndex: 1,
                path: ["options", "region"],
                delta: "u",
              },
            ],
          },
        ],
      }),
    });

    expect(state.snapshots[1]?.partial?.content).toEqual([
      { type: "text", text: "Hello" },
      {
        type: "toolCall",
        id: "call-1",
        name: "search",
        arguments: { query: "hello", options: { region: "eu" } },
      },
      { type: "text", text: "tail" },
    ]);
  });

  it("tracks tool progress, usage, and configuration changes", () => {
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "conversation.events",
        conversationId: 1,
        events: [
          {
            type: "snapshot",
            entries: [],
            tools: [],
            inbox: [],
            config: { thinkingLevel: "off", activeTools: [] },
            usage: { models: {}, tools: {} },
          },
          {
            type: "tool_execution_start",
            toolCallId: "call-1",
            toolName: "search",
            args: { query: "durable agents" },
          },
          {
            type: "tool_execution_update",
            toolCallId: "call-1",
            toolName: "search",
            output: { set: "searching" },
            details: { matches: 2 },
            diagnostics: [{ severity: "info", message: "Using cached index" }],
          },
          {
            type: "tool_execution_update",
            toolCallId: "call-1",
            toolName: "search",
            output: { trimStart: 6, append: "ed" },
          },
          {
            type: "config_changed",
            config: {
              model: { provider: "openai", modelId: "gpt-test" },
              thinkingLevel: "high",
              activeTools: ["search"],
            },
          },
          {
            type: "usage_changed",
            usage: {
              models: {
                "openai/gpt-test": {
                  ...usage,
                  input: 10,
                  output: 5,
                  totalTokens: 15,
                  cost: { ...usage.cost, total: 0.0125 },
                },
              },
              tools: {},
            },
          },
          {
            type: "tool_execution_end",
            toolCallId: "call-1",
            toolName: "search",
          },
        ],
      }),
    });

    expect(state.snapshots[1]).toMatchObject({
      tools: [
        {
          callId: "call-1",
          name: "search",
          status: "done",
          args: { query: "durable agents" },
          output: "inged",
          details: { matches: 2 },
          diagnostics: [{ severity: "info", message: "Using cached index" }],
        },
      ],
      config: {
        model: { provider: "openai", modelId: "gpt-test" },
        thinkingLevel: "high",
        activeTools: ["search"],
      },
      usage: {
        models: { "openai/gpt-test": { input: 10, output: 5, totalTokens: 15 } },
      },
    });

    state = sessionReducer(state, {
      type: "event",
      event: event({
        type: "conversation.events",
        conversationId: 1,
        events: [{ type: "run_end", inputs: [] }],
      }),
    });
    expect(state.snapshots[1]?.tools).toEqual([]);
  });

  it("surfaces task failures until another run starts", () => {
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "conversation.events",
        conversationId: 1,
        events: [{ type: "task_failed", taskId: 9, kind: "pi.generation", message: "boom" }],
      }),
    });

    expect(state.snapshots[1]?.failure).toEqual({
      taskId: 9,
      kind: "pi.generation",
      message: "boom",
    });

    state = sessionReducer(state, {
      type: "event",
      event: event({
        type: "conversation.events",
        conversationId: 1,
        events: [{ type: "run_start", inputs: [10] }],
      }),
    });
    expect(state.snapshots[1]?.failure).toBeUndefined();
  });
});
