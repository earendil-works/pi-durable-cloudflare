import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it } from "vitest";

registerStorageConformance(
  { describe, expect, it },
  "Cloudflare Durable Object SQLite",
  async (use) => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, async (_instance, state) => {
      await use(await openDurableObjectSqliteStorage(state.storage));
    });
  },
);
