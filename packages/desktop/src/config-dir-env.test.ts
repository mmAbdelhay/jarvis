import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Jarvis Workspace on Rafiq runs with JARVIS_CONFIG_DIR set by its wrapper
// (M4 contracts §6.16): every file the app keeps must move with it, so it
// never reads or writes jarvisd's jarvis.yaml, logs or run directory.
describe("config.ts under JARVIS_CONFIG_DIR", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("puts jarvis.yaml and Jarvis's own bookkeeping in that directory", async () => {
    const dir = join("/", "tmp", "jarvis-workspace-test");
    vi.stubEnv("JARVIS_CONFIG_DIR", dir);
    vi.resetModules();
    const config = await import("./config.js");
    expect(config.DEFAULT_CONFIG_PATH).toBe(join(dir, "jarvis.yaml"));
    expect(config.defaultConfigDir()).toBe(dir);
    expect(config.defaultSessionsDbPath()).toBe(join(dir, "sessions.db"));
    expect(config.defaultSessionsScanPath()).toBe(join(dir, "sessions-scan.json"));
    expect(config.defaultWorkflowsDir()).toBe(join(dir, "workflows"));
  });
});
