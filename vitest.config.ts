import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  ssr: {
    noExternal: ["@earendil-works/pi-durable", "@earendil-works/chord"],
    resolve: { conditions: ["source"] },
  },
});
