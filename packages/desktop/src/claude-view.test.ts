import type { ExternalAgentProcess } from "@jarvis/platform";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_VIEW_DEBOUNCE_MS,
  createClaudeViewHandlers,
  createClaudeViewNotifier,
  type ClaudeViewDeps,
} from "./claude-view.js";
import type { PaneClaudeSession } from "./pane-claude-session.js";

const PROMPT_SCREEN = [
  "Bash command",
  "  rm -rf build",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No, and tell Claude what to do differently (esc)",
].join("\n");

const BUSY_SCREEN = ["✻ Crunching… (5m 43s · esc to interrupt)", "", "⏸ plan mode on"].join("\n");

const TRANSCRIPT = [
  { type: "user", message: { role: "user", content: "fix the build" } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "On it." }],
    },
  },
]
  .map((record) => JSON.stringify(record))
  .join("\n");

function claudeProcess(overrides: Partial<ExternalAgentProcess> = {}): ExternalAgentProcess {
  return {
    pid: 42,
    agentId: "claude",
    command: "claude",
    cwd: "/repo",
    startedAt: 0,
    terminalPaneKey: "t1",
    foreground: true,
    ...overrides,
  };
}

const SESSION: PaneClaudeSession = {
  paneKey: "t1",
  pid: 42,
  sessionId: "sess-1",
  name: "fix build",
  transcriptPath: "/home/.claude/projects/-repo/sess-1.jsonl",
  cwd: "/repo",
  transcriptsDir: "/home/.claude/projects/-repo",
};

function fakeDeps(overrides: Partial<ClaudeViewDeps> = {}): ClaudeViewDeps {
  return {
    panes: vi.fn(() => [{ paneKey: "t1", exited: false }]),
    scanAgents: vi.fn(async () => [claudeProcess()]),
    lookup: { forProcess: vi.fn(async () => SESSION) },
    readTail: vi.fn(async () => TRANSCRIPT),
    screenText: vi.fn(() => ""),
    write: vi.fn(),
    log: vi.fn(),
    follow: vi.fn(),
    ...overrides,
  };
}

