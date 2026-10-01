import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  configure,
  createRegistry,
  defineExtension,
  section,
  type HarnessOptions,
} from "@earendil-works/pi-durable";
import { DeliverScheduledInstruction } from "./schedule.ts";
import { recallSearchExtension, recallTool } from "./recall.ts";
import { createScheduleTool, getWeatherTool } from "./tools.ts";

const models = createModels();
models.setProvider(openaiProvider());

export type ChatHarnessOptions = {
  readonly scheduleCreated: (runAt: number) => Promise<void>;
};

const createChatRegistry = (options: ChatHarnessOptions) => {
  const scheduleTool = createScheduleTool(options.scheduleCreated);
  const chatExtension = defineExtension({
    name: "chat",
    tasks: [DeliverScheduledInstruction],
    tools: [getWeatherTool, scheduleTool, recallTool],
    sections: [
      section(
        "preamble",
        () =>
          "You are a concise assistant. User messages may begin with a display name in brackets; treat it as speaker attribution.",
        { tag: false },
      ),
      section(
        "clock",
        // Minute precision: finer values would append a system-prompt delta on every request.
        () => `Current time: ${new Date().toISOString().slice(0, 16)}Z.`,
        { tag: false },
      ),
    ],
  });
  const registry = createRegistry();
  registry.install(chatExtension);
  registry.install(recallSearchExtension);
  return {
    registry,
    chatExtension,
    defaultAgent: {
      model: { provider: "openai", modelId: "gpt-6-luna" },
      thinkingLevel: "off" as const,
      tools: [getWeatherTool, scheduleTool, recallTool],
    },
  };
};

/** Application-owned, platform-independent agent composition. */
export function createChatHarnessOptions(options: ChatHarnessOptions): HarnessOptions {
  const { registry, chatExtension, defaultAgent } = createChatRegistry(options);
  return {
    models,
    registry,
    settings: { extensions: [chatExtension] },
    conversationCreated: (tx, conversation) =>
      conversation.owner === undefined && conversation.parent === undefined
        ? configure(tx, conversation.id, defaultAgent)
        : undefined,
    onReport: (error) =>
      console.error(
        JSON.stringify({
          message: "Harness background task failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
  };
}
