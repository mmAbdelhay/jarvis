import type { ExternalAgentProcess } from "@jarvis/platform";
import { describe, expect, it, vi } from "vitest";
import { createAgentViewHandlers, type AgentViewDeps } from "./agent-view.js";
import type { PaneAgentSession } from "./pane-agent-session.js";

const CLAUDE_PROMPT = [
  "Bash command",
  "  rm -rf build",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No, and tell Claude what to do differently (esc)",
].join("\n");
const CODEX_PROMPT = ["Allow Codex to run `ls` in /repo? (y/n)"].join("\n");
// A highlighted menu row: readPrompt cannot drive it (so no card), but the
// input-state read still calls it an approval prompt.
const CODEX_MENU = [
  "Would you like to run the following command?",
  "› 1. Yes, proceed (y)",
  "  2. No, and tell Codex what to do differently (esc)",
].join("\n");
const CODEX_IDLE = ["some output", "› Ask Codex to do anything"].join("\n");
const CODEX_BUSY = ["• Working (8s • esc to interrupt)", "› "].join("\n");
const CLAUDE_BUSY = ["✻ Crunching… (5m 43s · esc to interrupt)", "", "⏸ plan mode on"].join("\n");
const CLAUDE_IDLE = ["done", "────────────────", "❯ ", "────────────────"].join("\n");

const CLAUDE_TRANSCRIPT = [
  { type: "user", message: { role: "user", content: "fix the build" } },
  {
    type: "assistant",
    message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "On it." }] },
  },
]
  .map((record) => JSON.stringify(record))
  .join("\n");
const COPILOT_TRANSCRIPT = [
  { type: "user.message", data: { content: "hello copilot" } },
  { type: "assistant.message", data: { content: "hi", model: "gpt-x" } },
]
  .map((record) => JSON.stringify(record))
  .join("\n");
const CODEX_TRANSCRIPT = [
  { type: "turn_context", payload: { model: "codex-x" } },
  {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "UserMessage", content: [{ type: "Text", text: "hello codex" }] },
    },
  },
]
  .map((record) => JSON.stringify(record))
  .join("\n");

function sessionOf(vendor: PaneAgentSession["vendor"]): PaneAgentSession {
  return {
    paneKey: "t1",
    pid: 42,
    vendor,
    sessionId: `${vendor}-1`,
    name: "named",
    transcriptPath: `/t/${vendor}.jsonl`,
    cwd: "/repo",
  };
}

const processOf = (): ExternalAgentProcess => ({
  pid: 42,
  agentId: "a",
  command: "a",
  cwd: "/repo",
  startedAt: 0,
  terminalPaneKey: "t1",
  foreground: true,
});

function fakeDeps(
  vendor: PaneAgentSession["vendor"] | undefined,
  screen: string,
  overrides: Partial<AgentViewDeps> = {},
): AgentViewDeps {
  const transcripts = {
    anthropic: CLAUDE_TRANSCRIPT,
    github: COPILOT_TRANSCRIPT,
    openai: CODEX_TRANSCRIPT,
  };
  const text = vendor === undefined ? "" : transcripts[vendor];
  return {
    panes: vi.fn(() => [{ paneKey: "t1", exited: false }]),
    scanAgents: vi.fn(async () => (vendor === undefined ? [] : [processOf()])),
    lookup: {
      forProcess: vi.fn(async () => (vendor === undefined ? undefined : sessionOf(vendor))),
      retain: vi.fn(),
    },
    readTail: vi.fn(async () => text),
    statFile: vi.fn(async () => ({ size: text.length, mtimeMs: 1 })),
    now: vi.fn(() => 0),
    notice: vi.fn(),
    screenText: vi.fn(() => screen),
    write: vi.fn(),
    log: vi.fn(),
    follow: vi.fn(),
    forget: vi.fn(),
    ...overrides,
  };
}

