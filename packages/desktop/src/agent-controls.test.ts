import { describe, expect, it, vi } from "vitest";
import { type AgentControlDeps, createAgentControls } from "./agent-controls.js";
import type { PaneAgentSession } from "./pane-agent-session.js";

const RULE = "─".repeat(40);
type Mode = "default" | "acceptEdits" | "plan" | "auto";
const STATUS: Record<Mode, string> = {
  default: "  ? for shortcuts",
  acceptEdits: "  ⏵⏵ accept edits on (shift+tab to cycle)",
  plan: "  ⏸ plan mode on (shift+tab to cycle)",
  auto: "  ⏵⏵ auto mode on (shift+tab to cycle)",
};
const ORDER: Mode[] = ["default", "acceptEdits", "plan", "auto"];

type Pane = { mode: Mode | "hidden"; busy: boolean; draft: string; menu: boolean; frozen: boolean };

function claudeScreen(pane: Pane): string {
  if (pane.menu) {
    return [
      "Bash command",
      "  ls",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "Esc to cancel",
    ].join("\n");
  }
  return [
    "done",
    ...(pane.busy ? ["✻ Crunching… (5s · esc to interrupt)"] : ["✻ Baked for 3s · done 12:34 AM"]),
    RULE,
    pane.draft === "" ? "❯" : `❯ ${pane.draft}`,
    RULE,
    ...(pane.mode === "hidden" ? [] : [STATUS[pane.mode]]),
  ].join("\n");
}

const SESSION = (vendor: PaneAgentSession["vendor"] = "anthropic"): PaneAgentSession => ({
  paneKey: "t1",
  pid: 1,
  vendor,
  sessionId: "s",
  transcriptPath: "/t/s.jsonl",
  cwd: "/repo",
});

function setup(
  pane: Partial<Pane> = {},
  options: {
    vendor?: PaneAgentSession["vendor"];
    screen?: (pane: Pane) => string;
    names?: string[];
  } = {},
) {
  const state: Pane = {
    mode: "default",
    busy: false,
    draft: "",
    menu: false,
    frozen: false,
    ...pane,
  };
  const writes: string[] = [];
  const deps: AgentControlDeps = {
    sessions: {
      session: vi.fn(async () => SESSION(options.vendor)),
      live: vi.fn((paneKey: unknown) => paneKey === "t1"),
    },
    screenText: vi.fn(() => (options.screen ?? claudeScreen)(state)),
    write: vi.fn((_paneKey: string, data: string) => {
      writes.push(data);
      if (data === "\x1b[Z" && !state.frozen && state.mode !== "hidden") {
        state.mode = ORDER[(ORDER.indexOf(state.mode) + 1) % ORDER.length] ?? "default";
      }
      if (data === "\x1b") state.busy = false;
    }),
    sleep: vi.fn(async () => undefined),
    log: vi.fn(),
    commandNames: vi.fn(async () => new Set(options.names ?? [])),
  };
  return { controls: createAgentControls(deps), deps, state, writes };
}

describe("agentStop", () => {
  it("writes exactly one ESC when the agent is busy with no prompt", async () => {
    const t = setup({ busy: true });
    expect(await t.controls.stop("t1")).toEqual({ ok: true });
    expect(t.writes).toEqual(["\x1b"]);
  });

  it.each([
    ["idle", { busy: false }, "idle"],
    ["a menu", { busy: true, menu: true }, "prompt"],
    ["a draft hiding the busy reading", { busy: false, draft: "typing" }, "draft"],
  ])("refuses %s, writing nothing", async (_n, pane, reason) => {
    const t = setup(pane);
    expect(await t.controls.stop("t1")).toEqual({ ok: false, reason });
    expect(t.writes).toEqual([]);
  });

  it("refuses an unknown pane, a plain shell and a vendor without a stop key", async () => {
    const t = setup({ busy: true });
    expect(await t.controls.stop("x")).toEqual({ ok: false, reason: "gone" });
    vi.mocked(t.deps.sessions.session).mockResolvedValue(undefined);
    expect(await t.controls.stop("t1")).toEqual({ ok: false, reason: "gone" });
    const copilot = setup({ busy: true }, { vendor: "github" });
    expect(await copilot.controls.stop("t1")).toEqual({ ok: false, reason: "unsupported" });
    expect(t.writes).toEqual([]);
  });

  it("reads the screen after the scan, in the same tick as the write", async () => {
    const t = setup({ busy: true });
    vi.mocked(t.deps.sessions.session).mockImplementation(async () => {
      t.state.menu = true; // a menu drawn while the scan awaited
      return SESSION();
    });
    expect(await t.controls.stop("t1")).toEqual({ ok: false, reason: "prompt" });
    expect(t.writes).toEqual([]);
  });
});

