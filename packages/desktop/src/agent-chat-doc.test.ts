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

  it("logs only tokens and never throws when a read fails", async () => {
    const t = setup(userLine(1));
    vi.mocked(t.deps.statFile).mockRejectedValue(new Error("secret/path"));
    const view = await t.handlers.chat("t1");
    expect(view).toEqual({ kind: "none" });
    for (const call of vi.mocked(t.deps.log).mock.calls)
      expect(String(call[0])).not.toContain("secret");
  });
});
