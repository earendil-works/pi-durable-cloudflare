import type { JsonValue } from "@earendil-works/chord";

/**
 * Development-only type shim for the local pi-durable source dependency.
 *
 * pi-durable imports Message from pi-ai, whose source graph is not currently Worker-safe.
 * Remove this shim when switching back to a published pi-durable version.
 */
export type Message = {
  readonly role: "system" | "user" | "assistant" | "toolResult";
  readonly content: string | readonly JsonValue[];
  readonly timestamp: number;
} & Readonly<Record<string, JsonValue | undefined>>;