describe("createClaudeViewHandlers.view", () => {
  it("is none for an unknown pane, an exited pane, a non-string key and a non-Claude process", async () => {
    const unknown = fakeDeps({ panes: vi.fn(() => [{ paneKey: "other", exited: false }]) });
    expect(await createClaudeViewHandlers(unknown).view("t1")).toEqual({ kind: "none" });

    const exited = fakeDeps({ panes: vi.fn(() => [{ paneKey: "t1", exited: true }]) });
    expect(await createClaudeViewHandlers(exited).view("t1")).toEqual({ kind: "none" });
    expect(exited.scanAgents).not.toHaveBeenCalled();

    expect(await createClaudeViewHandlers(fakeDeps()).view(7)).toEqual({ kind: "none" });

    const notClaude = fakeDeps({ lookup: { forProcess: vi.fn(async () => undefined) } });
    expect(await createClaudeViewHandlers(notClaude).view("t1")).toEqual({ kind: "none" });

    const otherPane = fakeDeps({
      scanAgents: vi.fn(async () => [claudeProcess({ terminalPaneKey: "t2" })]),
    });
    expect(await createClaudeViewHandlers(otherPane).view("t1")).toEqual({ kind: "none" });
    expect(otherPane.lookup.forProcess).not.toHaveBeenCalled();
  });

  it("skips a Claude process sent to the background", async () => {
    const deps = fakeDeps({
      scanAgents: vi.fn(async () => [claudeProcess({ foreground: false })]),
    });
    expect(await createClaudeViewHandlers(deps).view("t1")).toEqual({ kind: "none" });
    expect(deps.lookup.forProcess).not.toHaveBeenCalled();
  });

  it("reads turns, model and title from the transcript and prompt from the screen", async () => {
    const deps = fakeDeps({ screenText: vi.fn(() => PROMPT_SCREEN) });
    const view = await createClaudeViewHandlers(deps).view("t1");
    expect(view).toEqual({
      kind: "claude",
      sessionId: "sess-1",
      title: "fix build",
      model: "claude-opus-5",
      mode: "default",
      turns: [
        { role: "user", text: "fix the build", tools: [] },
        { role: "assistant", text: "On it.", tools: [] },
      ],
      prompt: {
        question: "Do you want to proceed?",
        options: [
          { label: "Yes", keys: "\r" },
          { label: "No, and tell Claude what to do differently (esc)", keys: "\x1b[B\r" },
        ],
      },
    });
    expect(deps.readTail).toHaveBeenCalledWith(SESSION.transcriptPath);
    expect(deps.follow).toHaveBeenCalledWith("t1", {
      dir: SESSION.transcriptsDir,
      file: "sess-1.jsonl",
    });
  });

  it("reads mode and the spinner while busy", async () => {
    const deps = fakeDeps({ screenText: vi.fn(() => BUSY_SCREEN) });
    const view = await createClaudeViewHandlers(deps).view("t1");
    expect(view).toMatchObject({ kind: "claude", mode: "plan", working: "Crunching… 5m 43s" });
    expect(view).not.toHaveProperty("prompt");
  });

  it("answers with no turns before Claude has written a transcript", async () => {
    const { transcriptPath: _omit, ...unwritten } = SESSION;
    const deps = fakeDeps({ lookup: { forProcess: vi.fn(async () => unwritten) } });
    const view = await createClaudeViewHandlers(deps).view("t1");
    expect(view).toMatchObject({ kind: "claude", sessionId: "sess-1", turns: [] });
    expect(deps.readTail).not.toHaveBeenCalled();
  });

  it("is none on a read error, logging a category token without the path", async () => {
    const deps = fakeDeps({
      readTail: vi.fn(async () => {
        throw new Error(`ENOENT: ${SESSION.transcriptPath}`);
      }),
    });
    expect(await createClaudeViewHandlers(deps).view("t1")).toEqual({ kind: "none" });
    expect(deps.log).toHaveBeenCalledTimes(1);
    const token = vi.mocked(deps.log).mock.calls[0]?.[0] ?? "";
    expect(token).toBe("claude-view: transcript");
    expect(token).not.toContain("/");
  });

  it("is none when the scan or the lookup rejects", async () => {
    const scan = fakeDeps({
      scanAgents: vi.fn(async () => {
        throw new Error("ps failed");
      }),
    });
    expect(await createClaudeViewHandlers(scan).view("t1")).toEqual({ kind: "none" });
    expect(scan.log).toHaveBeenCalledWith("claude-view: scan");

    const lookup = fakeDeps({
      lookup: {
        forProcess: vi.fn(async () => {
          throw new Error("EACCES /home/.claude/projects");
        }),
      },
    });
    expect(await createClaudeViewHandlers(lookup).view("t1")).toEqual({ kind: "none" });
    expect(lookup.log).toHaveBeenCalledWith("claude-view: lookup");
  });
});

