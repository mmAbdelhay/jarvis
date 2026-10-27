import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "@jarvis/core";
import type { ExternalAgentProcess } from "@jarvis/platform";
import { createPaneClaudeLookup, type PaneClaudeLookupDeps } from "./pane-claude-session.js";

const AGENTS: AgentConfig[] = [
  { id: "claude", command: "claude", vendor: "anthropic", configDir: "/h/.claude-main" },
  { id: "codex", command: "codex", vendor: "openai" },
];
const SESSIONS = join("/h/.claude-main", "sessions");
const PROJECTS = join("/h/.claude-main", "projects");
const TRANSCRIPT = join(PROJECTS, "-w", "s1.jsonl");

function world() {
  const files = new Map<string, string>([
    [join(SESSIONS, "101.json"), JSON.stringify({ pid: 101, sessionId: "s1", name: "topic" })],
  ]);
  let listings = 0;
  const deps: PaneClaudeLookupDeps = {
    agents: () => AGENTS,
    home: "/h",
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    listTranscripts: async () => {
      listings++;
      return [
        { path: join(PROJECTS, "-w", "other.jsonl"), mtime: 1 },
        { path: TRANSCRIPT, mtime: 1 },
      ];
    },
  };
  return { deps, files, listings: () => listings };
}

function processOf(overrides: Partial<ExternalAgentProcess> = {}): ExternalAgentProcess {
  return {
    pid: 101,
    agentId: "claude",
    command: "claude",
    cwd: "/w",
    startedAt: 0,
    terminalPaneKey: "t1",
    ...overrides,
  };
}

describe("createPaneClaudeLookup", () => {
  it("resolves session id, name and transcript path for an anthropic pane process", async () => {
    const lookup = createPaneClaudeLookup(world().deps);
    await expect(lookup.forProcess(processOf())).resolves.toEqual({
      paneKey: "t1",
      pid: 101,
      sessionId: "s1",
      name: "topic",
      transcriptPath: TRANSCRIPT,
      cwd: "/w",
      transcriptsDir: PROJECTS,
    });
  });

  it("undefined for non-anthropic agent", async () => {
    const w = world();
    const lookup = createPaneClaudeLookup(w.deps);
    await expect(lookup.forProcess(processOf({ agentId: "codex" }))).resolves.toBeUndefined();
    expect(w.listings()).toBe(0);
  });

  it("undefined when pid file missing", async () => {
    const lookup = createPaneClaudeLookup(world().deps);
    await expect(lookup.forProcess(processOf({ pid: 202 }))).resolves.toBeUndefined();
  });

  it("undefined for a process outside any pane", async () => {
    const lookup = createPaneClaudeLookup(world().deps);
    await expect(
      lookup.forProcess(processOf({ terminalPaneKey: undefined })),
    ).resolves.toBeUndefined();
  });

  it("caches transcript path", async () => {
    const w = world();
    const lookup = createPaneClaudeLookup(w.deps);
    await lookup.forProcess(processOf());
    const second = await lookup.forProcess(processOf());
    expect(second?.transcriptPath).toBe(TRANSCRIPT);
    expect(w.listings()).toBe(1);

    lookup.forget(new Set(["s1"]));
    await lookup.forProcess(processOf());
    expect(w.listings()).toBe(2); // forgotten, so looked up again
  });
});
