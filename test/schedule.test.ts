import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
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
    registry.tasks.add(DeliverScheduledInstruction);
    let schedulesCreated = 0;
    registry.tools.add(
      createScheduleTool(async () => {
        schedulesCreated++;
      }),
    );
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);

    try {
      const root = await harness.root(context);
      await root.setModel({ provider: "faux", modelId: "faux-1" }, context);
      await root.setActiveTools(["schedule"], context);
      const scheduled = {
        id: "schedule:due",
        conversationId: root.id,
        instruction: "Check the oven",
        runAt: now - 1,
      };
      const delivery = await root.commit(
        (tx) => tx.createTask(DeliverScheduledInstruction, scheduled, { background: true }),
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

  it("lets a recurring instruction schedule its next occurrence", async () => {
    const now = Date.now();
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("schedule", {
            instruction: "Check the oven",
            delaySeconds: 60,
            recurring: true,
            sourceScheduleId: "schedule:recurring",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Checked; the next check is scheduled.")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.tasks.add(DeliverScheduledInstruction);
    let schedulesCreated = 0;
    registry.tools.add(
      createScheduleTool(async () => {
        schedulesCreated++;
      }),
    );
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);

    try {
      const root = await harness.root(context);
      await root.setModel({ provider: "faux", modelId: "faux-1" }, context);
      await root.setActiveTools(["schedule"], context);
      const scheduled = {
        id: "schedule:recurring",
        conversationId: root.id,
        instruction: "Check the oven",
        runAt: now - 1,
        recurring: true as const,
      };
      const delivery = await root.commit(
        (tx) => tx.createTask(DeliverScheduledInstruction, scheduled, { background: true }),
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
        recurring: true,
      });
      expect(next.runAt).toBeGreaterThanOrEqual(now + 60_000);
      expect(await harness.snapshot(ScheduleDeliveries, context)).toEqual({ active: [] });
      expect(schedulesCreated).toBe(1);
      expect((await root.context(context)).messages).toEqual(
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

  it("plans one infrastructure alarm from delayed and active Harness tasks", async () => {
    const now = Date.now();
    const registry = createRegistry();
    registry.tasks.add(DeliverScheduledInstruction);
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
            { background: true },
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
