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

/** ESC then CR: what Shift+Enter must send to mean "newline, not run". */
const ESC_CR = "\u001b\r";

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
    hasPlayingVideo: false,
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

    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    expect(FakeTerminal.instances).toHaveLength(1);
    expect(document.getElementById("workspace-terminal")?.hidden).toBe(false);
  });

  // Switching to a project with no open tab leaves the previous project's
  // tab "active" in the store (that is how switching back restores it), and
  // main hides the hosted views behind a flag the renderer cannot see. A
  // terminal is the renderer's own DOM, so it has to apply the same rule
  // itself or it would go on showing another project's shell.
  it("hides a terminal belonging to a project other than the selected one", async () => {
    const { renderWorkspaceTerminals } = await load();

    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    renderWorkspaceTerminals([tab()], "tab-1", "storefront");

    expect(document.getElementById("workspace-terminal")?.hidden).toBe(true);
  });

  it("brings it back when its project is selected again", async () => {
    const { renderWorkspaceTerminals } = await load();

    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    renderWorkspaceTerminals([tab()], "tab-1", "storefront");
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    expect(document.getElementById("workspace-terminal")?.hidden).toBe(false);
    expect(FakeTerminal.instances).toHaveLength(1);
  });

  it("keeps the host hidden when the active tab is not a terminal", async () => {
    const { renderWorkspaceTerminals } = await load();

    renderWorkspaceTerminals([tab({ kind: "web", url: "https://github.com" })], "tab-1", "acme");

    expect(FakeTerminal.instances).toHaveLength(0);
    expect(document.getElementById("workspace-terminal")?.hidden).toBe(true);
  });

  // Scrollback lives in the xterm instance, so switching away and back must
  // find the same one rather than building a second.
  it("reuses a tab's terminal across activations", async () => {
    const { renderWorkspaceTerminals } = await load();
    const tabs = [tab(), tab({ id: "tab-2", kind: "web", url: "https://x.test" })];

    renderWorkspaceTerminals(tabs, "tab-1", "acme");
    renderWorkspaceTerminals(tabs, "tab-2", "acme");
    renderWorkspaceTerminals(tabs, "tab-1", "acme");

    expect(FakeTerminal.instances).toHaveLength(1);
  });

  it("shows only the active terminal when two are open", async () => {
    const { renderWorkspaceTerminals } = await load();
    const tabs = [tab(), tab({ id: "tab-2" })];

    renderWorkspaceTerminals(tabs, "tab-1", "acme");
    renderWorkspaceTerminals(tabs, "tab-2", "acme");

    const panes = [...document.querySelectorAll<HTMLElement>(".workspace-terminal-pane")];
    expect(panes).toHaveLength(2);
    expect(panes.map((pane) => pane.hidden)).toEqual([true, false]);
  });

  it("writes the output of the tab it belongs to, and no other", async () => {
    const { renderWorkspaceTerminals } = await load();
    const tabs = [tab(), tab({ id: "tab-2" })];
    renderWorkspaceTerminals(tabs, "tab-1", "acme");
    renderWorkspaceTerminals(tabs, "tab-2", "acme");

    dataListener?.("tab-1", "hello");

    expect(FakeTerminal.instances[0]?.text).toBe("hello");
    expect(FakeTerminal.instances[1]?.text).toBe("");
  });

  it("replays what the shell printed before the pane existed", async () => {
    harness("$ ");
    const { renderWorkspaceTerminals } = await load();

    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toContainEqual({ call: "attachTerminal", args: ["tab-1"] });
    expect(FakeTerminal.instances[0]?.text).toBe("$ ");
  });

  // Control bytes verbatim: this is the Ctrl-C that has to reach the pty as
  // a signal rather than as text.
  it("sends every keystroke back with its own tab id", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    FakeTerminal.instances[0]?.emitData(CTRL_C);

    expect(calls).toContainEqual({ call: "sendTerminalInput", args: ["tab-1", CTRL_C] });
  });

  // xterm sends a bare CR for Shift+Enter, identical to Enter, so a shell or
  // a TUI cannot tell them apart. ESC+CR is the sequence the convention
  // settled on — it is what Claude Code's own terminal setup configures
  // iTerm2 to send — and it is the only way Shift+Enter can mean "newline"
  // rather than "run this".
  it("sends ESC+CR for shift+enter instead of a bare carriage return", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    const handled = FakeTerminal.instances[0]?.pressKey({ key: "Enter", shiftKey: true });

    expect(handled).toBe(false);
    expect(calls).toContainEqual({ call: "sendTerminalInput", args: ["tab-1", ESC_CR] });
  });

  // Returning false only tells xterm not to encode the key. The browser
  // still delivers Enter's own carriage return to the textarea, and xterm
  // sends that too — so the pty saw ESC CR *and then* a second CR, which
  // Claude Code read as "newline, then submit". The message went off
  // half-written every time.
  it("prevents the browser's own carriage return from following it", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    FakeTerminal.instances[0]?.pressKey({ key: "Enter", shiftKey: true });

    expect(FakeTerminal.instances[0]?.defaultPrevented).toBe(true);
    // Exactly one thing was sent: the sequence we meant, and nothing after.
    expect(calls.filter((entry) => entry.call === "sendTerminalInput")).toEqual([
      { call: "sendTerminalInput", args: ["tab-1", ESC_CR] },
    ]);
  });

  // Option+Enter is the same gesture on a Mac keyboard and the alias every
  // terminal that supports one supports too.
  it("treats option+enter the same way", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    FakeTerminal.instances[0]?.pressKey({ key: "Enter", altKey: true });

    expect(calls).toContainEqual({ call: "sendTerminalInput", args: ["tab-1", ESC_CR] });
  });

  it("leaves a plain Enter to xterm", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    const handled = FakeTerminal.instances[0]?.pressKey({ key: "Enter" });

    expect(handled).toBe(true);
    expect(calls.some((entry) => entry.call === "sendTerminalInput")).toBe(false);
  });

  it("leaves every other shifted key to xterm", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    expect(FakeTerminal.instances[0]?.pressKey({ key: "A", shiftKey: true })).toBe(true);
  });

  it("reports a new cell grid to the pty", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    FakeTerminal.instances[0]?.emitResize(120, 40);

    expect(calls).toContainEqual({ call: "resizeTerminal", args: ["tab-1", 120, 40] });
  });

  // The tab is kept, because its scrollback is usually why you were there.
  it("says so in the terminal when the shell exits", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    exitListener?.("tab-1", 130);

    expect(FakeTerminal.instances[0]?.text).toContain("[process exited with code 130]");
  });

  it("disposes a closed tab's terminal and removes its pane", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    renderWorkspaceTerminals([], undefined, "acme");

    expect(FakeTerminal.instances[0]?.disposed).toBe(true);
    expect(document.querySelectorAll(".workspace-terminal-pane")).toHaveLength(0);
    expect(document.getElementById("workspace-terminal")?.hidden).toBe(true);
  });
});

