// @vitest-environment jsdom
//
// The Workspace's Terminal tabs. xterm.js renders to a canvas and measures
// real character cells, neither of which jsdom has, so the vendored modules
// are doubled exactly as session-view.test.ts doubles them. What is under
// test is Jarvis's half: one terminal per tab, which one is visible, where
// keystrokes go, and what happens when a tab goes away.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "@jarvis/core";
import { FakeFitAddon, FakeTerminal } from "./terminal-double.js";

vi.mock("./vendor/xterm.mjs", () => ({ Terminal: FakeTerminal }));
vi.mock("./vendor/addon-fit.mjs", () => ({ FitAddon: FakeFitAddon }));

type Recorded = { call: string; args: unknown[] };

/** Ctrl-C, written as an escape so the byte itself never sits in the file. */
const CTRL_C = "\u0003";

function tab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    project: "acme",
    url: "",
    kind: "terminal",
    title: "acme — Terminal",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: undefined,
    ...overrides,
  };
}

let calls: Recorded[];
let dataListener: ((tabId: string, chunk: string) => void) | undefined;
let exitListener: ((tabId: string, code: number) => void) | undefined;

function harness(buffered = ""): void {
  document.body.innerHTML = `<div id="workspace-terminal" hidden></div>`;
  calls = [];
  dataListener = undefined;
  exitListener = undefined;
  FakeTerminal.instances = [];
  (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
    onTerminalData: (cb: (tabId: string, chunk: string) => void) => {
      dataListener = cb;
    },
    onTerminalExit: (cb: (tabId: string, code: number) => void) => {
      exitListener = cb;
    },
    attachTerminal: (tabId: string) => {
      calls.push({ call: "attachTerminal", args: [tabId] });
      return Promise.resolve(buffered);
    },
    sendTerminalInput: (tabId: string, data: string) => {
      calls.push({ call: "sendTerminalInput", args: [tabId, data] });
      return Promise.resolve();
    },
    resizeTerminal: (tabId: string, cols: number, rows: number) => {
      calls.push({ call: "resizeTerminal", args: [tabId, cols, rows] });
      return Promise.resolve();
    },
  };
}

async function load() {
  vi.resetModules();
  const module = await import("./workspace-terminal.js");
  module.initWorkspaceTerminals();
  return module;
}

describe("workspace terminals", () => {
  beforeEach(() => harness());

  it("builds one terminal for the active terminal tab", async () => {
    const { renderWorkspaceTerminals } = await load();

    renderWorkspaceTerminals([tab()], "tab-1");

    expect(FakeTerminal.instances).toHaveLength(1);
    expect(document.getElementById("workspace-terminal")?.hidden).toBe(false);
  });

  it("keeps the host hidden when the active tab is not a terminal", async () => {
    const { renderWorkspaceTerminals } = await load();

    renderWorkspaceTerminals([tab({ kind: "web", url: "https://github.com" })], "tab-1");

    expect(FakeTerminal.instances).toHaveLength(0);
    expect(document.getElementById("workspace-terminal")?.hidden).toBe(true);
  });

  // Scrollback lives in the xterm instance, so switching away and back must
  // find the same one rather than building a second.
  it("reuses a tab's terminal across activations", async () => {
    const { renderWorkspaceTerminals } = await load();
    const tabs = [tab(), tab({ id: "tab-2", kind: "web", url: "https://x.test" })];

    renderWorkspaceTerminals(tabs, "tab-1");
    renderWorkspaceTerminals(tabs, "tab-2");
    renderWorkspaceTerminals(tabs, "tab-1");

    expect(FakeTerminal.instances).toHaveLength(1);
  });

  it("shows only the active terminal when two are open", async () => {
    const { renderWorkspaceTerminals } = await load();
    const tabs = [tab(), tab({ id: "tab-2" })];

    renderWorkspaceTerminals(tabs, "tab-1");
    renderWorkspaceTerminals(tabs, "tab-2");

    const panes = [...document.querySelectorAll<HTMLElement>(".workspace-terminal-pane")];
    expect(panes).toHaveLength(2);
    expect(panes.map((pane) => pane.hidden)).toEqual([true, false]);
  });

  it("writes the output of the tab it belongs to, and no other", async () => {
    const { renderWorkspaceTerminals } = await load();
    const tabs = [tab(), tab({ id: "tab-2" })];
    renderWorkspaceTerminals(tabs, "tab-1");
    renderWorkspaceTerminals(tabs, "tab-2");

    dataListener?.("tab-1", "hello");

    expect(FakeTerminal.instances[0]?.text).toBe("hello");
    expect(FakeTerminal.instances[1]?.text).toBe("");
  });

  it("replays what the shell printed before the pane existed", async () => {
    harness("$ ");
    const { renderWorkspaceTerminals } = await load();

    renderWorkspaceTerminals([tab()], "tab-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toContainEqual({ call: "attachTerminal", args: ["tab-1"] });
    expect(FakeTerminal.instances[0]?.text).toBe("$ ");
  });

  // Control bytes verbatim: this is the Ctrl-C that has to reach the pty as
  // a signal rather than as text.
  it("sends every keystroke back with its own tab id", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1");

    FakeTerminal.instances[0]?.emitData(CTRL_C);

    expect(calls).toContainEqual({ call: "sendTerminalInput", args: ["tab-1", CTRL_C] });
  });

  it("reports a new cell grid to the pty", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1");

    FakeTerminal.instances[0]?.emitResize(120, 40);

    expect(calls).toContainEqual({ call: "resizeTerminal", args: ["tab-1", 120, 40] });
  });

  // The tab is kept, because its scrollback is usually why you were there.
  it("says so in the terminal when the shell exits", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1");

    exitListener?.("tab-1", 130);

    expect(FakeTerminal.instances[0]?.text).toContain("[process exited with code 130]");
  });

  it("disposes a closed tab's terminal and removes its pane", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1");

    renderWorkspaceTerminals([], undefined);

    expect(FakeTerminal.instances[0]?.disposed).toBe(true);
    expect(document.querySelectorAll(".workspace-terminal-pane")).toHaveLength(0);
    expect(document.getElementById("workspace-terminal")?.hidden).toBe(true);
  });
});
