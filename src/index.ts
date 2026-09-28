import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConversationConfigState } from "@earendil-works/pi-durable";
import { assertRegisteredTools, InvalidConfigurationError } from "./agent.ts";

export { Session } from "./session.ts";

const route = /^\/session\/([^/]+)\/?$/;
const thinkingLevels = new Set<string>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] satisfies ModelThinkingLevel[]);

const isThinkingLevel = (value: unknown): value is ModelThinkingLevel =>
  typeof value === "string" && thinkingLevels.has(value);

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function parseConversationConfig(request: Request): Promise<ConversationConfigState> {
  const value: unknown = await request.json();
  if (!isRecord(value)) {
    throw new InvalidConfigurationError("Conversation configuration must be an object");
  }
  if (!isThinkingLevel(value.thinkingLevel)) {
    throw new InvalidConfigurationError(
      "Conversation configuration requires a valid thinkingLevel",
    );
  }
  if (
    !Array.isArray(value.activeTools) ||
    !value.activeTools.every((name): name is string => typeof name === "string")
  ) {
    throw new InvalidConfigurationError(
      "Conversation configuration requires an activeTools string array",
    );
  }
  assertRegisteredTools(value.activeTools);

  if (!Object.hasOwn(value, "model")) {
    return { thinkingLevel: value.thinkingLevel, activeTools: value.activeTools };
  }
  if (
    !isRecord(value.model) ||
    typeof value.model.provider !== "string" ||
    typeof value.model.modelId !== "string"
  ) {
    throw new InvalidConfigurationError(
      "model must contain provider and modelId strings when present",
    );
  }
  return {
    model: { provider: value.model.provider, modelId: value.model.modelId },
    thinkingLevel: value.thinkingLevel,
    activeTools: value.activeTools,
  };
}

// This is a small test surface. A future POST /session/:id/prompt should use
// durable submissions once the Harness implements the turn-execution loop.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = route.exec(new URL(request.url).pathname);
    if (match === null) return json({ error: "Not found" }, 404);

    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return json({ error: "Invalid session ID" }, 400);
    }

    const stub = env.SESSIONS.getByName(id);
    if (request.method === "GET") {
      const config = await stub.getConfig();
      return config === undefined ? json({ error: "Session not found" }, 404) : json(config, 200);
    }
    if (request.method === "PUT") {
      let config: ConversationConfigState;
      try {
        config = await parseConversationConfig(request);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof InvalidConfigurationError))
          throw error;
        return json({ error: error.message }, 400);
      }
      return json(await stub.setConfig(config), 200);
    }
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, PUT" });
  },
} satisfies ExportedHandler<Env>;
