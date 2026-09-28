import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  type Harness as PiHarness,
  type Storage,
} from "@earendil-works/pi-durable";

const models = createModels();
const registry = createRegistry();

export class InvalidConfigurationError extends Error {}

/** Application-owned, platform-independent agent composition. */
export function openAgentHarness(storage: Storage, context: Context): Promise<PiHarness> {
  return Harness.open(storage, { models, registry }, context);
}

export function assertRegisteredTools(names: readonly string[]): void {
  if (new Set(names).size !== names.length) {
    throw new InvalidConfigurationError("activeTools must not contain duplicates");
  }
  const registered = new Set(registry.snapshot().toolNames());
  const missing = names.filter((name) => !registered.has(name));
  if (missing.length > 0) {
    throw new InvalidConfigurationError(`Tools are not registered: ${missing.join(", ")}`);
  }
}
