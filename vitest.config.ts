import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workerd cannot read Vitest 5's host-filesystem module cache.
  test: { fsModuleCache: false },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { OPENAI_API_KEY: "test-openai-key" } },
    }),
  ],
});
