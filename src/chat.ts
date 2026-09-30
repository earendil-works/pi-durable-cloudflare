import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  ConversationConfig,
  type ConversationConfigState,
  type ConversationId,
  createRegistry,
  Harness,
  type Harness as PiHarness,
  type Storage,
  type Tx,
} from "@earendil-works/pi-durable";
import { DeliverScheduledInstruction } from "./schedule.ts";
import { RECALL_TOOL_NAME, recallTool, searchConversationsTool } from "./recall.ts";
import { createScheduleTool, getWeatherTool, SCHEDULE_TOOL_NAME } from "./tools.ts";

const models = createModels();
models.setProvider(openaiProvider());

export type ChatHarnessOptions = {
  readonly scheduleCreated: (runAt: number) => Promise<void>;
};

function createChatRegistry(options: ChatHarnessOptions) {
  const registry = createRegistry();
  registry.tasks.add(DeliverScheduledInstruction);
  registry.tools.add(getWeatherTool);
  registry.tools.add(createScheduleTool(options.scheduleCreated));
  registry.tools.add(recallTool);
  // Registered for recall's child conversations; not in any default loadout.
  registry.tools.add(searchConversationsTool);
  registry.systemPrompt.section("preamble", () => "You are a concise assistant.", { tag: false });
  registry.systemPrompt.section(
    "clock",
    // Minute precision: finer values would append a system-prompt delta on every request.
    () => `Current time: ${new Date().toISOString().slice(0, 16)}Z.`,
    { tag: false },
  );
  return registry;
}

export const DEFAULT_CONVERSATION_CONFIG = {
  model: { provider: "openai", modelId: "gpt-6-luna" },
  thinkingLevel: "off",
  activeTools: [getWeatherTool.name, SCHEDULE_TOOL_NAME, RECALL_TOOL_NAME],
} satisfies ConversationConfigState;

export async function initializeConversation(
  tx: Tx,
  conversationId: ConversationId,
): Promise<void> {
  Object.assign(await tx.doc(ConversationConfig, conversationId), DEFAULT_CONVERSATION_CONFIG);
}

/** Application-owned, platform-independent agent composition. */
export function openChatHarness(
  storage: Storage,
  context: Context,
  options: ChatHarnessOptions,
): Promise<PiHarness> {
  const registry = createChatRegistry(options);
  return Harness.open(
    storage,
    {
      models,
      registry,
      onReport: (error) =>
        console.error(
          JSON.stringify({
            message: "Harness background task failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
    },
    context,
  );
}
