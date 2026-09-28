import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Core } from "./compose.js";
import { type CoreClient, inProcessCoreClient } from "./core-client.js";

// Task 19's JSON round-trip mode, against the REAL dispatch table: a core
// built by createCore under a scratch HOME (never the user's
// ~/.config/jarvis), wrapped with { roundTrip: true }, so every result below
// is checked against the JSON-only contract — what jarvisd's control socket
// will carry — and fails here, with the offending path, if it isn't.

const originalHome = process.env.HOME;
let home: string;
let core: Core;
let client: CoreClient;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "jarvis-json-"));
  // Before compose.ts (and config.ts's module-level homedir() paths) load.
  process.env.HOME = home;
  // The default config, plus one project for the terminal to open in.
  const { DEFAULT_CONFIG_PATH, ensureConfigFile } = await import("../config.js");
  // Never the user's own config: config.ts must have loaded after the swap.
  if (!DEFAULT_CONFIG_PATH.startsWith(home))
    throw new Error("config.ts loaded before HOME was set");
  await ensureConfigFile(DEFAULT_CONFIG_PATH);
  await appendFile(DEFAULT_CONFIG_PATH, `\nprojects:\n  scratch: ${JSON.stringify(home)}\n`);
  const { createCore } = await import("./compose.js");
  // The core's own start-up lines (no Piper, no transcripts under a scratch
  // HOME) are expected here and not the test's output.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  core = await createCore({ platform: process.platform, webExportDir: () => join(home, "web") });
  client = inProcessCoreClient(core, { roundTrip: true });
}, 60_000);

afterAll(async () => {
  await core?.shutdown();
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

describe("the real dispatch table's results are JSON values", () => {
  it.each([
    ["settings:read", []],
    ["sessions:list", []],
    ["history:list", []],
    ["workspace:snapshot", []],
    ["remote:status", []],
    ["remote:ownerStatus", []],
    ["remote:bindChoices", []],
    ["bookmarks:list", []],
    ["terminal:settings", []],
  ] as const)("%s", async (channel, args) => {
    await expect(client.invoke(channel, [...args])).resolves.toBeDefined();
  });

  it("terminal:open, then terminal:panes and terminal:snapshot for the live pane", async () => {
    const opened = await client.invoke("terminal:open", ["scratch"]);
    const snapshot = (await client.invoke("workspace:snapshot", [])) as {
      tabs: Array<{ id: string; kind: string }>;
    };
    const terminal = snapshot.tabs.find((tab) => tab.kind === "terminal");
    expect(terminal, JSON.stringify(opened)).toBeDefined();
    const panes = (await client.invoke("terminal:panes", [terminal?.id])) as Array<{
      paneKey: string;
    }>;
    expect(panes.length).toBeGreaterThan(0);
    await expect(client.invoke("terminal:snapshot", [panes[0]?.paneKey])).resolves.toMatchObject({
      end: expect.any(Number),
    });
    // hostConfig and the tab state cross the same way.
    expect(client.hostConfig()).toEqual(core.hostConfig());
    expect(client.workspace.state().tabs.length).toBe(snapshot.tabs.length);
  });
});
