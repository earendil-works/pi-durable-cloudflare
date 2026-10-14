import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    // Workerd cannot read Vitest 5's host-filesystem module cache.
    fsModuleCache: false,
    reporters: ["verbose"],
    benchmark: {
      include: ["test/**/*.bench.ts"],
    },
  },
});