describe("agentView", () => {
  it("is none for a plain pane and never notices, follows or scans for a dead one", async () => {
    const deps = fakeDeps(undefined, "$ npm run dev");
    const handlers = createAgentViewHandlers(deps);
    expect(await handlers.view("t1")).toEqual({ kind: "none" });
    expect(deps.notice).not.toHaveBeenCalled();
    expect(deps.follow).not.toHaveBeenCalled();
    expect(await handlers.view(7)).toEqual({ kind: "none" });
    expect(await handlers.view("gone")).toEqual({ kind: "none" });
    expect(deps.scanAgents).toHaveBeenCalledTimes(1);
  });

  it("notices and follows once an agent is found", async () => {
    const deps = fakeDeps("github", "");
    await createAgentViewHandlers(deps).view("t1");
    expect(deps.notice).toHaveBeenCalledWith("t1");
    expect(deps.follow).toHaveBeenCalledWith("t1", { dir: "/t", file: "github.jsonl" });
  });

  it("shows Claude with its mode, spinner and prompt, without keys", async () => {
    const plan = await createAgentViewHandlers(fakeDeps("anthropic", CLAUDE_BUSY)).view("t1");
    expect(plan).toEqual({
      kind: "agent",
      vendor: "anthropic",
      sessionId: "anthropic-1",
      title: "named",
      model: "claude-x",
      mode: "plan",
      turns: [
        { role: "user", text: "fix the build", tools: [] },
        { role: "assistant", text: "On it.", tools: [] },
      ],
      working: "Crunching… 5m 43s",
    });
    const asked = await createAgentViewHandlers(fakeDeps("anthropic", CLAUDE_PROMPT)).view("t1");
    expect(asked).toMatchObject({
      prompt: {
        question: "Do you want to proceed?",
        options: [{ label: "Yes" }, { label: "No, and tell Claude what to do differently (esc)" }],
      },
    });
    expect(JSON.stringify(asked)).not.toContain("keys");
  });

  it("shows Copilot and Codex from their own transcripts, busy as a generic label, no mode", async () => {
    const copilot = await createAgentViewHandlers(fakeDeps("github", "")).view("t1");
    expect(copilot).toMatchObject({
      vendor: "github",
      model: "gpt-x",
      turns: [
        { role: "user", text: "hello copilot", tools: [] },
        { role: "assistant", text: "hi", tools: [] },
      ],
    });
    expect(copilot).not.toHaveProperty("mode");
    expect(copilot).not.toHaveProperty("working");

    const codex = await createAgentViewHandlers(fakeDeps("openai", CODEX_BUSY)).view("t1");
    expect(codex).toMatchObject({ vendor: "openai", model: "codex-x", working: "Working…" });
    expect(codex).not.toHaveProperty("mode");
    const idle = await createAgentViewHandlers(fakeDeps("openai", CODEX_IDLE)).view("t1");
    expect(idle).not.toHaveProperty("working");
  });

  it("never leaks the keys of a Codex prompt", async () => {
    const view = await createAgentViewHandlers(fakeDeps("openai", CODEX_PROMPT)).view("t1");
    expect(view).toMatchObject({
      prompt: { options: [{ label: "Yes" }, { label: "No" }] },
    });
    expect(JSON.stringify(view)).not.toContain("keys");
    expect(JSON.stringify(view)).not.toContain("\\u001b");
  });

  it("reuses the parse of an unchanged transcript", async () => {
    const deps = fakeDeps("github", "");
    const handlers = createAgentViewHandlers(deps);
    await handlers.view("t1");
    await handlers.view("t1");
    expect(deps.readTail).toHaveBeenCalledTimes(1);
  });

  it("is none, logging only a token, when a dependency fails", async () => {
    const deps = fakeDeps("github", "", {
      readTail: vi.fn(async () => {
        throw new Error("secret transcript text");
      }),
    });
    expect(await createAgentViewHandlers(deps).view("t1")).toEqual({ kind: "none" });
    const logged = vi.mocked(deps.log).mock.calls.flat().join(" ");
    expect(logged).toContain("agent-view:");
    expect(logged).not.toContain("secret");
  });
});