describe("terminal key bindings and addons", () => {
  beforeEach(() => harness());

  it("copies the selection on Cmd+C rather than letting the browser miss it", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
      configurable: true,
    });
    FakeTerminal.instances[0]!.selection = "SELECTED";

    const handled = FakeTerminal.instances[0]?.pressKey({ key: "c", metaKey: true });

    expect(handled).toBe(false);
    expect(written).toEqual(["SELECTED"]);
  });

  // With nothing selected Cmd+C has nothing to copy and must not swallow the
  // key — the terminal's own handling stays in charge.
  it("leaves Cmd+C alone when there is no selection", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    expect(FakeTerminal.instances[0]?.pressKey({ key: "c", metaKey: true })).toBe(true);
  });

  it("pastes the clipboard into the pty on Cmd+V", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: () => Promise.resolve("pasted") },
      configurable: true,
    });

    const handled = FakeTerminal.instances[0]?.pressKey({ key: "v", metaKey: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(handled).toBe(false);
    expect(calls).toContainEqual({ call: "sendTerminalInput", args: ["tab-1", "pasted"] });
  });

  it("clears the screen on Cmd+K", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    const handled = FakeTerminal.instances[0]?.pressKey({ key: "k", metaKey: true });

    expect(handled).toBe(false);
    expect(FakeTerminal.instances[0]?.cleared).toBe(1);
  });

  // Ctrl chords are real control bytes a program may want; only Cmd is the
  // app's to take.
  it("never takes a Ctrl chord for itself", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    expect(FakeTerminal.instances[0]?.pressKey({ key: "c", ctrlKey: true })).toBe(true);
    expect(FakeTerminal.instances[0]?.pressKey({ key: "k", ctrlKey: true })).toBe(true);
  });

  it("opens the find bar on Cmd+F and closes it on Escape", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    const bar = document.querySelector<HTMLElement>(".terminal-find")!;
    expect(bar.hidden).toBe(true);

    FakeTerminal.instances[0]?.pressKey({ key: "f", metaKey: true });
    expect(bar.hidden).toBe(false);

    document
      .querySelector(".terminal-find-input")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(bar.hidden).toBe(true);
  });

  it("gives each terminal its own find bar", async () => {
    const { renderWorkspaceTerminals } = await load();
    const tabs = [tab(), tab({ id: "tab-2" })];
    renderWorkspaceTerminals(tabs, "tab-1", "acme");
    renderWorkspaceTerminals(tabs, "tab-2", "acme");

    expect(document.querySelectorAll(".terminal-find")).toHaveLength(2);
  });

  it("switches the terminal to unicode 11 width rules", async () => {
    const { renderWorkspaceTerminals } = await load();

    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    expect(FakeTerminal.instances[0]?.unicode.activeVersion).toBe("11");
  });
});
