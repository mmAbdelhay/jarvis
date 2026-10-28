import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfig, WorkspaceState, WorkspaceTab } from "@jarvis/core";
import type { ExternalAgentProcess, ShellExit, ShellOutput } from "@jarvis/platform";
import {
  SESSION_TAB_DEBOUNCE_MS,
  SESSION_TAB_RECHECK_MS,
  createSessionTabNamer,
  type SessionTabNameDeps,
} from "./session-tab-name.js";

const HOME = "/h";
const AGENTS: AgentConfig[] = [
  { id: "claude", command: "claude", vendor: "anthropic", configDir: "/h/.claude-main" },
  { id: "codex", command: "codex", vendor: "openai" },
];
const SESSIONS = join("/h/.claude-main", "sessions");
const PROJECTS = join("/h/.claude-main", "projects");
/** When the namer was created; processes default to starting after it. */
const NOW = 1_000_000;

function tab(id: string, customTitle?: string): WorkspaceTab {
  return {
    id,
    project: "p",
    url: "",
    kind: "terminal",
    title: "zsh",
    ...(customTitle === undefined ? {} : { customTitle }),
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: undefined,
    hasPlayingVideo: false,
    pageFullscreen: false,
    suspended: false,
  };
}

function pidFile(pid: number, sessionId: string, name?: string): string {
  return JSON.stringify({
    pid,
    sessionId,
    cwd: "/w",
    ...(name === undefined ? {} : { name, nameSource: "auto" }),
    status: "idle",
  });
}

