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
import { conversationSearchExtension, searchHistoryTool } from "./search.ts";
import { createScheduleTool, getWeatherTool } from "./tools.ts";

const models = createModels();
models.setProvider(openaiProvider());

/** Application-owned, platform-independent agent composition. */
export function createChatHarnessOptions(
  ensureWakeupAt: (timestamp: number) => Promise<void>,
): HarnessOptions {
  const scheduleTool = createScheduleTool(ensureWakeupAt);
  const chatExtension = defineExtension({
    name: "chat",
    tasks: [DeliverScheduledInstruction],
    tools: [getWeatherTool, scheduleTool, searchHistoryTool],
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
  registry.install(conversationSearchExtension);
  const defaultAgent = {
    model: { provider: "openai", modelId: "gpt-6-luna" },
    thinkingLevel: "off" as const,
    tools: [getWeatherTool, scheduleTool, searchHistoryTool],
  };

  return {
    models,
    registry,
    settings: {
      extensions: [chatExtension],
      // Retention timers are active Durable Object references and prevent hibernation.
      documentRetentionMs: 0,
    },
    conversationCreated: (tx, conversation) =>
      conversation.owner === undefined && conversation.parent === undefined
        ? configure(tx, conversation.id, defaultAgent)
        : undefined,
  };
}
