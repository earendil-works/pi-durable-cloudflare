import { type Context, isJsonValue } from "@earendil-works/chord";
import { createModels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  type ConversationConfigState,
  createRegistry,
  Harness,
  type Harness as PiHarness,
  type InputSubmissionDraft,
  type Storage,
} from "@earendil-works/pi-durable";

const models = createModels();
models.setProvider(openaiProvider());

const registry = createRegistry();
registry.systemPrompt.section("preamble", () => "You are a concise assistant.", { tag: false });

const thinkingLevels = new Set<string>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] satisfies ModelThinkingLevel[]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");

const isThinkingLevel = (value: unknown): value is ModelThinkingLevel =>
  typeof value === "string" && thinkingLevels.has(value);

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  isNonNegativeNumber(value) && Number.isSafeInteger(value);

const MAX_PROMPT_CHARACTERS = 100_000;
const MAX_REQUEST_ID_CHARACTERS = 256;

export class InvalidConfigurationError extends Error {}

export class InvalidPromptError extends Error {}

export type TextPrompt = Omit<InputSubmissionDraft, "content" | "whenBusy"> & {
  readonly content: string;
};

export function parseTextPrompt(value: unknown): TextPrompt {
  if (!isRecord(value) || value.type !== "input" || typeof value.content !== "string") {
    throw new InvalidPromptError("Prompt must be an input submission with text content");
  }
  if (value.content.length > MAX_PROMPT_CHARACTERS) {
    throw new InvalidPromptError(
      `Prompt content cannot exceed ${MAX_PROMPT_CHARACTERS} characters`,
    );
  }
  if (value.requestId !== undefined && typeof value.requestId !== "string") {
    throw new InvalidPromptError("requestId must be a string when present");
  }
  if (value.requestId !== undefined && value.requestId.length > MAX_REQUEST_ID_CHARACTERS) {
    throw new InvalidPromptError(`requestId cannot exceed ${MAX_REQUEST_ID_CHARACTERS} characters`);
  }
  if (value.whenBusy !== undefined) {
    throw new InvalidPromptError("whenBusy is not supported by this endpoint");
  }
  return {
    type: "input",
    content: value.content,
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
  };
}

export function parseConversationConfig(value: unknown): ConversationConfigState {
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

  let model: ConversationConfigState["model"];
  if (Object.hasOwn(value, "model")) {
    if (
      !isRecord(value.model) ||
      typeof value.model.provider !== "string" ||
      typeof value.model.modelId !== "string"
    ) {
      throw new InvalidConfigurationError(
        "model must contain provider and modelId strings when present",
      );
    }
    model = { provider: value.model.provider, modelId: value.model.modelId };
  }

  const streamOptions = parseStreamOptions(value.streamOptions);
  const retry = parseRetryPolicy(value.retry);
  return {
    ...(model === undefined ? {} : { model }),
    thinkingLevel: value.thinkingLevel,
    activeTools: value.activeTools,
    ...(streamOptions === undefined ? {} : { streamOptions }),
    ...(retry === undefined ? {} : { retry }),
  };
}

function parseStreamOptions(value: unknown): ConversationConfigState["streamOptions"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new InvalidConfigurationError("streamOptions must be an object");

  if (
    value.transport !== undefined &&
    value.transport !== "sse" &&
    value.transport !== "websocket" &&
    value.transport !== "websocket-cached" &&
    value.transport !== "auto"
  ) {
    throw new InvalidConfigurationError("streamOptions.transport is invalid");
  }
  if (value.timeoutMs !== undefined && !isNonNegativeNumber(value.timeoutMs)) {
    throw new InvalidConfigurationError("streamOptions.timeoutMs must be non-negative");
  }
  if (value.maxRetries !== undefined && !isNonNegativeInteger(value.maxRetries)) {
    throw new InvalidConfigurationError("streamOptions.maxRetries must be a non-negative integer");
  }
  if (value.maxRetryDelayMs !== undefined && !isNonNegativeNumber(value.maxRetryDelayMs)) {
    throw new InvalidConfigurationError("streamOptions.maxRetryDelayMs must be non-negative");
  }
  if (value.headers !== undefined && !isStringRecord(value.headers)) {
    throw new InvalidConfigurationError("streamOptions.headers must contain string values");
  }
  if (value.metadata !== undefined && (!isRecord(value.metadata) || !isJsonValue(value.metadata))) {
    throw new InvalidConfigurationError("streamOptions.metadata must be a JSON object");
  }
  if (
    value.cacheRetention !== undefined &&
    value.cacheRetention !== "none" &&
    value.cacheRetention !== "short" &&
    value.cacheRetention !== "long"
  ) {
    throw new InvalidConfigurationError("streamOptions.cacheRetention is invalid");
  }
  let deferred: NonNullable<ConversationConfigState["streamOptions"]>["deferred"];
  if (typeof value.deferred === "boolean") deferred = value.deferred;
  else if (value.deferred !== undefined) {
    if (!isRecord(value.deferred) || Object.keys(value.deferred).some((key) => key !== "window")) {
      throw new InvalidConfigurationError("streamOptions.deferred is invalid");
    }
    const window = value.deferred.window;
    if (window !== undefined && window !== "15m" && window !== "1h" && window !== "24h") {
      throw new InvalidConfigurationError("streamOptions.deferred is invalid");
    }
    deferred = window === undefined ? {} : { window };
  }

  return {
    ...(value.transport === undefined ? {} : { transport: value.transport }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    ...(value.maxRetries === undefined ? {} : { maxRetries: value.maxRetries }),
    ...(value.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: value.maxRetryDelayMs }),
    ...(value.headers === undefined ? {} : { headers: value.headers }),
    ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
    ...(value.cacheRetention === undefined ? {} : { cacheRetention: value.cacheRetention }),
    ...(deferred === undefined ? {} : { deferred }),
  };
}

function parseRetryPolicy(value: unknown): ConversationConfigState["retry"] | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.enabled !== "boolean" ||
    !isNonNegativeInteger(value.maxRetries) ||
    !isNonNegativeNumber(value.baseDelayMs) ||
    (value.maxAgentDelayMs !== undefined && !isNonNegativeNumber(value.maxAgentDelayMs))
  ) {
    throw new InvalidConfigurationError("retry must contain a valid durable retry policy");
  }
  return {
    enabled: value.enabled,
    maxRetries: value.maxRetries,
    baseDelayMs: value.baseDelayMs,
    ...(value.maxAgentDelayMs === undefined ? {} : { maxAgentDelayMs: value.maxAgentDelayMs }),
  };
}

/** Application-owned, platform-independent agent composition. */
export function openChatHarness(storage: Storage, context: Context): Promise<PiHarness> {
  return Harness.open(
    storage,
    {
      models,
      registry,
      onReport: (error) => console.error("Harness background task failed", error),
    },
    context,
  );
}

function assertRegisteredTools(names: readonly string[]): void {
  if (new Set(names).size !== names.length) {
    throw new InvalidConfigurationError("activeTools must not contain duplicates");
  }
  const registered = new Set(registry.snapshot().toolNames());
  const missing = names.filter((name) => !registered.has(name));
  if (missing.length > 0) {
    throw new InvalidConfigurationError(`Tools are not registered: ${missing.join(", ")}`);
  }
}
