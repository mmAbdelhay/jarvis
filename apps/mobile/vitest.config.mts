import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Pinned explicitly: the gate command runs `vitest run --config
  // apps/mobile/vitest.config.mts` from the repo root, and `test.include`
  // is relative to `root`, not to the caller's cwd. `.mts` (not `.ts`)
  // so Vite's `configLoader: 'native'` sees genuine ESM instead of ESM
  // syntax loaded as CommonJS, which otherwise prints a warning on every
  // run of this gate.
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@jarvis/wire": fileURLToPath(new URL("../../packages/wire/src/index.ts", import.meta.url)),
      "@jarvis/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
