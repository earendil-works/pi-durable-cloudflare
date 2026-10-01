import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { formatScheduledInstruction } from "../src/protocol.ts";
import {
  DeliverScheduledInstruction,
  planHarnessAlarm,
  ScheduleDeliveries,
} from "../src/schedule.ts";
import { createScheduleTool } from "../src/tools.ts";

const context = BACKGROUND_CONTEXT;

describe("scheduled instructions", () => {
  it("delivers a due instruction without recursively scheduling it", async () => {
    const now = Date.now();
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("schedule", { instruction: "Check the oven", delaySeconds: 5 })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Check the oven.")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    let schedulesCreated = 0;
    const scheduleTool = createScheduleTool(async () => {
      schedulesCreated++;
    });
    registry.install(
      defineExtension({
        name: "schedule",
        tasks: [DeliverScheduledInstruction],
        tools: [scheduleTool],
      }),
    );

    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    try {
      const root = await harness.root(context);
      await root.configure(
        { model: { provider: "faux", modelId: "faux-1" }, tools: [scheduleTool] },
        context,
      );
      const scheduled = {
        id: "schedule:due",
        conversationId: root.id,
        instruction: "Check the oven",
        runAt: now - 1,
      };
      const delivery = await root.commit(
        (tx) =>
          tx.createTask(DeliverScheduledInstruction, scheduled, {
            ownership: { kind: "conversation" },
            background: true,
          }),
        context,
      );

      await harness.waitForTask(delivery, context);

      expect(await harness.snapshot(ScheduleDeliveries, context)).toEqual({ active: [] });
      expect(schedulesCreated).toBe(0);
      expect((await root.context(context)).messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: "Scheduled instruction due now: Check the oven",
          }),
          expect.objectContaining({
            role: "toolResult",
            isError: true,
          }),
        ]),
      );
    } finally {
      await harness.close(context);
    }
  });

  it("stores recurrence policy and atomically creates one successor", async () => {
    const now = Date.now();
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "schedule",
            {
              instruction: "Check the oven",
              sourceScheduleId: "schedule:recurring",
            },
            { id: "next-1" },
          ),
          fauxToolCall(
            "schedule",
            {
              instruction: "Check the oven",
              sourceScheduleId: "schedule:recurring",
            },
            { id: "next-2" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Checked; the next check is scheduled.")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    let schedulesCreated = 0;
    const scheduleTool = createScheduleTool(async () => {
      schedulesCreated++;
    });
    registry.install(
      defineExtension({
        name: "schedule",
        tasks: [DeliverScheduledInstruction],
        tools: [scheduleTool],
      }),
    );

    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    try {
      const root = await harness.root(context);
      await root.configure(
        { model: { provider: "faux", modelId: "faux-1" }, tools: [scheduleTool] },
        context,
      );
      const recurrence = {
        cadence: { unit: "minute" as const, interval: 1 },
        timezone: "Europe/Vienna",
      };
      const scheduled = {
        id: "schedule:recurring",
        conversationId: root.id,
        instruction: "Check the oven",
        runAt: now - 1,
        recurrence,
      };
      const delivery = await root.commit(
        (tx) =>
          tx.createTask(DeliverScheduledInstruction, scheduled, {
            ownership: { kind: "conversation" },
            background: true,
          }),
        context,
      );

      await harness.waitForTask(delivery, context);

      const pending = (await harness.inspect(context)).tasks.filter(
        ({ record }) => record.kind === DeliverScheduledInstruction.definition.name,
      );
      expect(pending).toHaveLength(1);
      const next = pending[0]?.record.input as { runAt: number };
      expect(pending[0]?.record.input).toEqual({
        id: expect.stringMatching(/^schedule:\d+$/),
        conversationId: root.id,
        instruction: "Check the oven",
        runAt: expect.any(Number),
        recurrence,
      });
      expect(next.runAt).toBeGreaterThanOrEqual(now + 59_000);
      expect(next.runAt).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(await harness.snapshot(ScheduleDeliveries, context)).toEqual({ active: [] });
      expect(schedulesCreated).toBe(2);
      const messages = (await root.context(context)).messages;
      const toolResults = messages.filter(
        (message): message is Extract<(typeof messages)[number], { role: "toolResult" }> =>
          message.role === "toolResult",
      );
      expect(toolResults).toHaveLength(2);
      expect(toolResults.every((result) => result.isError !== true)).toBe(true);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: formatScheduledInstruction(scheduled),
          }),
        ]),
      );
    } finally {
      await harness.close(context);
    }
  });

  it("derives recurring deadlines from the previous deadline across delays and DST", async () => {
    const cases = [
      {
        name: "minutes skip elapsed occurrences",
        previous: "2026-01-01T10:00:00.000Z",
        now: "2026-01-01T10:05:00.000Z",
        expected: "2026-01-01T10:06:00.000Z",
        cadence: { unit: "minute" as const, interval: 2 },
        timezone: "UTC",
      },
      {
        name: "hours use fixed elapsed durations",
        previous: "2026-01-01T10:00:00.000Z",
        now: "2026-01-01T15:30:00.000Z",
        expected: "2026-01-01T16:00:00.000Z",
        cadence: { unit: "hour" as const, interval: 2 },
        timezone: "Europe/Vienna",
      },
      {
        name: "days preserve wall time and skip a delayed DST occurrence",
        previous: "2026-03-28T08:00:00.000Z",
        now: "2026-03-29T07:30:00.000Z",
        expected: "2026-03-30T07:00:00.000Z",
        cadence: { unit: "day" as const, interval: 1 },
        timezone: "Europe/Vienna",
      },
      {
        name: "DST gaps advance from the resolved elapsed occurrence",
        previous: "2026-03-28T01:30:00.000Z",
        now: "2026-03-29T02:00:00.000Z",
        expected: "2026-03-30T01:30:00.000Z",
        cadence: { unit: "day" as const, interval: 1 },
        timezone: "Europe/Vienna",
      },
      {
        name: "weeks preserve wall time across DST",
        previous: "2026-03-22T08:00:00.000Z",
        now: "2026-03-22T09:00:00.000Z",
        expected: "2026-03-29T07:00:00.000Z",
        cadence: { unit: "week" as const, interval: 1 },
        timezone: "Europe/Vienna",
      },
      {
        name: "months clamp to the target calendar month",
        previous: "2026-01-31T08:00:00.000Z",
        now: "2026-01-31T10:00:00.000Z",
        expected: "2026-02-28T08:00:00.000Z",
        cadence: { unit: "month" as const, interval: 1 },
        timezone: "Europe/Vienna",
      },
    ];

    for (const testCase of cases) {
      const now = Date.parse(testCase.now);
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("schedule", {
              instruction: testCase.name,
              sourceScheduleId: "schedule:calendar",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("Scheduled the next occurrence.")]),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      const scheduleTool = createScheduleTool(async () => {});
      registry.install(
        defineExtension({
          name: "schedule",
          tasks: [DeliverScheduledInstruction],
          tools: [scheduleTool],
        }),
      );
      const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
      try {
        const root = await harness.root(context);
        await root.configure(
          { model: { provider: "faux", modelId: "faux-1" }, tools: [scheduleTool] },
          context,
        );
        const delivery = await root.commit(
          (tx) =>
            tx.createTask(
              DeliverScheduledInstruction,
              {
                id: "schedule:calendar",
                conversationId: root.id,
                instruction: testCase.name,
                runAt: Date.parse(testCase.previous),
                recurrence: {
                  cadence: testCase.cadence,
                  timezone: testCase.timezone,
                },
              },
              { ownership: { kind: "conversation" }, background: true },
            ),
          context,
        );

        await harness.waitForTask(delivery, context);

        const successors = (await harness.inspect(context)).tasks.filter(
          ({ record }) => record.kind === DeliverScheduledInstruction.definition.name,
        );
        expect({
          name: testCase.name,
          runAt: (successors[0]?.record.input as { runAt?: number } | undefined)?.runAt,
        }).toEqual({ name: testCase.name, runAt: Date.parse(testCase.expected) });
      } finally {
        await harness.close(context);
        nowSpy.mockRestore();
      }
    }
  });

  it("cleans up an active delivery when submission fails unexpectedly", async () => {
    const registry = createRegistry();
    registry.install(defineExtension({ name: "schedule", tasks: [DeliverScheduledInstruction] }));
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry },
      context,
    );
    try {
      const root = await harness.root(context);
      await root.submit(
        {
          type: "write",
          requestId: "schedule:collision",
          entry: { kind: "collision" },
        },
        context,
      );
      const delivery = await root.commit(
        (tx) =>
          tx.createTask(
            DeliverScheduledInstruction,
            {
              id: "schedule:collision",
              conversationId: root.id,
              instruction: "Cannot be submitted",
              runAt: Date.now() - 1,
            },
            { ownership: { kind: "conversation" }, background: true },
          ),
        context,
      );

      await harness.waitForTask(delivery, context);

      expect(await harness.snapshot(ScheduleDeliveries, context)).toEqual({ active: [] });
    } finally {
      await harness.close(context);
    }
  });

  it("plans one infrastructure alarm from delayed and active Harness tasks", async () => {
    const now = Date.now();
    const registry = createRegistry();
    registry.install(defineExtension({ name: "schedule", tasks: [DeliverScheduledInstruction] }));
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry },
      context,
    );
    try {
      const root = await harness.root(context);
      await root.commit(async (tx) => {
        for (const [id, runAt] of [
          ["schedule:later", now + 20_000],
          ["schedule:sooner", now + 10_000],
          ["schedule:due", now - 1],
        ] as const) {
          await tx.createTask(
            DeliverScheduledInstruction,
            { id, conversationId: root.id, instruction: id, runAt },
            { ownership: { kind: "conversation" }, background: true },
          );
        }
      }, context);

      const plan = planHarnessAlarm((await harness.inspect(context)).tasks, now);
      expect(plan.nextDeadline).toBe(now + 10_000);
      expect(plan.recoveryTasks).toHaveLength(1);
    } finally {
      await harness.close(context);
    }
  });
});