describe("agentView peek", () => {
  it("reads the same view as view() without noticing, following or forgetting", async () => {
    const seen = fakeDeps("anthropic", CLAUDE_BUSY);
    const peeked = await createAgentViewHandlers(seen).peek("t1");
    const viewed = await createAgentViewHandlers(fakeDeps("anthropic", CLAUDE_BUSY)).view("t1");
    expect(peeked).toEqual(viewed);
    expect(peeked.kind).toBe("agent");
    expect(seen.notice).not.toHaveBeenCalled();
    expect(seen.follow).not.toHaveBeenCalled();
    expect(seen.forget).not.toHaveBeenCalled();
  });

  it("is none for a plain pane, an unknown pane and a non-string key", async () => {
    const handlers = createAgentViewHandlers(fakeDeps(undefined, "$ ls"));
    expect(await handlers.peek("t1")).toEqual({ kind: "none" });
    expect(await handlers.peek("gone")).toEqual({ kind: "none" });
    expect(await handlers.peek(7)).toEqual({ kind: "none" });
  });

  it("throws, never answers none, when a read fails", async () => {
    const scan = createAgentViewHandlers(
      fakeDeps("anthropic", "", {
        scanAgents: vi.fn(async () => {
          throw new Error("scan");
        }),
      }),
    );
    await expect(scan.peek("t1")).rejects.toThrow("scan");
    const transcript = createAgentViewHandlers(
      fakeDeps("anthropic", "", {
        readTail: vi.fn(async () => {
          throw new Error("disk");
        }),
      }),
    );
    await expect(transcript.peek("t1")).rejects.toThrow("transcript");
    const panes = createAgentViewHandlers(
      fakeDeps("anthropic", "", {
        panes: vi.fn(() => {
          throw new Error("x");
        }),
      }),
    );
    await expect(panes.peek("t1")).rejects.toThrow("panes");
  });
});

describe("agentView needsTerm", () => {
  it("flags a menu readPrompt cannot read, without a prompt", async () => {
    const view = await createAgentViewHandlers(fakeDeps("openai", CODEX_MENU)).view("t1");
    expect(view).toMatchObject({ kind: "agent", needsTerm: true });
    expect(view).not.toHaveProperty("prompt");
  });

  it("does not flag a readable prompt or an idle agent", async () => {
    for (const [vendor, screen] of [
      ["anthropic", CLAUDE_PROMPT],
      ["openai", CODEX_PROMPT],
      ["openai", CODEX_IDLE],
    ] as const) {
      const view = await createAgentViewHandlers(fakeDeps(vendor, screen)).view("t1");
      expect(view).not.toHaveProperty("needsTerm");
    }
  });
});

describe("agentAnswer", () => {
  it("types the keys read from the screen now, for the option that still matches", () => {
    const deps = fakeDeps("anthropic", CLAUDE_PROMPT);
    const out = createAgentViewHandlers(deps).answer(
      "t1",
      1,
      "No, and tell Claude what to do differently (esc)",
    );
    expect(out).toEqual({ ok: true });
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith("t1", expect.stringContaining("\r"));
  });

  it("refuses a label or index that does not match, and no prompt", () => {
    const deps = fakeDeps("openai", CODEX_PROMPT);
    const handlers = createAgentViewHandlers(deps);
    expect(handlers.answer("t1", 0, "No")).toEqual({ ok: false, reason: "changed" });
    expect(handlers.answer("t1", 9, "Yes")).toEqual({ ok: false, reason: "changed" });
    expect(handlers.answer("t1", 0.5, "Yes")).toEqual({ ok: false, reason: "changed" });
    expect(handlers.answer("gone", 0, "Yes")).toEqual({ ok: false, reason: "gone" });
    expect(deps.write).not.toHaveBeenCalled();
    const quiet = fakeDeps("openai", CODEX_IDLE);
    expect(createAgentViewHandlers(quiet).answer("t1", 0, "Yes")).toEqual({
      ok: false,
      reason: "gone",
    });
  });

  it("reports a failing write as gone", () => {
    const deps = fakeDeps("openai", CODEX_PROMPT, {
      write: vi.fn(() => {
        throw new Error("EPIPE");
      }),
    });
    expect(createAgentViewHandlers(deps).answer("t1", 0, "Yes")).toEqual({
      ok: false,
      reason: "gone",
    });
  });
});

