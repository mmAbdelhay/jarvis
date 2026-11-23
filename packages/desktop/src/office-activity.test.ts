import type { Session } from "@jarvis/core";
import { describe, expect, it, vi } from "vitest";
import type { AgentView } from "./agent-view.js";
import {
  createOfficeActivity,
  createOfficeViewing,
  OFFICE_NOTIFY_COALESCE_MS,
  OFFICE_SCAN_MS,
  type OfficeActivityDeps,
} from "./office-activity.js";

const NONE: AgentView = { kind: "none" };
const agent = (extra: Partial<Extract<AgentView, { kind: "agent" }>> = {}): AgentView => ({
  kind: "agent",
  vendor: "anthropic",
  sessionId: "s",
  turns: [],
  ...extra,
});
const ASKING = agent({
  prompt: { question: "Delete the\u0007 database?", options: [{ label: "Yes" }] },
});

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    project: "alpha",
    projectPath: "/p",
    agentId: "claude",
    state: "running",
    summary: "refactor the thing",
    startedAt: 1,
    lastActivityAt: 1,
    ...overrides,
  };
}

function world(overrides: Partial<OfficeActivityDeps> = {}) {
  let now = 100_000;
  const views = new Map<string, AgentView>();
  const live = new Set<string>();
  const sessions: Session[] = [];
  const logs = new Map<string, string>();
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let timerId = 0;
  const viewing = new Set<string>();
  const state = { focused: false };
  const deps: OfficeActivityDeps = {
    panes: () => [...live].map((paneKey) => ({ paneKey, exited: false })),
    agentView: vi.fn(async (paneKey: string) => views.get(paneKey) ?? NONE),
    sessions: () => sessions,
    sessionLog: (id) => logs.get(id) ?? "",
    vendorOf: () => "anthropic",
    projectOf: (target) => (target === "t2" ? null : "alpha"),
    now: () => now,
    schedule: (fn, ms) => {
      const id = timerId++;
      timers.push({ at: now + ms, fn, id });
      return () => {
        const at = timers.findIndex((timer) => timer.id === id);
        if (at !== -1) timers.splice(at, 1);
      };
    },
    emitChanged: vi.fn(),
    notify: vi.fn(),
    focused: () => state.focused,
    viewing: () => viewing,
    language: "en",
    log: vi.fn(),
    ...overrides,
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers.filter((candidate) => candidate.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.fn();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    deps,
    views,
    live,
    sessions,
    logs,
    viewing,
    state,
    advance,
    timers,
    set: (n: number) => (now = n),
  };
}

describe("office activity watcher", () => {
  it("does no work with no live panes or sessions", async () => {
    const w = world();
    const watcher = createOfficeActivity(w.deps);
    expect(await watcher.read()).toEqual({ panes: {}, sessions: {} });
    expect(w.deps.agentView).not.toHaveBeenCalled();
    expect(w.timers).toHaveLength(0);
  });

  it("reads an agent pane's state, doing, model and agent name", async () => {
    const w = world();
    w.live.add("t1");
    w.views.set(
      "t1",
      agent({
        working: "Crunching… 5s",
        model: "claude-x",
        turns: [{ role: "assistant", text: "", tools: [{ name: "Edit", target: "app.ts" }] }],
      }),
    );
    w.live.add("t9"); // a plain shell: no entry
    const out = await createOfficeActivity(w.deps).read();
    expect(out.panes["t1"]).toEqual({
      agent: "Claude Code",
      state: "busy",
      doing: "Crunching… 5s",
      model: "claude-x",
    });
    expect(out.panes["t9"]).toBeUndefined();
  });

  it("falls back to the last tool as 'Name target' and calls an idle agent idle", async () => {
    const w = world();
    w.live.add("t1");
    w.views.set(
      "t1",
      agent({
        vendor: "openai",
        turns: [
          {
            role: "assistant",
            text: "x",
            tools: [
              { name: "Read", target: "a.ts" },
              { name: "Edit", target: "b.ts" },
            ],
          },
        ],
      }),
    );
    const out = await createOfficeActivity(w.deps).read();
    expect(out.panes["t1"]).toMatchObject({ agent: "Codex", state: "idle", doing: "Edit b.ts" });
  });

  it("makes a readable prompt and an unreadable approval menu both a question", async () => {
    const w = world();
    w.live.add("t1");
    w.live.add("t2");
    w.views.set("t1", ASKING);
    w.views.set("t2", agent({ vendor: "openai", needsTerm: true }));
    const out = await createOfficeActivity(w.deps).read();
    expect(out.panes["t1"]).toMatchObject({ state: "question", question: "Delete the database?" });
    expect(out.panes["t2"]?.state).toBe("question");
    expect(out.panes["t2"]).not.toHaveProperty("question");
  });

  it("caps the question at 200 characters and strips control characters", async () => {
    const w = world();
    w.live.add("t1");
    w.views.set(
      "t1",
      agent({ prompt: { question: `a\u001b[0m\u0000${"b".repeat(400)}`, options: [] } }),
    );
    const q = (await createOfficeActivity(w.deps).read()).panes["t1"]?.question ?? "";
    expect(q.length).toBe(200);
    expect([...q].every((char) => (char.codePointAt(0) ?? 0) > 0x1f)).toBe(true);
  });

  it("reads a Jarvis-spawned session's tail, with its summary as doing", async () => {
    const w = world();
    w.sessions.push(
      session("s1"),
      session("s2", { state: "done" }),
      session("ext", { origin: "external", pid: 4 }),
    );
    w.logs.set("s1", ["Bash command", "Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n"));
    const out = await createOfficeActivity(w.deps).read();
    expect(out.sessions["s1"]).toMatchObject({
      state: "question",
      question: "Do you want to proceed?",
      doing: "refactor the thing",
    });
    expect(out.sessions["s2"]).toBeUndefined();
    expect(out.sessions["ext"]).toBeUndefined();
  });

  it("scans again only after output, at most once per 3 s, and not while quiet", async () => {
    const w = world();
    w.live.add("t1");
    w.views.set("t1", agent());
    const watcher = createOfficeActivity(w.deps);
    await watcher.read();
    expect(w.deps.agentView).toHaveBeenCalledTimes(1);
    await w.advance(60_000);
    await watcher.read();
    expect(w.deps.agentView).toHaveBeenCalledTimes(1);
    watcher.markDirty(); // long since the last scan: goes at once
    await w.advance(0);
    expect(w.deps.agentView).toHaveBeenCalledTimes(2);
    watcher.markDirty();
    watcher.markDirty();
    watcher.markDirty();
    await w.advance(OFFICE_SCAN_MS - 1);
    expect(w.deps.agentView).toHaveBeenCalledTimes(2);
    await w.advance(1);
    expect(w.deps.agentView).toHaveBeenCalledTimes(3);
  });

  it("keeps scanning every 3 s while a question is open, then stops", async () => {
    const w = world();
    w.live.add("t1");
    w.views.set("t1", ASKING);
    const watcher = createOfficeActivity(w.deps);
    await watcher.read();
    await w.advance(OFFICE_SCAN_MS);
    await w.advance(OFFICE_SCAN_MS);
    expect(w.deps.agentView).toHaveBeenCalledTimes(3);
    w.views.set("t1", agent());
    await w.advance(OFFICE_SCAN_MS);
    const calls = vi.mocked(w.deps.agentView).mock.calls.length;
    await w.advance(60_000);
    expect(w.deps.agentView).toHaveBeenCalledTimes(calls);
  });

  it("pushes office:changed, with no content, only when the answer differs", async () => {
    const w = world();
    w.live.add("t1");
    w.views.set("t1", agent());
    const watcher = createOfficeActivity(w.deps);
    await watcher.read();
    expect(w.deps.emitChanged).toHaveBeenCalledTimes(1);
    watcher.markDirty();
    await w.advance(OFFICE_SCAN_MS);
    expect(w.deps.emitChanged).toHaveBeenCalledTimes(1);
    w.views.set("t1", agent({ working: "Working…" }));
    watcher.markDirty();
    await w.advance(OFFICE_SCAN_MS);
    expect(w.deps.emitChanged).toHaveBeenCalledTimes(2);
    expect(vi.mocked(w.deps.emitChanged).mock.calls[0]).toEqual([]);
  });

  describe("the hand-raised notification", () => {
    it("fires once per transition with the agent name and never the question", async () => {
      const w = world();
      w.live.add("t1");
      w.views.set("t1", agent());
      const watcher = createOfficeActivity(w.deps);
      await watcher.read();
      expect(w.deps.notify).not.toHaveBeenCalled();
      w.views.set("t1", ASKING);
      watcher.markDirty();
      await w.advance(OFFICE_SCAN_MS);
      expect(w.deps.notify).toHaveBeenCalledTimes(1);
      const [title, body] = vi.mocked(w.deps.notify).mock.calls[0] ?? [];
      expect(title).toBe("Hand raised in alpha");
      expect(body).toBe("Claude Code");
      expect(`${title} ${body}`).not.toContain("database");
      await w.advance(OFFICE_SCAN_MS * 3);
      expect(w.deps.notify).toHaveBeenCalledTimes(1);
    });

    it("coalesces a repeat for the same target within 60 s, then allows it", async () => {
      const w = world();
      w.live.add("t1");
      const watcher = createOfficeActivity(w.deps);
      const flip = async (view: AgentView) => {
        w.views.set("t1", view);
        watcher.markDirty();
        await w.advance(OFFICE_SCAN_MS);
      };
      await flip(ASKING);
      await flip(agent());
      await flip(ASKING);
      expect(w.deps.notify).toHaveBeenCalledTimes(1);
      await flip(agent());
      await w.advance(OFFICE_NOTIFY_COALESCE_MS);
      await flip(ASKING);
      expect(w.deps.notify).toHaveBeenCalledTimes(2);
    });

    it("stays quiet when the window is focused and that exact tab is on screen", async () => {
      const w = world();
      w.live.add("t1:p2");
      w.views.set("t1:p2", ASKING);
      w.state.focused = true;
      w.viewing.add("t1");
      await createOfficeActivity(w.deps).read();
      expect(w.deps.notify).not.toHaveBeenCalled();
    });

    it("speaks when focused on a different tab, or on screen but unfocused", async () => {
      const w = world();
      w.live.add("t1");
      w.live.add("t3");
      w.views.set("t1", ASKING);
      w.views.set("t3", ASKING);
      w.state.focused = true;
      w.viewing.add("t1");
      await createOfficeActivity(w.deps).read();
      expect(w.deps.notify).toHaveBeenCalledTimes(1);
      const w2 = world();
      w2.live.add("t1");
      w2.views.set("t1", ASKING);
      w2.viewing.add("t1");
      await createOfficeActivity(w2.deps).read();
      expect(w2.deps.notify).toHaveBeenCalledTimes(1);
    });

    it("names the Lounge for a project-less target and works for sessions", async () => {
      const w = world();
      w.live.add("t2");
      w.views.set("t2", ASKING);
      await createOfficeActivity(w.deps).read();
      expect(vi.mocked(w.deps.notify).mock.calls[0]?.[0]).toBe("Hand raised in Lounge");
      const s = world();
      s.sessions.push(session("s1"));
      s.logs.set("s1", ["Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n"));
      s.viewing.add("s1");
      s.state.focused = true;
      await createOfficeActivity(s.deps).read();
      expect(s.deps.notify).not.toHaveBeenCalled();
    });

    it("writes Arabic when the app language is Arabic", async () => {
      const w = world({ language: "ar" });
      w.live.add("t1");
      w.views.set("t1", ASKING);
      await createOfficeActivity(w.deps).read();
      expect(vi.mocked(w.deps.notify).mock.calls[0]?.[0]).not.toContain("Hand raised");
    });
  });

  it("logs nothing but tokens, and survives a failing read", async () => {
    const w = world({
      agentView: vi.fn(async () => {
        throw new Error("secret transcript text");
      }),
    });
    w.live.add("t1");
    const out = await createOfficeActivity(w.deps).read();
    expect(out.panes["t1"]).toEqual({ state: "unknown" });
    for (const call of vi.mocked(w.deps.log).mock.calls) {
      expect(String(call[0])).not.toContain("secret");
    }
  });
});

describe("viewing keys", () => {
  it("keeps only plausible keys, replacing the previous set", () => {
    const viewing = createOfficeViewing();
    viewing.set(["t1", 5, "x".repeat(500), "s1"]);
    expect(viewing.keys()).toEqual(new Set(["t1", "s1"]));
    viewing.set("nonsense");
    expect(viewing.keys()).toEqual(new Set());
    viewing.set(Array.from({ length: 1000 }, (_, i) => `k${i}`));
    expect(viewing.keys().size).toBeLessThanOrEqual(64);
  });
});