describe("agentMode", () => {
  it("presses Shift+Tab until the screen shows the wanted mode, reading before each press", async () => {
    const t = setup({ mode: "default" });
    expect(await t.controls.mode("t1", "plan")).toEqual({ ok: true, mode: "plan" });
    expect(t.writes).toEqual(["\x1b[Z", "\x1b[Z"]);
  });

  it("does nothing when already there, and stops after 5 presses", async () => {
    const same = setup({ mode: "plan" });
    expect(await same.controls.mode("t1", "plan")).toEqual({ ok: true, mode: "plan" });
    expect(same.writes).toEqual([]);
    const never = setup({ mode: "default" });
    // `auto` is not in this cycle: a pane that never shows it is stopped.
    never.state.frozen = true;
    expect(await never.controls.mode("t1", "plan")).toEqual({
      ok: false,
      reason: "stuck",
      mode: "default",
    });
    expect(never.writes.length).toBeLessThanOrEqual(5);
  });

  it("never presses when the mode is not readable on the screen", async () => {
    const t = setup({ mode: "hidden" });
    expect(await t.controls.mode("t1", "plan")).toEqual({ ok: false, reason: "unreadable" });
    expect(t.writes).toEqual([]);
  });

  it("stops with a reason when a menu appears between presses", async () => {
    const t = setup({ mode: "default" });
    vi.mocked(t.deps.write).mockImplementation((_p, data) => {
      t.writes.push(data);
      t.state.menu = true;
    });
    expect(await t.controls.mode("t1", "auto")).toEqual({ ok: false, reason: "prompt" });
    expect(t.writes).toEqual(["\x1b[Z"]);
  });

  it("refuses at a menu, with a draft, for other vendors, and for an unknown mode", async () => {
    expect(await setup({ menu: true }).controls.mode("t1", "plan")).toEqual({
      ok: false,
      reason: "prompt",
    });
    const draft = setup({ draft: "half a thought" });
    expect(await draft.controls.mode("t1", "plan")).toEqual({ ok: false, reason: "draft" });
    expect(draft.writes).toEqual([]);
    const codex = setup({}, { vendor: "openai" });
    expect(await codex.controls.mode("t1", "plan")).toEqual({ ok: false, reason: "unsupported" });
    expect(await setup().controls.mode("t1", "turbo")).toEqual({ ok: false, reason: "invalid" });
    expect(await setup().controls.mode("t1", 7)).toEqual({ ok: false, reason: "invalid" });
  });

  it("works while the agent is busy but not with a draft", async () => {
    const t = setup({ busy: true, mode: "default" });
    expect(await t.controls.mode("t1", "acceptEdits")).toEqual({ ok: true, mode: "acceptEdits" });
  });
});

describe("agentCommand", () => {
  const PASTE = (text: string) => `\u001b[200~${text}\u001b[201~\r`;

  it("sends an allow-listed command as one bracketed paste", async () => {
    const t = setup();
    expect(await t.controls.command("t1", "/model sonnet")).toEqual({ ok: true });
    expect(t.writes).toEqual([PASTE("/model sonnet")]);
    expect(await t.controls.command("t1", "/compact")).toEqual({ ok: true });
  });

  it("accepts a discovered custom command by name only", async () => {
    const t = setup({}, { names: ["deploy"] });
    expect(await t.controls.command("t1", "/deploy staging")).toEqual({ ok: true });
    expect(await t.controls.command("t1", "/other")).toEqual({ ok: false, reason: "unknown" });
  });

  it.each([
    "model sonnet",
    "/model sonnet; rm -rf /",
    "/model $(whoami)",
    "/model a b",
    "/model\nnext",
    "/model \u001b[31m",
    "//model",
    "/",
    `/model ${"x".repeat(100)}`,
    "",
  ])("rejects %j as invalid", async (text) => {
    const t = setup();
    expect(await t.controls.command("t1", text)).toEqual({ ok: false, reason: "invalid" });
    expect(t.writes).toEqual([]);
  });

  it("refuses while busy, at a menu, with a draft, and in a plain shell", async () => {
    expect(await setup({ busy: true }).controls.command("t1", "/compact")).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(await setup({ menu: true }).controls.command("t1", "/compact")).toEqual({
      ok: false,
      reason: "prompt",
    });
    expect(await setup({ draft: "hi" }).controls.command("t1", "/compact")).toEqual({
      ok: false,
      reason: "draft",
    });
    const t = setup();
    vi.mocked(t.deps.sessions.session).mockResolvedValue(undefined);
    expect(await t.controls.command("t1", "/compact")).toEqual({ ok: false, reason: "gone" });
    expect(await t.controls.command("nope", "/compact")).toEqual({ ok: false, reason: "gone" });
  });

  it("lists no command a vendor does not have", async () => {
    const codex = setup({}, { vendor: "openai", screen: () => "› Ask Codex to do anything" });
    expect(await codex.controls.command("t1", "/rollout")).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(await codex.controls.command("t1", "/new")).toEqual({ ok: true });
    expect(await codex.controls.command("t1", "/approvals")).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("knows a built-in by its alias too, and the table's newer names", async () => {
    const claude = setup();
    expect(await claude.controls.command("t1", "/cost")).toEqual({ ok: true });
    const codexNow = setup({}, { vendor: "openai", screen: () => "› Ask Codex to do anything" });
    expect(await codexNow.controls.command("t1", "/mention src")).toEqual({ ok: true });
  });
});
