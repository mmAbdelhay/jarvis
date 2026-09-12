import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@jarvis/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@jarvis/platform": fileURLToPath(
        new URL("./packages/platform/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/renderer/**/*.test.ts"],
    environment: "node",
    // Runs in every environment, and does nothing outside jsdom. See the
    // file for why xterm cannot be constructed in a jsdom test without it.
    setupFiles: ["./vitest.setup.ts"],
  },
});
