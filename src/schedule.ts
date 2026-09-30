import {
  type ConversationId,
  defineDoc,
  defineTask,
  type TaskId,
  type TaskInspection,
} from "@earendil-works/pi-durable";
import { formatScheduledInstruction } from "./protocol.ts";

/** Durable input of one scheduled delivery. */
export type ScheduledInstruction = {
  readonly id: string;
  readonly conversationId: ConversationId;
  readonly instruction: string;
  /** Unix timestamp in milliseconds. */
  readonly runAt: number;
  readonly recurring?: true;
};

type DeliveryState = { phase: "wait" } | { phase: "deliver" };

/** Deliveries currently running, so `schedule` can reject accidental recursion. */
export const ScheduleDeliveries = defineDoc<{
  active: Array<{
    scheduleId: string;
    conversationId: ConversationId;
    recurring?: true;
  }>;
}>({
  kind: "app.schedule-deliveries",
  version: 1,
  scope: "session",
  initial: () => ({ active: [] }),
});

export const DeliverScheduledInstruction = defineTask<ScheduledInstruction, DeliveryState, null>({
  name: "app.deliver-scheduled-instruction",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      await runtime.sleep(task.input.runAt, context);
      await runtime.commit(async (tx) => {
        const deliveries = await tx.doc(ScheduleDeliveries);
        if (!deliveries.active.some(({ scheduleId }) => scheduleId === task.input.id)) {
          deliveries.active.push({
            scheduleId: task.input.id,
            conversationId: task.input.conversationId,
            ...(task.input.recurring === true ? { recurring: true as const } : {}),
          });
        }
        return { status: "running", checkpoint: { phase: "deliver" } };
      }, context);
    },
    deliver: async (task, runtime, context) => {
      const conversation = await runtime.conversation(task.input.conversationId, context);
      if (conversation !== undefined) {
        const submission = await conversation.submit(
          {
            type: "input",
            content: formatScheduledInstruction(task.input),
            requestId: task.input.id,
            whenBusy: "followUp",
          },
          context,
        );
        await submission.wait(context);
      } else {
        runtime.report(
          new Error(
            `Scheduled instruction ${task.input.id} conversation ${task.input.conversationId} is missing`,
          ),
        );
      }

      await runtime.commit(async (tx) => {
        removeDelivery(await tx.doc(ScheduleDeliveries), task.input.id);
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: async (task, runtime, context) => {
    await runtime.commit(async (tx) => {
      removeDelivery(await tx.doc(ScheduleDeliveries), task.input.id);
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  },
});

const removeDelivery = (
  deliveries: { active: Array<{ scheduleId: string }> },
  scheduleId: string,
): void => {
  const index = deliveries.active.findIndex((delivery) => delivery.scheduleId === scheduleId);
  if (index !== -1) deliveries.active.splice(index, 1);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Deadline of a delivery task that is still waiting, or `undefined` for other tasks. */
export function scheduledDeadline(task: TaskInspection): number | undefined {
  if (task.record.kind !== DeliverScheduledInstruction.definition.name) return undefined;
  if (task.record.state.status === "completing" || task.record.state.status === "terminal") {
    return undefined;
  }
  if (!isRecord(task.record.input) || !isRecord(task.record.state.checkpoint)) {
    throw new Error(`Scheduled instruction task ${task.record.id} has invalid durable state`);
  }
  const runAt = task.record.input.runAt;
  if (!Number.isSafeInteger(runAt) || (runAt as number) < 0) {
    throw new Error(`Scheduled instruction task ${task.record.id} has an invalid runAt`);
  }
  const phase = task.record.state.checkpoint.phase;
  if (phase === "wait") return runAt as number;
  if (phase === "deliver") return undefined;
  throw new Error(`Scheduled instruction task ${task.record.id} has an invalid phase`);
}

export type HarnessAlarmPlan = {
  readonly nextDeadline?: number;
  readonly recoveryTasks: readonly TaskId[];
};

/** Project live Harness tasks onto the Durable Object's single platform alarm. */
export function planHarnessAlarm(tasks: readonly TaskInspection[], now: number): HarnessAlarmPlan {
  let nextDeadline: number | undefined;
  const recoveryTasks: TaskId[] = [];

  for (const task of tasks) {
    if (task.state.kind === "blocked") continue;
    const deadline = scheduledDeadline(task);
    if (deadline !== undefined && deadline > now && !task.record.abortRequested) {
      nextDeadline = nextDeadline === undefined ? deadline : Math.min(nextDeadline, deadline);
    } else {
      recoveryTasks.push(task.record.id);
    }
  }

  return {
    ...(nextDeadline === undefined ? {} : { nextDeadline }),
    recoveryTasks,
  };
}
