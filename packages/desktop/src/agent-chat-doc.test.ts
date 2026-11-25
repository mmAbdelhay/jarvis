import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentChatDeps,
  type AgentChatView,
  createAgentChatHandlers,
} from "./agent-chat-doc.js";
import type { PaneAgentSession } from "./pane-agent-session.js";

const fixture = (name: string): string =>
  readFileSync(
    new URL(`../../core/src/session/__fixtures__/agent-input/${name}.txt`, import.meta.url),
    "utf8",
  ).replace(/^# (?:synthetic|rendered).*\n/, "");

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
const userLine = (n: number, content: unknown = `message ${n}`): string =>
  line({
    type: "user",
    uuid: `u${n}`,
    timestamp: "2026-01-01T10:00:00.000Z",
    message: { role: "user", content },
  });
const asstLine = (n: number, content: unknown[], usage?: unknown): string =>
  line({
    type: "assistant",
    uuid: `a${n}`,
    timestamp: "2026-01-01T10:00:01.000Z",
    message: { role: "assistant", model: "claude-test", content, ...(usage ? { usage } : {}) },
  });

const SESSION = (vendor: PaneAgentSession["vendor"] = "anthropic"): PaneAgentSession => ({
  paneKey: "t1",
  pid: 1,
  vendor,
  sessionId: `${vendor}-1`,
  name: "named",
  transcriptPath: "/t/s.jsonl",
  cwd: "/repo",
});

function setup(
  initial: string,
  options: {
    vendor?: PaneAgentSession["vendor"];
    screen?: string;
    maxItems?: number;
    stepBytes?: number;
    syncBytes?: number;
    chunkBytes?: number;
    sessions?: PaneAgentSession[];
  } = {},
) {
  const files = new Map<string, Buffer>([["/t/s.jsonl", Buffer.from(initial)]]);
  let ino = 1;
  const state = { screen: options.screen ?? "" };
  const reads: [number, number][] = [];
  const deps: AgentChatDeps = {
    sessions: {
      session: vi.fn(async (paneKey: string) =>
        paneKey === "t1" ? (options.sessions?.[0] ?? SESSION(options.vendor)) : undefined,
      ),
      live: vi.fn((paneKey: unknown) => paneKey === "t1"),
    },
    statFile: vi.fn(async (path: string) => {
      const buf = files.get(path);
      if (buf === undefined) throw new Error("ENOENT");
      return { size: buf.length, mtimeMs: 1, ino };
    }),
    readRange: vi.fn(async (path: string, start: number, length: number) => {
      reads.push([start, length]);
      return (files.get(path) ?? Buffer.alloc(0)).subarray(start, start + length);
    }),
    screenText: vi.fn(() => state.screen),
    notice: vi.fn(),
    follow: vi.fn(),
    forget: vi.fn(),
    changed: vi.fn(),
    log: vi.fn(),
    limits: {
      ...(options.maxItems ? { maxItems: options.maxItems } : {}),
      ...(options.stepBytes ? { stepBytes: options.stepBytes } : {}),
      ...(options.syncBytes ? { syncBytes: options.syncBytes } : {}),
      ...(options.chunkBytes ? { chunkBytes: options.chunkBytes } : {}),
    },
  };
  const handlers = createAgentChatHandlers(deps);
  const append = (text: string) =>
    files.set(
      "/t/s.jsonl",
      Buffer.concat([files.get("/t/s.jsonl") ?? Buffer.alloc(0), Buffer.from(text)]),
    );
  const replace = (text: string) => {
    ino += 1;
    files.set("/t/s.jsonl", Buffer.from(text));
  };
  return { handlers, deps, files, state, reads, append, replace };
}

type Agent = Extract<AgentChatView, { kind: "agent" }>;
const agent = (view: AgentChatView): Agent => {
  if (view.kind !== "agent") throw new Error("not an agent view");
  return view;
};
const ids = (view: AgentChatView): string[] => agent(view).page.items.map((i) => i.id);

describe("agentChat", () => {
  it("is none for a non-string, an unknown pane and a plain pane", async () => {
    const t = setup("");
    expect(await t.handlers.chat(7)).toEqual({ kind: "none" });
    expect(await t.handlers.chat("nope")).toEqual({ kind: "none" });
    const plain = setup("");
    vi.mocked(plain.deps.sessions.session).mockResolvedValue(undefined);
    expect(await plain.handlers.chat("t1")).toEqual({ kind: "none" });
    expect(plain.deps.notice).not.toHaveBeenCalled();
  });

  it("shows items, derived side data, model, context and honest caps, and notices once an agent is found", async () => {
    const text =
      userLine(1, "hello") +
      asstLine(
        2,
        [
          {
            type: "tool_use",
            id: "td",
            name: "TodoWrite",
            input: { todos: [{ content: "x", status: "pending" }] },
          },
          {
            type: "tool_use",
            id: "ed",
            name: "Edit",
            input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
          },
        ],
        { input_tokens: 10, cache_read_input_tokens: 90 },
      );
    const t = setup(text);
    const view = agent(await t.handlers.chat("t1"));
    expect(view).toMatchObject({
      vendor: "anthropic",
      sessionId: "anthropic-1",
      title: "named",
      model: "claude-test",
      todos: [{ text: "x", state: "open" }],
      files: [{ path: "/repo/a.ts", added: 1, removed: 1 }],
      context: { used: 100 },
      caps: { stop: true, mode: true, model: "command", queue: true },
    });
    expect(view.page.items.map((i) => i.id)).toEqual(["u1:0", "td", "ed"]);
    expect(view.deriving).toBeUndefined();
    expect(view.page.older).toBeUndefined();
    expect(t.deps.notice).toHaveBeenCalledWith("t1");
    expect(t.deps.follow).toHaveBeenCalledWith("t1", { dir: "/t", file: "s.jsonl" });
  });

  it("shows a mode only when the screen proves it, and keeps the last proven one while a menu hides the status row", async () => {
    const RULE = "─".repeat(40);
    const idle = (status: string) => ["done", RULE, "❯", RULE, status].join("\n");
    const t = setup(userLine(1), { screen: idle("") });
    expect(agent(await t.handlers.chat("t1")).mode).toBeUndefined();
    t.state.screen = idle("  ⏸ plan mode on (shift+tab to cycle)");
    expect(agent(await t.handlers.chat("t1")).mode).toBe("plan");
    t.state.screen = [
      "Bash command",
      "  ls",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
    ].join("\n");
    expect(agent(await t.handlers.chat("t1")).mode).toBe("plan");
    t.state.screen = idle("  ? for shortcuts");
    expect(agent(await t.handlers.chat("t1")).mode).toBe("default");
    const other = setup(userLine(1), { screen: "no status row" });
    expect(agent(await other.handlers.chat("t1")).mode).toBeUndefined();
  });

  it("states caps per vendor: mode and a model command only for Claude", async () => {
    const codex = agent(await setup("", { vendor: "openai" }).handlers.chat("t1"));
    expect(codex.caps).toMatchObject({ mode: false, model: "menu", stop: true });
    const copilot = agent(await setup("", { vendor: "github" }).handlers.chat("t1"));
    expect(copilot.caps).toMatchObject({ mode: false, model: "menu" });
  });

  it("reads only new bytes after the first read, and restarts after a shrink or replacement", async () => {
    const t = setup(userLine(1) + userLine(2));
    await t.handlers.chat("t1");
    const first = t.reads.length;
    t.append(userLine(3));
    const second = agent(await t.handlers.chat("t1"));
    expect(ids(second)).toEqual(["u1:0", "u2:0", "u3:0"]);
    expect(t.reads.slice(first)).toHaveLength(1);
    expect(t.reads.at(-1)?.[0]).toBe(Buffer.byteLength(userLine(1) + userLine(2)));
    t.replace(userLine(9));
    const reset = agent(await t.handlers.chat("t1"));
    expect(reset.reset).toBe(true);
    expect(ids(reset)).toEqual(["u9:0"]);
    const shrunk = setup(userLine(1) + userLine(2));
    await shrunk.handlers.chat("t1");
    shrunk.files.set("/t/s.jsonl", Buffer.from(userLine(5)));
    expect(agent(await shrunk.handlers.chat("t1")).reset).toBe(true);
  });

  it("for a 3500-turn session: first reply from the tail, deriving; the background read then announces itself, and the next reply is whole", async () => {
    const body = Array.from({ length: 3500 }, (_, i) =>
      i % 2 === 0
        ? userLine(i)
        : asstLine(i, [
            {
              type: "tool_use",
              id: `e${i}`,
              name: "Edit",
              input: { file_path: `/repo/f${i}.ts`, old_string: "a", new_string: "b" },
            },
          ]),
    ).join("");
    const t = setup(body, { syncBytes: 64 * 1024, stepBytes: 64 * 1024, chunkBytes: 256 * 1024 });
    const first = agent(await t.handlers.chat("t1"));
    expect(first.deriving).toBe(true);
    expect(first.files).toEqual([]);
    await vi.waitFor(() => expect(t.deps.changed).toHaveBeenCalledWith("t1"));
    const second = agent(await t.handlers.chat("t1"));
    expect(second.deriving).toBeUndefined();
    expect(second.files.length).toBeGreaterThan(100);
  });

  it("never mixes two files into one reader when the file is replaced during a read", async () => {
    const t = setup(userLine(1) + userLine(2));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = vi.mocked(t.deps.readRange).getMockImplementation();
    vi.mocked(t.deps.readRange).mockImplementationOnce(async (path, start, length) => {
      // The bytes are those of the file as it was when the read began.
      const old = real === undefined ? Buffer.alloc(0) : await real(path, start, length);
      await gate;
      return old;
    });
    const first = t.handlers.chat("t1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    t.replace(userLine(8) + userLine(9));
    const second = t.handlers.chat("t1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    const views = [agent(await first), agent(await second)];
    for (const view of views) expect(ids(view)).not.toContain("u1:0");
    const later = agent(await t.handlers.chat("t1"));
    expect(ids(later)).toEqual(["u8:0", "u9:0"]);
  });

  it("reads a large file in chunks off the first reply, deriving until ready, one read at a time", async () => {
    const body = Array.from({ length: 60 }, (_, i) => userLine(i)).join("");
    const todo = asstLine(99, [
      {
        type: "tool_use",
        id: "td",
        name: "TodoWrite",
        input: { todos: [{ content: "later", status: "active" }] },
      },
    ]);
    const t = setup(todo + body, { syncBytes: 500, chunkBytes: 700, stepBytes: 1200 });
    const first = agent(await t.handlers.chat("t1"));
    expect(first.deriving).toBe(true);
    expect(first.todos).toBeUndefined();
    expect(first.page.items.length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(t.deps.changed).toHaveBeenCalledWith("t1"));
    const sizes = t.reads.map(([, length]) => length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1200);
    const done = agent(await t.handlers.chat("t1"));
    expect(done.deriving).toBeUndefined();
    expect(done.todos).toEqual([{ text: "later", state: "active" }]);
    // the same ids whichever way they were read
    const tailIds = new Set(first.page.items.map((i) => i.id));
    for (const id of tailIds) expect(done.page.items.map((i) => i.id).concat(...[])).toContain(id);
  });

  it("pages older items by an opaque cursor with identical ids, and a result joins its call across pages", async () => {
    let text = asstLine(0, [
      { type: "tool_use", id: "t0", name: "Bash", input: { command: "ls" } },
    ]);
    for (let i = 1; i <= 450; i++) text += userLine(i);
    text += line({
      type: "user",
      uuid: "r",
      timestamp: "2026-01-01T10:00:02.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t0", content: "out" }],
      },
    });
    const t = setup(text);
    const latest = agent(await t.handlers.chat("t1"));
    expect(latest.page.items).toHaveLength(200);
    expect(latest.page.items.at(-1)?.id).toBe("u450:0");
    const cursor = latest.page.older;
    expect(typeof cursor).toBe("string");
    const older = agent(await t.handlers.chat("t1", { before: cursor }));
    expect(older.page.items).toHaveLength(200);
    expect(older.page.items.at(-1)?.id).toBe("u250:0");
    const oldest = agent(await t.handlers.chat("t1", { before: older.page.older }));
    expect(oldest.page.items.map((i) => i.id).slice(0, 2)).toEqual(["t0", "u1:0"]);
    expect(oldest.page.items[0]).toMatchObject({ kind: "tool", state: "ok", output: "out" });
    expect(oldest.page.older).toBeUndefined();
    const all = [...oldest.page.items, ...older.page.items, ...latest.page.items].map((i) => i.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("answers a cursor from another session or an unreadable one with a reset latest page", async () => {
    const t = setup(userLine(1) + userLine(2));
    const view = agent(await t.handlers.chat("t1", { before: "not-a-cursor" }));
    expect(view.reset).toBe(true);
    expect(ids(view)).toEqual(["u1:0", "u2:0"]);
    const foreign = Buffer.from(
      JSON.stringify({ v: 1, s: "other", p: "/t/s.jsonl", k: "mem", id: "u2:0" }),
    ).toString("base64url");
    expect(agent(await t.handlers.chat("t1", { before: foreign })).reset).toBe(true);
  });

  it("reads backwards from disk in windows for items older than the in-memory cap", async () => {
    let text = "";
    for (let i = 1; i <= 40; i++) text += userLine(i);
    const t = setup(text, { maxItems: 10, stepBytes: 600 });
    const latest = agent(await t.handlers.chat("t1"));
    expect(ids(latest)).toEqual(Array.from({ length: 10 }, (_, i) => `u${31 + i}:0`));
    const seen = [...ids(latest)];
    let cursor = latest.page.older;
    let guard = 0;
    while (cursor !== undefined && guard++ < 50) {
      const page = agent(await t.handlers.chat("t1", { before: cursor }));
      seen.unshift(...ids(page));
      cursor = page.page.older;
    }
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => `u${i + 1}:0`));
  });

  it("shows a readable menu as a prompt without keys, and an unreadable one as needsTerm", async () => {
    const menu = setup(userLine(1), { screen: fixture("claude-approval") });
    const view = agent(await menu.handlers.chat("t1"));
    expect(view.prompt).toMatchObject({ kind: "single", question: "Do you want to proceed?" });
    expect(view.prompt?.options.map((o) => o.label)[0]).toBe("Yes");
    expect(JSON.stringify(view)).not.toContain("\\u001b");
    expect(JSON.stringify(view)).not.toContain('"keys"');
    const trust = agent(
      await setup(userLine(1), { screen: fixture("claude-trust") }).handlers.chat("t1"),
    );
    expect(trust.needsTerm).toBe(true);
    expect(trust.prompt).toBeUndefined();
    const idle = agent(
      await setup(userLine(1), { screen: fixture("claude-idle") }).handlers.chat("t1"),
    );
    expect(idle.prompt).toBeUndefined();
    expect(idle.needsTerm).toBeUndefined();
  });

  it("reads context left only from the screen's own text", async () => {
    const t = setup(asstLine(1, [{ type: "text", text: "x" }], { input_tokens: 50 }), {
      screen: "stuff\nContext left until auto-compact: 12%\n",
    });
    expect(agent(await t.handlers.chat("t1")).context).toEqual({ used: 50, leftPercent: 12 });
    const codex = setup("", { vendor: "openai", screen: fixture("codex-idle") });
    expect(agent(await codex.handlers.chat("t1")).context).toBeUndefined();
    const bare = setup(asstLine(1, [{ type: "text", text: "x" }], { input_tokens: 50 }));
    expect(agent(await bare.handlers.chat("t1")).context).toEqual({ used: 50 });
  });

  it("surfaces the pending question's full input read-only", async () => {
    const t = setup(
      asstLine(1, [
        {
          type: "tool_use",
          id: "q",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Which?",
                multiSelect: false,
                options: [{ label: "A", description: "d" }],
              },
            ],
          },
        },
      ]),
    );
    expect(agent(await t.handlers.chat("t1")).asking).toMatchObject({ tool: "AskUserQuestion" });
  });

  it("keeps at most 8 sessions and drops a pane's with the pane", async () => {
    const t = setup(userLine(1));
    await t.handlers.chat("t1");
    expect(t.handlers.cached()).toBe(1);
    t.handlers.forgetPane("t1");
    expect(t.handlers.cached()).toBe(0);
    for (let i = 0; i < 12; i++) {
      vi.mocked(t.deps.sessions.session).mockResolvedValue({ ...SESSION(), sessionId: `s${i}` });
      await t.handlers.chat("t1");
    }
    expect(t.handlers.cached()).toBeLessThanOrEqual(8);
  });

  it("answers the agent with readFailed, not none, when a read fails: the last page stays", async () => {
    const t = setup(userLine(1) + userLine(2));
    const good = agent(await t.handlers.chat("t1"));
    vi.mocked(t.deps.statFile).mockRejectedValue(new Error("secret/path"));
    const failed = agent(await t.handlers.chat("t1"));
    expect(failed.readFailed).toBe(true);
    expect(ids(failed)).toEqual(ids(good));
    expect(failed.sessionId).toBe(good.sessionId);
    expect(good.readFailed).toBeUndefined();
    vi.mocked(t.deps.statFile).mockImplementation(async () => ({ size: 1, mtimeMs: 1, ino: 1 }));
    expect(agent(await t.handlers.chat("t1")).readFailed).toBeUndefined();
  });

  it("answers an empty session, not readFailed, while the transcript is missing, then loads it", async () => {
    const t = setup(userLine(1));
    const real = vi.mocked(t.deps.statFile).getMockImplementation();
    vi.mocked(t.deps.statFile).mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
    );
    const empty = agent(await t.handlers.chat("t1"));
    expect(empty.readFailed).toBeUndefined();
    expect(empty.page.items).toEqual([]);
    expect(t.deps.log).not.toHaveBeenCalledWith("agent-chat: read");
    if (real !== undefined) vi.mocked(t.deps.statFile).mockImplementation(real);
    expect(ids(agent(await t.handlers.chat("t1"))).length).toBeGreaterThan(0);
  });

  it("keeps the pending session's view when the real session for the same process then fails to read", async () => {
    const pending = {
      ...SESSION(),
      sessionId: "pending-1-9",
      startedAt: 9,
      pending: true as const,
    };
    delete (pending as { transcriptPath?: string }).transcriptPath;
    const t = setup(userLine(1), { sessions: [pending] });
    const first = agent(await t.handlers.chat("t1"));
    expect(first.sessionId).toBe("pending-1-9");
    vi.mocked(t.deps.sessions.session).mockResolvedValue({
      ...SESSION(),
      startedAt: 9,
      sessionId: "real-1",
    });
    vi.mocked(t.deps.statFile).mockRejectedValue(new Error("disk"));
    const failed = agent(await t.handlers.chat("t1"));
    expect(failed).toMatchObject({ readFailed: true, sessionId: "pending-1-9" });
    // Another process's session does not inherit the pending view.
    vi.mocked(t.deps.sessions.session).mockResolvedValue({
      ...SESSION(),
      pid: 2,
      startedAt: 9,
      sessionId: "real-2",
    });
    expect(agent(await t.handlers.chat("t1")).sessionId).toBe("real-2");
  });

  it("answers an empty agent view with readFailed when the very first read fails", async () => {
    const t = setup(userLine(1));
    vi.mocked(t.deps.statFile).mockRejectedValue(new Error("x"));
    const view = agent(await t.handlers.chat("t1"));
    expect(view).toMatchObject({ readFailed: true, vendor: "anthropic", page: { items: [] } });
  });

  it("logs only tokens and never throws when a read fails", async () => {
    const t = setup(userLine(1));
    vi.mocked(t.deps.statFile).mockRejectedValue(new Error("secret/path"));
    const view = await t.handlers.chat("t1");
    expect(view.kind).toBe("agent");
    for (const call of vi.mocked(t.deps.log).mock.calls)
      expect(String(call[0])).not.toContain("secret");
  });

  describe("status line and limits", () => {
    const RULE = "─".repeat(40);
    const claudeScreen = (...rows: string[]): string =>
      ["output", RULE, "❯ ", RULE, ...rows, "  ? for shortcuts"].join("\n");
    const codexLimitsLine = (primary: unknown, secondary: unknown): string =>
      line({
        type: "event_msg",
        payload: { type: "token_count", rate_limits: { primary, secondary } },
      });

    it("shows the screen's status rows and limits", async () => {
      const t = setup(userLine(1), {
        screen: claudeScreen("  Session █░░ 13% resets 04:20", "  work-account"),
      });
      const view = agent(await t.handlers.chat("t1"));
      expect(view.status).toEqual({
        lines: ["Session 13% resets 04:20", "work-account"],
        limits: [{ label: "Session", usedPercent: 13, resets: "04:20" }],
        details: {},
      });
      expect(
        agent(await setup(userLine(1), { screen: claudeScreen() }).handlers.chat("t1")).status,
      ).toBeUndefined();
    });

    it("keeps the last status for the same session while the screen gives none, then drops it", async () => {
      const t = setup(userLine(1), { screen: claudeScreen("  work-account") });
      expect(agent(await t.handlers.chat("t1")).status).toEqual({
        lines: ["work-account"],
        limits: [],
        details: {},
      });
      t.state.screen = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n");
      expect(agent(await t.handlers.chat("t1")).status).toEqual({
        lines: ["work-account"],
        limits: [],
        details: {},
        stale: true,
      });
      t.state.screen = claudeScreen("  other-account");
      expect(agent(await t.handlers.chat("t1")).status?.stale).toBeUndefined();
      t.state.screen = "";
      vi.mocked(t.deps.sessions.session).mockResolvedValue({ ...SESSION(), sessionId: "another" });
      expect(agent(await t.handlers.chat("t1")).status).toBeUndefined();
    });

    it("merges Codex's transcript limits, dropping a window that has already reset", async () => {
      const now = Date.parse("2026-11-24T10:00:00Z");
      const t = setup(
        codexLimitsLine(
          { used_percent: 10, window_minutes: 300, resets_at: now / 1000 + 3600 },
          { used_percent: 50, window_minutes: 10080, resets_at: now / 1000 - 5 },
        ),
        {
          vendor: "openai",
          screen: "› Ask\n  GPT-6-Luna default · /private/tmp/x\n  ? for shortcuts",
        },
      );
      t.deps.now = () => now;
      const view = agent(await t.handlers.chat("t1"));
      expect(view.status?.lines).toEqual(["GPT-6-Luna default · /private/tmp/x"]);
      expect(view.status?.details).toEqual({
        model: "GPT-6-Luna default",
        folder: "/private/tmp/x",
      });
      expect(view.status?.limits).toHaveLength(1);
      expect(view.status?.limits[0]).toMatchObject({ label: "5h", usedPercent: 10 });
      expect(view.status?.limits[0]?.resets).toMatch(/\d\d:\d\d/);
    });

    it("words a reset more than six days away with its date", async () => {
      const now = new Date(2026, 10, 24, 10, 0).getTime();
      const far = new Date(2026, 11, 19, 12, 43).getTime() / 1000;
      const t = setup(
        codexLimitsLine({ used_percent: 3, window_minutes: 43200, resets_at: far }, null),
        { vendor: "openai", screen: "" },
      );
      t.deps.now = () => now;
      expect(agent(await t.handlers.chat("t1")).status?.limits[0]?.resets).toBe("19 Dec 12:43");
    });

    it("shows transcript limits even with no screen rows", async () => {
      const t = setup(codexLimitsLine({ used_percent: 3, window_minutes: 300 }, null), {
        vendor: "openai",
        screen: "",
      });
      expect(agent(await t.handlers.chat("t1")).status).toEqual({
        lines: [],
        limits: [{ label: "5h", usedPercent: 3 }],
        details: {},
      });
    });
  });
});