function world() {
  const files = new Map<string, string>();
  const transcripts: { path: string; mtime: number }[] = [];
  let processes: ExternalAgentProcess[] = [];
  const state: WorkspaceState = { tabs: [tab("t1"), tab("t2")], activeTabId: "t1" };
  const renames: [string, string][] = [];
  const panes = [
    { paneKey: "t1", exited: false },
    { paneKey: "t2", exited: false },
  ];
  const watchers = new Map<string, { onChange: () => void; closed: boolean }>();
  const timers = new Set<{ fn: () => void; ms: number; repeat: boolean }>();
  const outputListeners = new Set<(o: ShellOutput) => void>();
  const exitListeners = new Set<(e: ShellExit) => void>();
  let scans = 0;
  let listings = 0;

  const deps: SessionTabNameDeps = {
    shells: {
      panes: () => panes,
      onOutput: (listener) => {
        outputListeners.add(listener);
        return () => outputListeners.delete(listener);
      },
      onShellExit: (listener) => {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
    },
    tabs: {
      state: () => state,
      rename: (id, title) => {
        renames.push([id, title]);
        state.tabs = state.tabs.map((t) => (t.id === id ? { ...t, customTitle: title } : t));
      },
    },
    scanAgents: async () => {
      scans++;
      return processes;
    },
    agents: () => AGENTS,
    home: HOME,
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    listTranscripts: async () => {
      listings++;
      return transcripts;
    },
    now: () => NOW,
    readHead: async () => "",
    readTail: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    watch: (dir, onChange) => {
      const entry = { onChange, closed: false };
      watchers.set(dir, entry);
      return {
        close: () => {
          entry.closed = true;
        },
      };
    },
    schedule: (fn, ms) => {
      const timer = { fn, ms, repeat: false };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    interval: (fn, ms) => {
      const timer = { fn, ms, repeat: true };
      timers.add(timer);
      return () => timers.delete(timer);
    },
  };

  const claudeIn = (paneKey: string, pid: number, foreground = true): ExternalAgentProcess => ({
    pid,
    agentId: "claude",
    command: "claude",
    cwd: "/w",
    startedAt: NOW + 1_000,
    terminalPaneKey: paneKey,
    foreground,
  });

  return {
    deps,
    files,
    transcripts,
    state,
    renames,
    panes,
    watchers,
    timers,
    outputListeners,
    exitListeners,
    scans: () => scans,
    listings: () => listings,
    setProcesses: (next: ExternalAgentProcess[]) => {
      processes = next;
    },
    claudeIn,
    /** Runs every pending one-shot timer whose delay is `ms`. */
    fire: (ms: number) => {
      for (const timer of [...timers]) {
        if (timer.ms !== ms) continue;
        if (!timer.repeat) timers.delete(timer);
        timer.fn();
      }
    },
  };
}

describe("session tab namer", () => {
  it("renames the pane's tab to its Claude session's name", async () => {
    const w = world();
    w.setProcesses([w.claudeIn("t1", 101)]);
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "fix-login"));
    const namer = createSessionTabNamer(w.deps);

    await namer.check();

    expect(w.renames).toEqual([["t1", "fix-login"]]);
  });

  it("leaves a tab named after a PR alone", async () => {
    const w = world();
    w.setProcesses([w.claudeIn("t1", 101)]);
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "fix-login"));

    await createSessionTabNamer({ ...w.deps, isPrNamedTab: (id) => id === "t1" }).check();

    expect(w.renames).toEqual([]);
  });

  it("maps a split pane to its tab", async () => {
    const w = world();
    w.panes.push({ paneKey: "t2:2", exited: false });
    w.setProcesses([w.claudeIn("t2:2", 102)]);
    w.files.set(join(SESSIONS, "102.json"), pidFile(102, "s2", "split"));

    await createSessionTabNamer(w.deps).check();

    expect(w.renames).toEqual([["t2", "split"]]);
  });

  it("renames again when the session is renamed", async () => {
    const w = world();
    w.setProcesses([w.claudeIn("t1", 101)]);
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "fix-login"));
    const namer = createSessionTabNamer(w.deps);
    await namer.check();

    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "PR 42 review"));
    await namer.check();

    expect(w.renames).toEqual([
      ["t1", "fix-login"],
      ["t1", "PR 42 review"],
    ]);
  });

  it("keeps a name the user gave the tab until the session name changes", async () => {
    const w = world();
    w.setProcesses([w.claudeIn("t1", 101)]);
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "fix-login"));
    const namer = createSessionTabNamer(w.deps);
    await namer.check();

    w.deps.tabs.rename("t1", "mine");
    w.renames.length = 0;
    await namer.check();
    expect(w.renames).toEqual([]);
    expect(w.state.tabs[0]?.customTitle).toBe("mine");

    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "next topic"));
    await namer.check();
    expect(w.renames).toEqual([["t1", "next topic"]]);
  });

  it("applies a new session's name in the same pane, and leaves the tab when Claude exits", async () => {
    const w = world();
    w.setProcesses([w.claudeIn("t1", 101)]);
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "topic"));
    const namer = createSessionTabNamer(w.deps);
    await namer.check();

    w.setProcesses([]);
    await namer.check();
    expect(w.renames).toEqual([["t1", "topic"]]);

    w.deps.tabs.rename("t1", "mine");
    w.renames.length = 0;
    w.setProcesses([w.claudeIn("t1", 202)]);
    w.files.set(join(SESSIONS, "202.json"), pidFile(202, "s9", "topic"));
    await namer.check();
    expect(w.renames).toEqual([["t1", "topic"]]);
  });

  it("never touches a pane with no agent, a Codex agent, or a background job", async () => {
    const w = world();
    w.setProcesses([
      { ...w.claudeIn("t1", 101), agentId: "codex", command: "codex" },
      w.claudeIn("t2", 102, false),
      { ...w.claudeIn("t1", 103), terminalPaneKey: undefined },
    ]);
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "a"));
    w.files.set(join(SESSIONS, "102.json"), pidFile(102, "s2", "b"));
    w.files.set(join(SESSIONS, "103.json"), pidFile(103, "s3", "c"));

    await createSessionTabNamer(w.deps).check();

    expect(w.renames).toEqual([]);
  });

  it("skips a missing, partial or someone else's pid file without throwing", async () => {
    const w = world();
    w.panes.push({ paneKey: "t1:2", exited: false });
    w.setProcesses([w.claudeIn("t1", 101), w.claudeIn("t2", 102), w.claudeIn("t1:2", 103)]);
    w.files.set(join(SESSIONS, "102.json"), '{"pid":102,"sessionId":"s2","na');
    w.files.set(join(SESSIONS, "103.json"), pidFile(999, "s3", "stale"));

    await expect(createSessionTabNamer(w.deps).check()).resolves.toBeUndefined();

    expect(w.renames).toEqual([]);
  });

  it("survives a scan that rejects", async () => {
    const w = world();
    w.deps.scanAgents = async () => {
      throw new Error("ps failed");
    };
    await expect(createSessionTabNamer(w.deps).check()).resolves.toBeUndefined();
  });

  it("falls back to the transcript's /rename title when the pid file has no name", async () => {
    const w = world();
    w.setProcesses([w.claudeIn("t1", 101)]);
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1"));
    const transcript = join(PROJECTS, "-w", "s1.jsonl");
    w.transcripts.push({ path: join(PROJECTS, "-w", "other.jsonl"), mtime: 1 });
    w.transcripts.push({ path: transcript, mtime: 1 });
    w.files.set(
      transcript,
      `${JSON.stringify({ type: "user" })}\n${JSON.stringify({ type: "custom-title", customTitle: "renamed" })}\n`,
    );

    await createSessionTabNamer(w.deps).check();

    expect(w.renames).toEqual([["t1", "renamed"]]);
  });

  it.each([
    [undefined, "", "ai-title", "auto"],
    ["pid", "", "custom-title", "pid"],
    [undefined, "", "custom-title", "manual"],
    [undefined, "head", "custom-title", "manual"],
    [undefined, "head", "ai-title", "auto"],
  ])(
    "resumed session title precedence: pid %s, location %s, type %s",
    async (pidName, location, type, expected) => {
      const w = world();
      w.setProcesses([w.claudeIn("t1", 101)]);
      w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", pidName));
      const path = join(PROJECTS, "-w", "s1.jsonl");
      w.transcripts.push({ path, mtime: 1 });
      const records = [
        JSON.stringify({ type: "ai-title", aiTitle: "auto" }),
        ...(type === "custom-title" ? [JSON.stringify({ type, customTitle: "manual" })] : []),
      ].join("\n");
      let reads = 0;
      w.deps.readTail = async () => {
        reads++;
        return location === "head" ? "" : records;
      };
      w.deps.readHead = async () => {
        reads++;
        return records;
      };
      await createSessionTabNamer(w.deps).check();
      expect(w.renames).toEqual([["t1", expected]]);
      if (pidName !== undefined) expect(reads).toBe(0);
    },
  );

  // A session /renamed long ago, then resumed: Claude's newer ai-title in
  // the tail must not beat the user's custom-title in the head.
  it.each([
    [
      "custom in head, ai in tail",
      ["ai-title:auto0", "custom-title:mine"],
      ["ai-title:auto1"],
      "mine",
    ],
    ["newest custom wins", ["custom-title:old"], ["ai-title:auto", "custom-title:new"], "new"],
    ["custom in both: tail is newer", ["custom-title:old"], ["custom-title:new"], "new"],
    ["two customs in head", ["custom-title:a", "custom-title:b"], ["ai-title:auto"], "b"],
    ["no custom: newest ai", ["ai-title:a"], ["ai-title:b"], "b"],
  ])("resumed session title: %s", async (_case, head, tail, expected) => {
    const w = world();
    w.setProcesses([w.claudeIn("t1", 101)]);
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1"));
    w.transcripts.push({ path: join(PROJECTS, "-w", "s1.jsonl"), mtime: 1 });
    const text = (records: string[]) =>
      records
        .map((record) => {
          const [type, title] = record.split(":");
          return JSON.stringify(
            type === "ai-title" ? { type, aiTitle: title } : { type, customTitle: title },
          );
        })
        .join("\n");
    w.deps.readHead = async () => text(head);
    w.deps.readTail = async () => text(tail);
    await createSessionTabNamer(w.deps).check();
    expect(w.renames).toEqual([["t1", expected]]);
  });

  it("caches transcript titles until the 10 second recheck, then discovers changes", async () => {
    const w = world();
    w.setProcesses([w.claudeIn("t1", 101)]);
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1"));
    w.transcripts.push({ path: join(PROJECTS, "s1.jsonl"), mtime: 1 });
    let reads = 0;
    let time = NOW;
    let title = "first";
    w.deps.now = () => time;
    w.deps.readTail = async () => {
      reads++;
      return JSON.stringify({ type: "ai-title", aiTitle: title });
    };
    const namer = createSessionTabNamer(w.deps);
    await namer.check();
    title = "second";
    await namer.check();
    expect(reads).toBe(1);
    time += SESSION_TAB_RECHECK_MS;
    await namer.check();
    expect(reads).toBe(2);
    expect(w.renames).toEqual([
      ["t1", "first"],
      ["t1", "second"],
    ]);
  });

  it("renames when a different session is resumed directly in an already named pane", async () => {
    const w = world();
    w.setProcesses([w.claudeIn("t1", 101)]);
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "first"));
    const namer = createSessionTabNamer(w.deps);
    await namer.check();
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s2"));
    const path = join(PROJECTS, "s2.jsonl");
    w.transcripts.push({ path, mtime: 1 });
    w.files.set(path, JSON.stringify({ type: "ai-title", aiTitle: "resumed" }));
    await namer.check();
    expect(w.renames).toEqual([
      ["t1", "first"],
      ["t1", "resumed"],
    ]);
  });

  it("does not scan while no Terminal pane is live", async () => {
    const w = world();
    w.panes.length = 0;
    await createSessionTabNamer(w.deps).check();
    expect(w.scans()).toBe(0);
  });

  it("re-checks on a debounced sessions-directory change, the fallback timer and a pane exit", async () => {
    const w = world();
    w.setProcesses([w.claudeIn("t1", 101)]);
    const namer = createSessionTabNamer(w.deps);
    namer.start();
    await namer.whenIdle();
    expect(w.watchers.has(SESSIONS)).toBe(true);
    const before = w.scans();

    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "watched"));
    w.watchers.get(SESSIONS)?.onChange();
    w.watchers.get(SESSIONS)?.onChange();
    expect(w.scans()).toBe(before);
    w.fire(SESSION_TAB_DEBOUNCE_MS);
    await namer.whenIdle();
    expect(w.scans()).toBe(before + 1);
    expect(w.renames).toEqual([["t1", "watched"]]);

    w.fire(SESSION_TAB_RECHECK_MS);
    await namer.whenIdle();
    expect(w.scans()).toBe(before + 2);

    for (const listener of w.exitListeners) listener({ paneKey: "t1", code: 0 });
    w.fire(SESSION_TAB_DEBOUNCE_MS);
    await namer.whenIdle();
    expect(w.scans()).toBe(before + 3);

    // A pane's first output is how a newly started shell is noticed.
    w.panes.push({ paneKey: "t3", exited: false });
    for (const listener of w.outputListeners) listener({ paneKey: "t3", chunk: "$ ", offset: 0 });
    for (const listener of w.outputListeners) listener({ paneKey: "t3", chunk: "x", offset: 2 });
    w.fire(SESSION_TAB_DEBOUNCE_MS);
    await namer.whenIdle();
    expect(w.scans()).toBe(before + 4);

    await namer.stop();
  });

  it("closes its watchers, timers and listeners on stop", async () => {
    const w = world();
    w.setProcesses([w.claudeIn("t1", 101)]);
    const namer = createSessionTabNamer(w.deps);
    namer.start();
    await namer.whenIdle();
    w.watchers.get(SESSIONS)?.onChange();

    await namer.stop();

    expect(w.watchers.get(SESSIONS)?.closed).toBe(true);
    expect(w.timers.size).toBe(0);
    expect(w.outputListeners.size).toBe(0);
    expect(w.exitListeners.size).toBe(0);
    const before = w.scans();
    await namer.check();
    expect(w.scans()).toBe(before);
  });

  it("survives a watch that cannot be established", async () => {
    const w = world();
    w.setProcesses([w.claudeIn("t1", 101)]);
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "still named"));
    w.deps.watch = () => {
      throw new Error("ENOENT");
    };
    const namer = createSessionTabNamer(w.deps);
    namer.start();
    await namer.whenIdle();
    expect(w.renames).toEqual([["t1", "still named"]]);
    await namer.stop();
  });

  it("keeps a hand-set tab name for a session already running when Jarvis started", async () => {
    const w = world();
    w.state.tabs = [tab("t1", "mine"), tab("t2")];
    w.setProcesses([
      { ...w.claudeIn("t1", 101), startedAt: NOW - 60_000 },
      { ...w.claudeIn("t2", 102), startedAt: NOW - 60_000 },
    ]);
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "old topic"));
    w.files.set(join(SESSIONS, "102.json"), pidFile(102, "s2", "unnamed tab"));
    const namer = createSessionTabNamer(w.deps);

    await namer.check();
    await namer.check();
    // The tab with no name of its own still takes the session's.
    expect(w.renames).toEqual([["t2", "unnamed tab"]]);
    expect(w.state.tabs[0]?.customTitle).toBe("mine");

    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "new topic"));
    await namer.check();
    expect(w.renames).toEqual([
      ["t2", "unnamed tab"],
      ["t1", "new topic"],
    ]);
  });

  it("forgets a transcript path once its session is in no live pane", async () => {
    const w = world();
    w.setProcesses([w.claudeIn("t1", 101)]);
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1"));
    const transcript = join(PROJECTS, "-w", "s1.jsonl");
    w.transcripts.push({ path: transcript, mtime: 1 });
    w.files.set(transcript, `${JSON.stringify({ type: "custom-title", customTitle: "t" })}\n`);
    const namer = createSessionTabNamer(w.deps);

    await namer.check();
    await namer.check();
    expect(w.listings()).toBe(1); // cached while the session is live

    w.setProcesses([]);
    await namer.check();
    w.setProcesses([w.claudeIn("t1", 101)]);
    await namer.check();
    expect(w.listings()).toBe(2); // pruned, so looked up again
  });

  it("creates no watcher or timer after stop, even with a check in flight", async () => {
    const w = world();
    w.files.set(join(SESSIONS, "101.json"), pidFile(101, "s1", "late"));
    let release: (rows: ExternalAgentProcess[]) => void = () => {};
    w.deps.scanAgents = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const namer = createSessionTabNamer(w.deps);
    namer.start();

    const stopped = namer.stop();
    release([w.claudeIn("t1", 101)]);
    await stopped;

    expect(w.watchers.size).toBe(0);
    expect(w.timers.size).toBe(0);
    expect(w.renames).toEqual([]);
    for (const listener of w.exitListeners) listener({ paneKey: "t1", code: 0 });
    expect(w.timers.size).toBe(0);
  });
});
