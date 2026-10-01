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
            compactions: [],
            inbox: [],
            agent: { thinkingLevel: "off", tools: [] },
            usage: { models: {}, tools: {} },
          },
        ],
      }),
    });

    expect(state.snapshots[1]).toMatchObject({
      entries: [{ role: "user", text: "Hello" }],
      live: { active: true, text: "Hel" },
      tools: [],
      agent: { thinkingLevel: "off", tools: [] },
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
                      recurrence: {
                        cadence: { unit: "day", interval: 1 },
                        timezone: "Europe/Vienna",
                      },
                    }),
                    timestamp: 2,
                  },
                ],
              },
            ],
            tools: [],
            compactions: [],
            inbox: [],
            agent: { thinkingLevel: "off", tools: ["schedule"] },
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

  it("labels compaction and reset entries and strips the summary wrapper", () => {
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
                id: 5,
                conversationId: 1,
                kind: "pi.compaction",
                head: 3,
                model: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nUser asked about weather.\n</summary>",
                      },
                    ],
                    timestamp: 1,
                  },
                ],
                data: { reason: "threshold" },
              },
              { id: 6, conversationId: 1, kind: "pi.reset", head: 6 },
              {
                id: 7,
                conversationId: 1,
                kind: "pi.reset",
                head: 7,
                model: [{ role: "user", content: "Continue from the handoff.", timestamp: 2 }],
              },
            ],
            tools: [],
            compactions: [],
            inbox: [],
            agent: { thinkingLevel: "off", tools: [] },
            usage: { models: {}, tools: {} },
          },
        ],
      }),
    });

    expect(state.snapshots[1]?.entries).toEqual([
      expect.objectContaining({
        role: "compaction",
        text: "User asked about weather.",
        canFork: false,
      }),
      expect.objectContaining({ role: "reset", text: "Context reset", canFork: false }),
      expect.objectContaining({
        role: "reset",
        text: "Continue from the handoff.",
        canFork: false,
      }),
    ]);
  });

  it("omits the rendered diagnostics block from tool result text", () => {
    const diagnostics = [{ severity: "warn", code: "truncated", message: "Output truncated" }];
    const state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "conversation.events",
        conversationId: 1,
        events: [
          {
            type: "entry_appended",
            entry: {
              id: 4,
              conversationId: 1,
              kind: "pi.tool-result",
              model: [
                {
                  role: "toolResult",
                  toolCallId: "call-1",
                  toolName: "get_weather",
                  content: [
                    { type: "text", text: "Sunny" },
                    { type: "text", text: "<harness>\n[warn] Output truncated\n</harness>" },
                  ],
                  isError: false,
                  timestamp: 1,
                },
              ],
              data: { diagnostics },
            },
          },
        ],
      }),
    });

    expect(state.snapshots[1]?.entries).toEqual([
      expect.objectContaining({ role: "tool", text: "Sunny", diagnostics }),
    ]);
  });

  it("tracks live compactions from snapshots and events", () => {
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
            compactions: [{ taskId: 8, reason: "threshold", blocking: false, attempt: 1 }],
            inbox: [],
            agent: { thinkingLevel: "off", tools: [] },
            usage: { models: {}, tools: {} },
          },
          { type: "compaction_start", taskId: 9, reason: "overflow", blocking: true },
        ],
      }),
    });

    expect(state.snapshots[1]?.compactions).toEqual([
      { taskId: 8, reason: "threshold", blocking: false },
      { taskId: 9, reason: "overflow", blocking: true },
    ]);

    state = sessionReducer(state, {
      type: "event",
      event: event({
        type: "conversation.events",
        conversationId: 1,
        events: [
          { type: "compaction_end", taskId: 8, reason: "threshold" },
          { type: "compaction_end", taskId: 9, reason: "overflow" },
        ],
      }),
    });
    expect(state.snapshots[1]?.compactions).toEqual([]);
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

  it("keeps conversation owners in the session snapshot", () => {
    const state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "session.snapshot",
        session: { conversations: [{ id: 1 }, { id: 7, owner: { conversationId: 1 } }] },
      }),
    });
    expect(state.conversations).toEqual([{ id: 1 }, { id: 7, owner: { conversationId: 1 } }]);
    expect(() =>
      event({
        type: "session.snapshot",
        session: { conversations: [{ id: 7, owner: { conversationId: "1" } }] },
      }),
    ).toThrow("conversation.owner.conversationId must be a positive integer");
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
            compactions: [],
            inbox: [],
            agent: { thinkingLevel: "off", tools: [] },
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
            type: "agent_changed",
            agent: {
              model: { provider: "openai", modelId: "gpt-test" },
              thinkingLevel: "high",
              tools: ["search"],
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
      agent: {
        model: { provider: "openai", modelId: "gpt-test" },
        thinkingLevel: "high",
        tools: ["search"],
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

  it("tracks queued inputs across agent snapshots until the inbox drains", () => {
    const inbox = (items: unknown[]) =>
      event({ type: "conversation.inbox", conversationId: 1, items });
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: inbox([{ submissionId: 5, mode: "followUp", text: "And tomorrow?" }]),
    });
    state = sessionReducer(state, {
      type: "event",
      event: event({
        type: "conversation.events",
        conversationId: 1,
        events: [
          {
            type: "snapshot",
            entries: [],
            run: { inputs: [3] },
            tools: [],
            compactions: [],
            inbox: [{ id: 5, mode: "followUp" }],
            agent: { thinkingLevel: "off", tools: [] },
            usage: { models: {}, tools: {} },
          },
        ],
      }),
    });
    expect(state.snapshots[1]?.queued).toEqual([
      { submissionId: 5, mode: "followUp", text: "And tomorrow?" },
    ]);

    state = sessionReducer(state, { type: "event", event: inbox([]) });
    expect(state.snapshots[1]?.queued).toEqual([]);
  });

  it("tracks typing presence per conversation", () => {
    let state = sessionReducer(initialSessionState, {
      type: "event",
      event: event({
        type: "presence.typing",
        conversationId: 2,
        usernames: ["Anne", "John"],
      }),
    });
    expect(state.snapshots[2]?.typing).toEqual(["Anne", "John"]);

    state = sessionReducer(state, {
      type: "event",
      event: event({ type: "presence.typing", conversationId: 2, usernames: [] }),
    });
    expect(state.snapshots[2]?.typing).toEqual([]);
  });

  it("rejects malformed queued inputs", () => {
    expect(() =>
      event({
        type: "conversation.inbox",
        conversationId: 1,
        items: [{ submissionId: 5, mode: "write", text: "x" }],
      }),
    ).toThrow("Queued input is invalid");
  });
});
