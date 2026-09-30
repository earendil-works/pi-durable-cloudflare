import { Type } from "@earendil-works/pi-ai";
import { defineDoc, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  DeliverScheduledInstruction,
  type ScheduledInstruction,
  ScheduleDeliveries,
} from "./schedule.ts";
import { MAX_PROMPT_CHARACTERS } from "./protocol.ts";

const WEATHER_CONDITIONS = ["sunny", "partly cloudy", "overcast", "light rain"] as const;

export const getWeatherTool = {
  name: "get_weather",
  description: "Get the current weather for a location. Use when the user asks about the weather.",
  parameters: Type.Object({
    location: Type.String({ description: "The city or location to check weather for" }),
  }),
  replay: "safe",
  execute: async ({ location }: { location: string }) => {
    const condition = WEATHER_CONDITIONS[Math.floor(Math.random() * WEATHER_CONDITIONS.length)];
    const temperature = Math.floor(55 + Math.random() * 35);
    const weather = {
      location,
      temperature: `${temperature}°F`,
      condition,
      note: "Mock data; connect a weather MCP server for real forecasts.",
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(weather) }],
      details: weather,
    };
  },
} satisfies ToolRegistration;

export const SCHEDULE_TOOL_NAME = "schedule";

const MAX_DELAY_SECONDS = 366 * 24 * 60 * 60;
const TIMEZONE_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})$/i;

/** The schedule a tool task created, so a safe replay returns it instead of creating another. */
const ScheduleIntent = defineDoc<{ scheduled?: ScheduledInstruction }>({
  kind: "app.schedule-intent",
  version: 1,
  scope: "task",
  initial: () => ({}),
});

type ScheduleArguments = {
  readonly instruction: string;
  readonly delaySeconds?: number;
  readonly at?: string;
  readonly recurring?: boolean;
  readonly sourceScheduleId?: string;
};

function resolveRunAt({ delaySeconds, at }: ScheduleArguments, now: number): number {
  if ((delaySeconds === undefined) === (at === undefined)) {
    throw new Error("Provide exactly one of delaySeconds or at");
  }
  if (delaySeconds !== undefined) return now + delaySeconds * 1000;
  const runAt = TIMEZONE_SUFFIX.test(at!) ? Date.parse(at!) : Number.NaN;
  if (!Number.isFinite(runAt)) {
    throw new Error("at must be an ISO 8601 date-time with a timezone offset");
  }
  if (runAt <= now) throw new Error("at must be in the future");
  if (runAt > now + MAX_DELAY_SECONDS * 1000) throw new Error("at is too far in the future");
  return runAt;
}

const scheduleResult = (scheduled: ScheduledInstruction, now: number) => {
  const runAt = new Date(scheduled.runAt).toISOString();
  const seconds = Math.max(0, Math.round((scheduled.runAt - now) / 1000));
  return {
    content: [
      {
        type: "text" as const,
        text: `Scheduled. At ${runAt} (in ${seconds} seconds) this conversation will receive: ${JSON.stringify(scheduled.instruction)}. Nothing further is needed now.`,
      },
    ],
    details: {
      id: scheduled.id,
      instruction: scheduled.instruction,
      runAt,
      ...(scheduled.recurring === true ? { recurring: true } : {}),
    },
  };
};

export function createScheduleTool(
  scheduleCreated: (runAt: number) => Promise<void>,
): ToolRegistration {
  return {
    name: SCHEDULE_TOOL_NAME,
    description:
      "Schedule an instruction to be delivered to this conversation at a later time. The conversation resumes then with the instruction as its input and carries it out with its normal tools. Use this whenever the user wants something to happen later; scheduling is the complete response to such a request.",
    parameters: Type.Object({
      instruction: Type.String({
        minLength: 1,
        maxLength: MAX_PROMPT_CHARACTERS,
        description:
          "What to do when the schedule fires, phrased as a self-contained request without timing words, e.g. 'Check the weather in London'",
      }),
      delaySeconds: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_DELAY_SECONDS,
          description:
            "Run after this many seconds. Use for relative times such as 'in 10 minutes'",
        }),
      ),
      at: Type.Optional(
        Type.String({
          description:
            "Run at this ISO 8601 date-time with a timezone offset, e.g. 2026-10-01T09:00:00+02:00. Use for absolute times; provide exactly one of delaySeconds or at",
        }),
      ),
      recurring: Type.Optional(
        Type.Boolean({
          description:
            "Set true only when the user explicitly asked for a repeating schedule; each delivery then schedules its own next occurrence",
        }),
      ),
      sourceScheduleId: Type.Optional(
        Type.String({
          description:
            "When scheduling the next occurrence of a recurring instruction, the schedule ID given in its delivery",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args: ScheduleArguments, api, context) => {
      const existing = (await api.snapshot(ScheduleIntent, api.taskId, context))?.scheduled;
      if (existing !== undefined) {
        await scheduleCreated(existing.runAt);
        return scheduleResult(existing, Date.now());
      }

      const deliveries = await api.snapshot(ScheduleDeliveries, context);
      const activeDeliveries =
        deliveries?.active.filter(({ conversationId }) => conversationId === api.conversationId) ??
        [];
      const source = activeDeliveries.find(
        ({ scheduleId }) => scheduleId === args.sourceScheduleId,
      );
      if (activeDeliveries.length > 0 && !(source?.recurring === true && args.recurring === true)) {
        throw new Error(
          "schedule may run during a scheduled delivery only to schedule the next occurrence of a recurring instruction",
        );
      }

      const now = Date.now();
      const scheduled: ScheduledInstruction = {
        id: `schedule:${api.taskId}`,
        conversationId: api.conversationId,
        instruction: args.instruction,
        runAt: resolveRunAt(args, now),
        ...(args.recurring === true ? { recurring: true } : {}),
      };
      const persisted = await api.commit(async (tx) => {
        const intent = await tx.doc(ScheduleIntent, api.taskId);
        if (intent.scheduled !== undefined) return intent.scheduled;
        await tx.createTask(DeliverScheduledInstruction, scheduled, {
          conversationId: api.conversationId,
          background: true,
        });
        intent.scheduled = scheduled;
        return scheduled;
      }, context);
      await scheduleCreated(persisted.runAt);
      return scheduleResult(persisted, now);
    },
  };
}