describe("agentSend", () => {
  const PASTE = (text: string) => `\u001b[200~${text}\u001b[201~\r`;

  it("pastes the text as one bracketed paste and one Enter, exactly", async () => {
    const deps = fakeDeps("openai", CODEX_IDLE);
    expect(await createAgentViewHandlers(deps).send("t1", "run it\nthen stop\tok")).toEqual({
      ok: true,
    });
    expect(deps.write).toHaveBeenCalledWith("t1", PASTE("run it\nthen stop\tok"));
  });

  it("strips ESC and other controls, so the paste cannot end early", async () => {
    const deps = fakeDeps("anthropic", CLAUDE_IDLE);
    await createAgentViewHandlers(deps).send("t1", "a\u001b[201~b\u0003c\u0000d");
    expect(deps.write).toHaveBeenCalledWith("t1", PASTE("a[201~bcd"));
  });

  it("refuses at a prompt of any kind, writing nothing", async () => {
    for (const [vendor, screen] of [
      ["anthropic", CLAUDE_PROMPT],
      ["openai", CODEX_PROMPT],
      ["openai", CODEX_MENU],
      ["openai", "Press Enter to continue"],
    ] as const) {
      const deps = fakeDeps(vendor, screen);
      expect(await createAgentViewHandlers(deps).send("t1", "yes")).toEqual({
        ok: false,
        reason: "prompt",
      });
      expect(deps.write).not.toHaveBeenCalled();
    }
  });

  it("refuses in a plain shell, even when the pane had an agent a moment ago", async () => {
    const deps = fakeDeps(undefined, "$ ");
    expect(await createAgentViewHandlers(deps).send("t1", "rm -rf /")).toEqual({
      ok: false,
      reason: "gone",
    });
    expect(deps.write).not.toHaveBeenCalled();

    const live = fakeDeps("openai", CODEX_IDLE);
    const handlers = createAgentViewHandlers(live);
    await handlers.view("t1");
    vi.mocked(live.scanAgents).mockResolvedValue([]);
    vi.mocked(live.lookup.forProcess).mockResolvedValue(undefined);
    expect(await handlers.send("t1", "ls")).toEqual({ ok: false, reason: "gone" });
    expect(live.write).not.toHaveBeenCalled();
  });

  it("refuses an exited pane and a failing write", async () => {
    const deps = fakeDeps("openai", CODEX_IDLE, { panes: () => [{ paneKey: "t1", exited: true }] });
    expect(await createAgentViewHandlers(deps).send("t1", "x")).toEqual({
      ok: false,
      reason: "gone",
    });
    const broken = fakeDeps("openai", CODEX_IDLE, {
      write: vi.fn(() => {
        throw new Error("EPIPE");
      }),
    });
    expect(await createAgentViewHandlers(broken).send("t1", "x")).toEqual({
      ok: false,
      reason: "gone",
    });
  });

  it("refuses invalid text: not a string, empty, only controls, over 64 KB", async () => {
    const deps = fakeDeps("openai", CODEX_IDLE);
    const handlers = createAgentViewHandlers(deps);
    for (const bad of [undefined, 5, "", "   \n", "\u001b\u0003", "x".repeat(64 * 1024 + 1)]) {
      expect(await handlers.send("t1", bad)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await handlers.send(7, "x")).toEqual({ ok: false, reason: "gone" });
    expect(deps.write).not.toHaveBeenCalled();
    expect(await handlers.send("t1", "x".repeat(64 * 1024))).toEqual({ ok: true });
  });

  it("logs no content", async () => {
    const deps = fakeDeps("openai", CODEX_PROMPT);
    await createAgentViewHandlers(deps).send("t1", "my-secret-message");
    expect(vi.mocked(deps.log).mock.calls.flat().join(" ")).not.toContain("secret");
  });
});
