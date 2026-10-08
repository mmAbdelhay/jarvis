// The catalog probe (os-models.yml): the root config's aliases, only this test.
import { defineConfig } from "vitest/config";
import root from "../../../vitest.config";

export default defineConfig({
  resolve: root.resolve,
  test: {
    include: ["os/models/probe/*.test.ts"],
    environment: "node",
    testTimeout: 900_000,
  },
});