describe("createClaudeViewHandlers.answer", () => {
  it("is changed when the label at that index differs, and writes nothing", () => {
    const deps = fakeDeps({ screenText: vi.fn(() => PROMPT_SCREEN) });
    const { answer } = createClaudeViewHandlers(deps);
    expect(answer("t1", 0, "No")).toEqual({ ok: false, reason: "changed" });
    expect(answer("t1", 5, "Yes")).toEqual({ ok: false, reason: "changed" });
    expect(answer("t1", "0", "Yes")).toEqual({ ok: false, reason: "changed" });
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("is gone when the pane shows no prompt, or the pane is gone", () => {
    const deps = fakeDeps({ screenText: vi.fn(() => BUSY_SCREEN) });
    expect(createClaudeViewHandlers(deps).answer("t1", 0, "Yes")).toEqual({
      ok: false,
      reason: "gone",
    });
    const exited = fakeDeps({
      panes: vi.fn(() => [{ paneKey: "t1", exited: true }]),
      screenText: vi.fn(() => PROMPT_SCREEN),
    });
    expect(createClaudeViewHandlers(exited).answer("t1", 0, "Yes")).toEqual({
      ok: false,
      reason: "gone",
    });
    expect(createClaudeViewHandlers(deps).answer(1, 0, "Yes")).toEqual({
      ok: false,
      reason: "gone",
    });
    expect(deps.write).not.toHaveBeenCalled();
    expect(exited.write).not.toHaveBeenCalled();
  });

  it("writes the keys read fresh from the screen on a match", () => {
    const deps = fakeDeps({ screenText: vi.fn(() => PROMPT_SCREEN) });
    const result = createClaudeViewHandlers(deps).answer(
      "t1",
      1,
      "No, and tell Claude what to do differently (esc)",
    );
    expect(result).toEqual({ ok: true });
    expect(deps.write).toHaveBeenCalledWith("t1", "\x1b[B\r");
  });
});

describe("createClaudeViewNotifier", () => {
  function harness() {
    let output: ((paneKey: string) => void) | undefined;
    let exit: ((paneKey: string) => void) | undefined;
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const watchers = new Map<string, { cb: (file: string | null) => void; closed: boolean }>();
    const emit = vi.fn();
    const deps = {
      onOutput: vi.fn((cb: (paneKey: string) => void) => {
        output = cb;
        return () => {
          output = undefined;
        };
      }),
      onExit: vi.fn((cb: (paneKey: string) => void) => {
        exit = cb;
        return () => {
          exit = undefined;
        };
      }),
      watch: vi.fn((dir: string, cb: (file: string | null) => void) => {
        const watcher = { cb, closed: false };
        watchers.set(dir, watcher);
        return {
          close: () => {
            watcher.closed = true;
          },
        };
      }),
      schedule: vi.fn((fn: () => void, ms: number) => {
        const timer = { fn, ms, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      }),
      emit,
      log: vi.fn(),
    };
    const notifier = createClaudeViewNotifier(deps);
    const flush = () => {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
    };
    return {
      deps,
      notifier,
      flush,
      timers,
      watchers,
      output: (paneKey: string) => output?.(paneKey),
      exit: (paneKey: string) => exit?.(paneKey),
    };
  }

  it("coalesces three outputs within the window into one emit", () => {
    const h = harness();
    h.output("t1");
    h.output("t1");
    h.output("t1");
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.ms).toBe(CLAUDE_VIEW_DEBOUNCE_MS);
    expect(CLAUDE_VIEW_DEBOUNCE_MS).toBe(300);
    h.flush();
    expect(h.deps.emit).toHaveBeenCalledTimes(1);
    expect(h.deps.emit).toHaveBeenCalledWith("t1");
    h.output("t1");
    h.flush();
    expect(h.deps.emit).toHaveBeenCalledTimes(2);
  });

  it("emits per pane, independently", () => {
    const h = harness();
    h.output("t1");
    h.output("t2");
    h.flush();
    expect(h.deps.emit.mock.calls).toEqual([["t1"], ["t2"]]);
  });

  it("emits when a followed pane's transcript changes, and only for that file", () => {
    const h = harness();
    h.notifier.follow("t1", { dir: "/p", file: "a.jsonl" });
    h.notifier.follow("t2", { dir: "/p", file: "b.jsonl" });
    expect(h.deps.watch).toHaveBeenCalledTimes(1);
    h.watchers.get("/p")?.cb("a.jsonl");
    h.flush();
    expect(h.deps.emit.mock.calls).toEqual([["t1"]]);
    h.watchers.get("/p")?.cb("c.jsonl");
    h.flush();
    expect(h.deps.emit).toHaveBeenCalledTimes(1);
  });

  it("closes a directory's watch once no pane follows it, and on stop", () => {
    const h = harness();
    h.notifier.follow("t1", { dir: "/p", file: "a.jsonl" });
    h.exit("t1");
    expect(h.watchers.get("/p")?.closed).toBe(true);
    h.notifier.follow("t2", { dir: "/q", file: "b.jsonl" });
    h.output("t2");
    h.notifier.stop();
    expect(h.watchers.get("/q")?.closed).toBe(true);
    expect(h.timers[0]?.cancelled).toBe(true);
    h.output("t2");
    expect(h.deps.emit).not.toHaveBeenCalled();
  });

  it("survives a watch that throws, retrying on the next follow", () => {
    const h = harness();
    h.deps.watch.mockImplementationOnce(() => {
      throw new Error("ENOENT /p");
    });
    h.notifier.follow("t1", { dir: "/p", file: "a.jsonl" });
    expect(h.deps.log).toHaveBeenCalledWith("claude-view: watch");
    h.notifier.follow("t1", { dir: "/p", file: "a.jsonl" });
    expect(h.deps.watch).toHaveBeenCalledTimes(2);
  });
});
