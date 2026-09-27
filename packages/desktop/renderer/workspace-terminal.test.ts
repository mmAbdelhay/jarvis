// @vitest-environment jsdom
//
// The Workspace's Terminal tabs. xterm.js renders to a canvas and measures
// real character cells, neither of which jsdom has, so the vendored modules
// are doubled exactly as session-view.test.ts doubles them. What is under
// test is Jarvis's half: one terminal per tab, which one is visible, where
// keystrokes go, and what happens when a tab goes away.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "@jarvis/core";
import { LOGIN_TERMINAL_DETAIL } from "../src/login-terminal.js";
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
    pageFullscreen: false,
    suspended: false,
    ...overrides,
  };
}

let calls: Recorded[];
let dataListener: ((tabId: string, chunk: string) => void) | undefined;
let exitListener: ((tabId: string, code: number) => void) | undefined;
let tabPlansListener: ((tabId: string) => void) | undefined;
let plansChangedListener: ((path: string) => void) | undefined;
/** What plansList answers with, for every test in this file — most never
 *  read it (a pane that never reports a cwd never asks), and the Task 8
 *  describe block below overwrites it per test to control which path (if
 *  any) counts as "this tab's session plan". */
let sessionPlanEntry: { path: string } | undefined;

/** This jsdom setup has no real `window.localStorage` (an experimental Node
 *  global that needs a `--localstorage-file` flag this project's vitest
 *  config never passes — an environment gap, not something the app can see:
 *  a real Electron renderer always has one). A fresh in-memory stand-in per
 *  test is what loadPlanPanelWidth/savePlanPanelWidth's own try/catch is
 *  for in production; here it is what lets Task 8's width-persistence
 *  tests observe anything at all. */
function fakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

function harness(buffered = ""): void {
  document.body.innerHTML = `<div id="workspace-terminal" hidden></div>`;
  calls = [];
  dataListener = undefined;
  exitListener = undefined;
  tabPlansListener = undefined;
  plansChangedListener = undefined;
  sessionPlanEntry = undefined;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: fakeLocalStorage(),
  });
  FakeTerminal.instances = [];
  (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
    onTerminalData: (cb: (tabId: string, chunk: string) => void) => {
      dataListener = cb;
    },
    onTerminalExit: (cb: (tabId: string, code: number) => void) => {
      exitListener = cb;
    },
    onTabPlans: (cb: (tabId: string) => void) => {
      tabPlansListener = cb;
    },
    onPlansChanged: (cb: (path: string) => void) => {
      plansChangedListener = cb;
    },
    plansList: (paneKey: string, cwd?: string) => {
      calls.push({ call: "plansList", args: [paneKey, cwd] });
      return Promise.resolve({
        session: sessionPlanEntry,
        planMode: [],
        repo: [],
      });
    },
    plansRead: (path: string) => {
      calls.push({ call: "plansRead", args: [path] });
      return Promise.resolve({ ok: false as const, reason: "not-found" as const });
    },
    plansWriteBlock: () => Promise.resolve({ ok: false as const, reason: "not-found" as const }),
    plansComments: () => Promise.resolve([]),
    plansAddComment: () => Promise.reject(new Error("plansAddComment not stubbed")),
    plansUpdateComment: () => Promise.resolve(undefined),
    plansDeleteComment: () => Promise.resolve(false),
    plansSend: () => Promise.resolve({ ok: false as const, reason: "no-comments" as const }),
    plansOpenLink: (url: string) => {
      calls.push({ call: "plansOpenLink", args: [url] });
      return Promise.resolve();
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
    suggestCompletions: (tabId: string, input: string) => {
      calls.push({ call: "suggestCompletions", args: [tabId, input] });
      return Promise.resolve(["git status"]);
    },
    splitTerminal: (tabId: string, paneId: string) => {
      calls.push({ call: "splitTerminal", args: [tabId, paneId] });
      return Promise.resolve();
    },
    closeTerminalPane: (paneKey: string) => {
      calls.push({ call: "closeTerminalPane", args: [paneKey] });
      return Promise.resolve();
    },
    closeTab: (id: string) => {
      calls.push({ call: "closeTab", args: [id] });
      return Promise.resolve();
    },
    reportCommandFinished: (paneKey: string, seconds: number, ok: boolean) => {
      calls.push({ call: "reportCommandFinished", args: [paneKey, seconds, ok] });
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
    await new Promise((resolve) => setTimeout(resolve, 0));

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

  // The race I1 fixes: `terminal:data` streams from the moment the shell
  // starts, so a push can arrive before this pane's own `terminal:attach`
  // reply does. Whatever landed in that gap is already inside the backlog
  // the reply is about to carry, so drawing it live too would draw it
  // twice — this is the routing (paneFor + writeLive) that drops it.
  describe("the live-push gate on attach", () => {
    it("drops a push delivered before attachTerminal resolves", async () => {
      let resolveAttach: (value: string) => void = () => {};
      harness();
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["attachTerminal"] = (
        tabId: string,
      ) => {
        calls.push({ call: "attachTerminal", args: [tabId] });
        return new Promise<string>((resolve) => {
          resolveAttach = resolve;
        });
      };
      const { renderWorkspaceTerminals } = await load();

      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      dataListener?.("tab-1", "too early");
      expect(FakeTerminal.instances[0]?.text).toBe("");

      resolveAttach("");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(FakeTerminal.instances[0]?.text).toBe("");
    });

    it("writes a push delivered after attachTerminal resolves", async () => {
      harness("");
      const { renderWorkspaceTerminals } = await load();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await new Promise((resolve) => setTimeout(resolve, 0));

      dataListener?.("tab-1", "right on time");

      expect(FakeTerminal.instances[0]?.text).toBe("right on time");
    });

    it("writes the backlog exactly once, never doubled by a push that arrived first", async () => {
      let resolveAttach: (value: string) => void = () => {};
      harness();
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["attachTerminal"] = (
        tabId: string,
      ) => {
        calls.push({ call: "attachTerminal", args: [tabId] });
        return new Promise<string>((resolve) => {
          resolveAttach = resolve;
        });
      };
      const { renderWorkspaceTerminals } = await load();

      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      dataListener?.("tab-1", "dropped");
      resolveAttach("$ ");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(FakeTerminal.instances[0]?.text).toBe("$ ");
    });
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

  // Settings are read once for the module, not once per pane, and every other
  // test in this file runs with that read failing — so without this one the
  // wiring is only ever exercised in the "blocks off" direction, and a
  // regression (a value captured at import, a rebinding no pane ever sees)
  // would ship blocks silently disabled for everyone with nothing failing.
  it("builds a pane of blocks when the settings say so", async () => {
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    jarvis["terminalSettings"] = () =>
      Promise.resolve({ blocks: true, inputEditor: false, notifyAfterSeconds: 0, home: "/h" });
    const { renderWorkspaceTerminals } = await load();
    // The settings arrive on a promise; a pane built before it resolves is
    // deliberately the plain terminal, so the pane under test comes after.
    await new Promise((resolve) => setTimeout(resolve, 0));

    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    const pane = document.querySelector<HTMLElement>(".terminal-pane");
    expect(pane?.dataset["state"]).toBe("blocks");
    await new Promise((resolve) => setTimeout(resolve, 0));

    dataListener?.(
      "tab-1",
      `\u001b]133;A\u0007$ \u001b]133;B\u0007ls\r\n\u001b]133;C;ls\u0007a b\r\n\u001b]133;D;0\u0007`,
    );

    expect(pane?.querySelectorAll(".block")).toHaveLength(1);
  });

  // The one deliberate opt-out in the whole design: the AWS login tab Jarvis
  // opens for itself runs `saml2aws login` and is then closed, so a block
  // would be a frame around the only command there will ever be.
  it("draws the AWS login terminal without blocks, whatever the settings say", async () => {
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    jarvis["terminalSettings"] = () =>
      Promise.resolve({ blocks: true, inputEditor: false, notifyAfterSeconds: 0, home: "/h" });
    const { renderWorkspaceTerminals } = await load();
    await new Promise((resolve) => setTimeout(resolve, 0));

    renderWorkspaceTerminals([tab({ detail: LOGIN_TERMINAL_DETAIL })], "tab-1", "acme");
    const pane = document.querySelector<HTMLElement>(".terminal-pane");
    expect(pane?.dataset["state"]).toBe("plain");
    await new Promise((resolve) => setTimeout(resolve, 0));

    dataListener?.(
      "tab-1",
      `\u001b]133;A\u0007$ \u001b]133;B\u0007ls\r\n\u001b]133;C;ls\u0007a b\r\n\u001b]133;D;0\u0007`,
    );

    expect(pane?.querySelectorAll(".block")).toHaveLength(0);
  });

  // M10 Task 4: the pane's onCommandFinished hook is wired to
  // window.jarvis.reportCommandFinished, keyed by this pane's own paneKey.
  it("reports a slow block's duration and status through reportCommandFinished", async () => {
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    jarvis["terminalSettings"] = () =>
      Promise.resolve({ blocks: true, inputEditor: false, notifyAfterSeconds: 30, home: "/h" });
    const { renderWorkspaceTerminals } = await load();
    await new Promise((resolve) => setTimeout(resolve, 0));

    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const start = 1_700_000_000_000;
    const dateSpy = vi.spyOn(Date, "now");
    dateSpy.mockReturnValueOnce(start);
    dataListener?.("tab-1", `\u001b]133;A\u0007$ \u001b]133;B\u0007ls\u001b]133;C;ls\u0007`);
    dateSpy.mockReturnValue(start + 45_000);
    dataListener?.("tab-1", `a b\r\n\u001b]133;D;0\u0007`);
    dateSpy.mockRestore();

    expect(calls).toContainEqual({
      call: "reportCommandFinished",
      args: ["tab-1", 45, true],
    });
  });
});

// A phone may resize a pane's pty while the laptop's own Workspace is not
// looking (M7 ruling 11: last writer wins, both sides re-assert). fit()
// only calls back into resizeTerminal on a genuine change of the leaf's own
// cell grid, so without an explicit, unconditional re-assertion the laptop
// would go on believing its own last-known size forever.
describe("reassertVisibleWorkspaceTerminal", () => {
  beforeEach(() => harness());

  // [bite-proof: send only when fit reports a change; the test fails]
  it("sends the pty's current size when the terminal tab becomes visible, even though its size did not change", async () => {
    const { renderWorkspaceTerminals } = await load();

    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    expect(calls).toContainEqual({ call: "resizeTerminal", args: ["tab-1", 80, 24] });
  });

  it("sends the current size once when the window regains focus while the terminal is visible", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    calls = calls.filter((entry) => entry.call !== "resizeTerminal");

    window.dispatchEvent(new Event("focus"));

    expect(calls.filter((entry) => entry.call === "resizeTerminal")).toEqual([
      { call: "resizeTerminal", args: ["tab-1", 80, 24] },
    ]);
  });

  // Fix round 1, Important 3: a render that leaves the same tab visible
  // (e.g. a workspace:update push that changes nothing about which tab is
  // showing) must send nothing — only a genuine showing transition and the
  // focus listener do.
  // [bite-proof: drop the `wasShowing !== showing` guard around
  // reassertVisibleWorkspaceTerminal() in renderWorkspaceTerminals; the
  // test fails]
  it("sends nothing on a second identical render of the already-visible tab", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    calls = calls.filter((entry) => entry.call !== "resizeTerminal");

    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    expect(calls.some((entry) => entry.call === "resizeTerminal")).toBe(false);
  });

  // task-7-review.md Important 4: this test's own bite is the `pane ===
  // undefined` check one line below `visibleTabId === undefined` in
  // reassertVisibleWorkspaceTerminal() — `panes.get(undefined)` already
  // resolves to undefined (panes are only ever keyed by real tab id
  // strings), so the `visibleTabId === undefined` early return above it is
  // redundant defensively, not independently bite-proof. What this test
  // does prove is the outer behavior: once a project switch leaves no
  // terminal tab visible, a later focus event resizes nothing.
  it("sends nothing on focus once the terminal's project is no longer selected (hidden pane never resizes)", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    renderWorkspaceTerminals([tab()], "tab-1", "storefront"); // a different project: hidden now
    calls = [];

    window.dispatchEvent(new Event("focus"));

    expect(calls.some((entry) => entry.call === "resizeTerminal")).toBe(false);
  });

  it("sends nothing on focus when the active tab is not a terminal", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab({ kind: "web", url: "https://x.test" })], "tab-1", "acme");
    calls = [];

    window.dispatchEvent(new Event("focus"));

    expect(calls.some((entry) => entry.call === "resizeTerminal")).toBe(false);
  });

  it("sends nothing on focus before any terminal has ever been rendered", async () => {
    await load();

    window.dispatchEvent(new Event("focus"));

    expect(calls.some((entry) => entry.call === "resizeTerminal")).toBe(false);
  });

  // Only the visible leaf of the visible tab — a background pane of a split
  // tab is never resized merely because its sibling is on screen.
  it("resizes only the focused pane's own leaf when a split tab is visible", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    FakeTerminal.instances.at(-1)?.pressKey({ key: "d", metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    calls = [];

    window.dispatchEvent(new Event("focus"));

    const resizes = calls.filter((entry) => entry.call === "resizeTerminal");
    expect(resizes).toContainEqual({ call: "resizeTerminal", args: ["tab-1", 80, 24] });
    expect(resizes).toContainEqual({ call: "resizeTerminal", args: ["tab-1:p1", 80, 24] });
  });
});

describe("terminal key bindings and addons", () => {
  beforeEach(() => harness());

  it("copies the selection on Cmd+C rather than letting the browser miss it", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
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

  // A pane with blocks switched off (this describe block's default
  // settings) has no BlockNav, and the key handler's undefined guards are
  // what keeps ⌘↑/⌘↓/⌘⇧F behaving exactly as they did before blocks
  // existed — left to xterm — rather than claiming the key and doing
  // nothing with it.
  it("leaves the block-navigation keys to xterm when the pane has no blocks", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    const terminal = FakeTerminal.instances[0];
    if (terminal === undefined) throw new Error("expected a terminal");

    expect(terminal.pressKey({ key: "ArrowDown", metaKey: true })).toBe(true);
    expect(terminal.pressKey({ key: "ArrowUp", metaKey: true })).toBe(true);
    expect(terminal.pressKey({ key: "F", shiftKey: true, metaKey: true })).toBe(true);
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

  it("asks for completions against the pane's own tab", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    const terminal = FakeTerminal.instances[0];
    if (terminal === undefined) throw new Error("expected a terminal");

    terminal.parser.emitOsc(133, "A");
    terminal.typeLine("~/p > ");
    terminal.parser.emitOsc(133, "B");
    terminal.typeLine("~/p > git sta");
    terminal.emitData("a");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toContainEqual({ call: "suggestCompletions", args: ["tab-1", "git sta"] });
    expect(document.querySelector(".terminal-completion")?.textContent).toContain("git status");
  });

  // main's own record of a shell's directory is only ever where it
  // *started* — see ipc.ts's TerminalHandlers.suggest. The pane's own live
  // OSC 7 report travels with every request instead, exactly as it already
  // does for `chips`, so a completion typed after a `cd` resolves against
  // where the shell actually is.
  it("carries the pane's own live directory alongside a completion request", async () => {
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    const asked: unknown[][] = [];
    jarvis["suggestCompletions"] = (paneKey: string, input: string, path: string | undefined) => {
      asked.push([paneKey, input, path]);
      return Promise.resolve(["git status"]);
    };
    // Blocks on: the cwd event this test relies on is the OSC 7 splitter's,
    // which only runs with blocks integration on — see terminal-pane.ts's
    // own `write()`.
    jarvis["terminalSettings"] = () =>
      Promise.resolve({ blocks: true, inputEditor: false, notifyAfterSeconds: 0, home: "/h" });
    const { renderWorkspaceTerminals } = await load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    const terminal = FakeTerminal.instances[0];
    if (terminal === undefined) throw new Error("expected a terminal");
    await new Promise((resolve) => setTimeout(resolve, 0));

    dataListener?.("tab-1", "\x1b]7;file:///proj\x07\x1b]133;A\x07~/p > \x1b]133;B\x07");
    await new Promise((resolve) => setTimeout(resolve, 0));

    terminal.parser.emitOsc(133, "A");
    terminal.typeLine("~/p > ");
    terminal.parser.emitOsc(133, "B");
    terminal.typeLine("~/p > git sta");
    terminal.emitData("a");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(asked).toEqual([["tab-1", "git sta", "/proj"]]);
  });

  // xterm keeps exactly one custom key handler. Attaching the dropdown's
  // separately would silently replace the addon stack's and take Cmd+F,
  // Cmd+V and Shift+Enter with it, so both go through the one handler —
  // and this asserts they still coexist.
  it("claims Tab for an open dropdown while leaving Cmd+F to the find bar", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    const terminal = FakeTerminal.instances[0];
    if (terminal === undefined) throw new Error("expected a terminal");

    terminal.parser.emitOsc(133, "A");
    terminal.typeLine("~/p > ");
    terminal.parser.emitOsc(133, "B");
    terminal.typeLine("~/p > git sta");
    terminal.emitData("a");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(terminal.pressKey({ key: "Tab" })).toBe(false);
    terminal.pressKey({ key: "f", metaKey: true });
    expect(document.querySelector(".terminal-find")?.hasAttribute("hidden")).toBe(false);
  });

  it("gives each terminal its own dropdown", async () => {
    const { renderWorkspaceTerminals } = await load();
    const tabs = [tab(), tab({ id: "tab-2" })];
    renderWorkspaceTerminals(tabs, "tab-1", "acme");
    renderWorkspaceTerminals(tabs, "tab-2", "acme");

    expect(document.querySelectorAll(".terminal-completion")).toHaveLength(2);
  });
});

describe("moving around a pane's blocks", () => {
  beforeEach(() => harness());

  async function paneWithBlocks(): Promise<HTMLElement> {
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    jarvis["terminalSettings"] = () =>
      Promise.resolve({ blocks: true, inputEditor: false, notifyAfterSeconds: 0, home: "/h" });
    const { renderWorkspaceTerminals } = await load();
    // See "builds a pane of blocks when the settings say so" above: the
    // settings arrive on a promise, so the pane has to be built after it
    // resolves or it falls back to the plain terminal.
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    const pane = document.querySelector<HTMLElement>(".terminal-pane");
    if (pane === null) throw new Error("expected a pane");
    // finishCommand pushes through dataListener directly, so the pane's own
    // attach must have settled first — see terminal-pane.ts's write-gate.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return pane;
  }

  function finishCommand(command: string, exitCode: number): void {
    dataListener?.(
      "tab-1",
      `]133;A$ ]133;B${command}\r\n` + `]133;C;${command}ok\r\n]133;D;${exitCode}`,
    );
  }

  it("selects the next and previous block on Cmd+ArrowDown/Up, clamping at both ends", async () => {
    const pane = await paneWithBlocks();
    finishCommand("a", 0);
    finishCommand("b", 0);
    const terminal = FakeTerminal.instances[0];
    if (terminal === undefined) throw new Error("expected a terminal");
    const blocks = () => Array.from(pane.querySelectorAll(".block"));

    expect(terminal.pressKey({ key: "ArrowDown", metaKey: true })).toBe(false);
    expect(blocks()[0]?.classList.contains("selected")).toBe(true);

    terminal.pressKey({ key: "ArrowDown", metaKey: true });
    expect(blocks()[1]?.classList.contains("selected")).toBe(true);
    expect(blocks()[0]?.classList.contains("selected")).toBe(false);

    // Past the last block: stays there rather than wrapping.
    terminal.pressKey({ key: "ArrowDown", metaKey: true });
    expect(blocks()[1]?.classList.contains("selected")).toBe(true);

    terminal.pressKey({ key: "ArrowUp", metaKey: true });
    expect(blocks()[0]?.classList.contains("selected")).toBe(true);
  });

  it("hides ok blocks on Cmd+Shift+F and restores them on a second press", async () => {
    const pane = await paneWithBlocks();
    finishCommand("git status", 0);
    finishCommand("git push", 1);
    const terminal = FakeTerminal.instances[0];
    if (terminal === undefined) throw new Error("expected a terminal");
    const blocks = () => Array.from(pane.querySelectorAll<HTMLElement>(".block"));

    const handled = terminal.pressKey({ key: "F", shiftKey: true, metaKey: true });
    expect(handled).toBe(false);
    expect(blocks()[0]?.hidden).toBe(true); // ok — hidden
    expect(blocks()[1]?.hidden).toBe(false); // failed — stays

    terminal.pressKey({ key: "F", shiftKey: true, metaKey: true });
    expect(blocks().every((b) => !b.hidden)).toBe(true);
  });

  // The live terminal is where the user is looking, so its own match — if
  // it has one — wins; only once it comes up empty does the frozen list get
  // scanned. FakeTerminal never actually activates the real search addon
  // (loadAddon here only records it), so findNext/findPrevious throw and
  // this exercises the "no match" branch on every call — which is exactly
  // the case this feature exists for.
  it("flags the first frozen block that matches once the live terminal has no match", async () => {
    const pane = await paneWithBlocks();
    finishCommand("ls", 0);
    const terminal = FakeTerminal.instances[0];
    if (terminal === undefined) throw new Error("expected a terminal");

    terminal.pressKey({ key: "f", metaKey: true });
    const input = document.querySelector<HTMLInputElement>(".terminal-find-input");
    if (input === null) throw new Error("expected the find bar's input");
    input.value = "ok";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(pane.querySelector(".block")?.classList.contains("found")).toBe(true);
  });

  it("does not flag anything when nothing frozen matches either", async () => {
    const pane = await paneWithBlocks();
    finishCommand("ls", 0);
    const terminal = FakeTerminal.instances[0];
    if (terminal === undefined) throw new Error("expected a terminal");

    terminal.pressKey({ key: "f", metaKey: true });
    const input = document.querySelector<HTMLInputElement>(".terminal-find-input");
    if (input === null) throw new Error("expected the find bar's input");
    input.value = "no-such-text-anywhere";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(pane.querySelector(".block.found")).toBeNull();
  });
});

// Task 10: with the command editor live, completion reads and writes it
// instead of the xterm buffer, which shows nothing but the bare prompt
// while the editor holds the line.
describe("completion with the command editor live", () => {
  beforeEach(() => harness());

  async function editorPane() {
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    jarvis["terminalSettings"] = () =>
      Promise.resolve({ blocks: true, inputEditor: true, notifyAfterSeconds: 0, home: "/h" });
    jarvis["terminalHistory"] = () => Promise.resolve(["ls -la"]);
    const { renderWorkspaceTerminals } = await load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    const terminal = FakeTerminal.instances[0];
    if (terminal === undefined) throw new Error("expected a terminal");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Drives the pane's own block/editor state machine — real bytes, the
    // way xterm's own parser would hand them to the splitter. The editor
    // only shows once the pane has seen a prompt this way.
    dataListener?.("tab-1", "]133;A~/p > ]133;B");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Drives attachCompletion's own OSC tracking separately: the FakeTerminal
    // double's write() does not parse escape sequences the way real xterm
    // does, so the registered OSC handler needs feeding directly — the same
    // way the plain-terminal completion tests above do.
    terminal.parser.emitOsc(133, "A");
    terminal.typeLine("~/p > ");
    terminal.parser.emitOsc(133, "B");

    const field = document.querySelector<HTMLTextAreaElement>("textarea.terminal-input-text");
    if (field === null) throw new Error("expected the editor's textarea");
    if (field.closest(".terminal-input")?.hasAttribute("hidden")) {
      throw new Error("expected the editor to be visible");
    }
    return { terminal, field };
  }

  it("suggests from the editor's value, not the bare prompt still on screen", async () => {
    const { field } = await editorPane();
    field.value = "git sta";

    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The xterm buffer never moved past "~/p > " — nothing reached the pty
    // — so a call asking about that would prove the bug this task fixes.
    expect(calls).toContainEqual({ call: "suggestCompletions", args: ["tab-1", "git sta"] });
  });

  it("accepts into the editor and sends nothing to the pty", async () => {
    const { field } = await editorPane();
    field.value = "git sta";
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );

    expect(field.value).toBe("git status");
    expect(calls.some((c) => c.call === "sendTerminalInput")).toBe(false);
  });

  // The dropdown's own keys — here, ArrowDown — must not also run the
  // editor's own handling of the same keystroke: the capture-phase
  // consultation in terminal-pane.ts has to see it first and stop it there.
  it("does not let the editor's own history walk run on a key the dropdown claimed", async () => {
    const { field } = await editorPane();
    field.value = "git sta";
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );

    // Had the editor's own handling also run on the same keystroke, this
    // would have walked Jarvis's command log to "ls -la" instead of moving
    // the dropdown's own selection.
    expect(field.value).toBe("git sta");
  });
});

// Task 11: a tab holds a tree of panes. Every leaf is a whole pane with its
// own shell, keyed "<tabId>:<paneId>" — which is what makes autocomplete and
// the command editor's history work inside a split without main having to
// know a split exists.
describe("splitting a terminal tab", () => {
  beforeEach(() => harness());

  async function split(key: string, shift = false): Promise<void> {
    const terminal = FakeTerminal.instances.at(-1);
    terminal?.pressKey({ key, metaKey: true, shiftKey: shift });
    // The pane's shell has to be started before the pane attaches to it.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("starts a second shell in the same tab on Cmd+D and draws a pane for it", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    await split("d");

    expect(calls).toContainEqual({ call: "splitTerminal", args: ["tab-1", "p1"] });
    expect(calls).toContainEqual({ call: "attachTerminal", args: ["tab-1:p1"] });
    expect(FakeTerminal.instances).toHaveLength(2);
    expect(document.querySelectorAll(".terminal-split-leaf")).toHaveLength(2);
  });

  it("splits down on Cmd+Shift+D", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    await split("d", true);

    const branch = document.querySelector<HTMLElement>(".terminal-split-branch");
    expect(branch?.style.flexDirection).toBe("column");
  });

  // The renderer routes the pty stream by shell key, not by tab: the wrong
  // answer here would put one shell's output into another shell's pane.
  it("writes each pane's output into that pane and no other", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await split("d");

    dataListener?.("tab-1:p1", "in the split");
    dataListener?.("tab-1", "in the first");

    expect(FakeTerminal.instances[0]?.text).toBe("in the first");
    expect(FakeTerminal.instances[1]?.text).toBe("in the split");
  });

  it("says which pane's shell exited, in that pane", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await split("d");

    exitListener?.("tab-1:p1", 130);

    expect(FakeTerminal.instances[1]?.text).toContain("[process exited with code 130]");
    expect(FakeTerminal.instances[0]?.text).toBe("");
  });

  it("sends a split pane's keystrokes to its own shell", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await split("d");

    FakeTerminal.instances[1]?.emitData(CTRL_C);

    expect(calls).toContainEqual({ call: "sendTerminalInput", args: ["tab-1:p1", CTRL_C] });
  });

  // Completion resolves its key through the same directories map main
  // registered the split in, so a split pane completes like any other.
  it("asks for completions against the split pane's own key", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await split("d");
    const terminal = FakeTerminal.instances[1];
    if (terminal === undefined) throw new Error("expected the split pane's terminal");

    terminal.parser.emitOsc(133, "A");
    terminal.typeLine("~/p > ");
    terminal.parser.emitOsc(133, "B");
    terminal.typeLine("~/p > git sta");
    terminal.emitData("a");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toContainEqual({ call: "suggestCompletions", args: ["tab-1:p1", "git sta"] });
  });

  it("closes the focused pane on Cmd+W and kills its shell, keeping the tab", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await split("d");

    FakeTerminal.instances[1]?.pressKey({ key: "w", metaKey: true });

    expect(calls).toContainEqual({ call: "closeTerminalPane", args: ["tab-1:p1"] });
    expect(calls.some((entry) => entry.call === "closeTab")).toBe(false);
    expect(FakeTerminal.instances[1]?.disposed).toBe(true);
    expect(document.querySelectorAll(".terminal-split-leaf")).toHaveLength(1);
  });

  // The last pane is the tab: closing it closes the tab, which is what
  // reaps whatever shells are left.
  it("closes the tab when Cmd+W has no other pane to fall back to", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");

    FakeTerminal.instances[0]?.pressKey({ key: "w", metaKey: true });

    expect(calls).toContainEqual({ call: "closeTab", args: ["tab-1"] });
    expect(calls.some((entry) => entry.call === "closeTerminalPane")).toBe(false);
  });

  it("moves the focus between panes on Alt+Cmd+Arrow", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await split("d");
    const focusedBefore = FakeTerminal.instances[0]?.focused ?? 0;

    FakeTerminal.instances[1]?.pressKey({ key: "ArrowLeft", metaKey: true, altKey: true });

    expect(FakeTerminal.instances[0]?.focused).toBe(focusedBefore + 1);
  });

  it("disposes every pane of a split tab when the tab is closed", async () => {
    const { renderWorkspaceTerminals } = await load();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await split("d");

    renderWorkspaceTerminals([], undefined, "acme");

    expect(FakeTerminal.instances.every((terminal) => terminal.disposed)).toBe(true);
    expect(document.querySelectorAll(".terminal-split-leaf")).toHaveLength(0);
  });
});

// The file sidebar: one per tab, on the left, rooted at whichever pane has
// the focus. A tab split three ways has one tree, not three — so which
// pane's `cd` it listens to, and which pane's key a listing carries, is
// the whole of what this wiring has to get right.
describe("the terminal tab's file sidebar", () => {
  beforeEach(() => harness());

  /** OSC 7, exactly as the zsh wrapper prints it in precmd. */
  const CWD = (path: string) => `]7;file://${path}`;

  const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));

  /** A tab whose shell reports where it is — the sidebar only ever hears
   *  from a shell with integration on. `listed` records every listing, so
   *  a test can say which pane a directory was listed for. */
  async function tabWithSidebar(): Promise<
    typeof import("./workspace-terminal.js") & { listed: string[][] }
  > {
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    jarvis["terminalSettings"] = () =>
      Promise.resolve({ blocks: true, inputEditor: false, notifyAfterSeconds: 0, home: "/h" });
    const listed: string[][] = [];
    jarvis["listTerminalDir"] = (paneKey: string, path: string) => {
      listed.push([paneKey, path]);
      return Promise.resolve([{ name: "src", directory: true }]);
    };
    const module = await load();
    await settle();
    return Object.assign(module, { listed });
  }

  const sidebar = () => document.querySelector<HTMLElement>(".terminal-explorer");

  async function split(key: string): Promise<void> {
    FakeTerminal.instances.at(-1)?.pressKey({ key, metaKey: true });
    await settle();
  }

  it("roots at the focused pane's directory and lists it for that pane", async () => {
    const { renderWorkspaceTerminals, listed } = await tabWithSidebar();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();

    dataListener?.("tab-1", CWD("/proj"));
    await settle();

    expect(listed).toEqual([["tab-1", "/proj"]]);
    expect(sidebar()?.hidden).toBe(false);
    expect(sidebar()?.textContent).toContain("src");
  });

  // A tab whose shell never reports a directory is the terminal Jarvis had
  // before this sidebar existed: no column beside it, and no listing.
  it("shows nothing for a pane with no shell integration", async () => {
    const { renderWorkspaceTerminals, listed } = await tabWithSidebar();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();

    dataListener?.("tab-1", "just output\r\n");
    await settle();

    expect(sidebar()?.hidden).toBe(true);
    expect(listed).toEqual([]);
  });

  // The cwd event fires on every prompt, not only on a `cd`.
  it("does not re-list when the shell prints another prompt in the same place", async () => {
    const { renderWorkspaceTerminals, listed } = await tabWithSidebar();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();

    dataListener?.("tab-1", CWD("/proj"));
    dataListener?.("tab-1", CWD("/proj"));
    await settle();

    expect(listed).toEqual([["tab-1", "/proj"]]);
  });

  it("re-roots when the focused pane's shell moves", async () => {
    const { renderWorkspaceTerminals, listed } = await tabWithSidebar();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();

    dataListener?.("tab-1", CWD("/proj"));
    dataListener?.("tab-1", CWD("/proj/src"));
    await settle();

    expect(listed).toEqual([
      ["tab-1", "/proj"],
      ["tab-1", "/proj/src"],
    ]);
  });

  // The one thing a sidebar shared by every pane must never do: follow a
  // shell the user is not looking at.
  it("ignores a background pane's cd", async () => {
    const { renderWorkspaceTerminals, listed } = await tabWithSidebar();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await split("d"); // The new pane takes the focus.

    dataListener?.("tab-1:p1", CWD("/proj/split"));
    dataListener?.("tab-1", CWD("/proj/background"));
    await settle();

    expect(listed).toEqual([["tab-1:p1", "/proj/split"]]);
  });

  it("re-roots to the newly focused pane's last known directory", async () => {
    const { renderWorkspaceTerminals, listed } = await tabWithSidebar();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();
    dataListener?.("tab-1", CWD("/proj"));
    await split("d");
    dataListener?.("tab-1:p1", CWD("/proj/split"));
    await settle();

    FakeTerminal.instances[1]?.pressKey({ key: "ArrowLeft", metaKey: true, altKey: true });
    await settle();

    expect(listed).toEqual([
      ["tab-1", "/proj"],
      ["tab-1:p1", "/proj/split"],
      ["tab-1", "/proj"],
    ]);
  });

  it("takes the sidebar with the tab when the tab is closed", async () => {
    const { renderWorkspaceTerminals } = await tabWithSidebar();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();
    dataListener?.("tab-1", CWD("/proj"));
    await settle();

    renderWorkspaceTerminals([], undefined, "acme");

    expect(sidebar()).toBeNull();
  });

  // Clicking a file is choose()'s whole job — see terminal-explorer.ts and
  // file-tree.ts, both wired and tested on their own already. What is under
  // test here is only that this tab's wiring reaches the real IPC call,
  // tagged with the pane the click came from.
  it("opens a chosen file through the editor IPC, tagged with the pane's key", async () => {
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    jarvis["terminalSettings"] = () =>
      Promise.resolve({ blocks: true, inputEditor: false, notifyAfterSeconds: 0, home: "/h" });
    jarvis["listTerminalDir"] = () => Promise.resolve([{ name: "a.ts", directory: false }]);
    const opened: [string, string][] = [];
    jarvis["openTerminalFile"] = (paneKey: string, path: string) => {
      opened.push([paneKey, path]);
      return Promise.resolve({ ok: true, value: undefined });
    };
    const { renderWorkspaceTerminals } = await load();
    await settle();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();

    dataListener?.("tab-1", CWD("/proj"));
    await settle();
    sidebar()?.querySelector<HTMLElement>('.file-tree-row[data-directory="false"]')?.click();
    await settle();

    expect(opened).toEqual([["tab-1", "/proj/a.ts"]]);
  });

  // A refusal — no editor integration, the file outside the project,
  // code-server failing to start — is not this wiring's business to
  // notice: main never rejects, and the terminal must be untouched either
  // way.
  it("leaves the terminal untouched when the editor IPC refuses", async () => {
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    jarvis["terminalSettings"] = () =>
      Promise.resolve({ blocks: true, inputEditor: false, notifyAfterSeconds: 0, home: "/h" });
    jarvis["listTerminalDir"] = () => Promise.resolve([{ name: "a.ts", directory: false }]);
    jarvis["openTerminalFile"] = () => Promise.resolve({ ok: false, text: "nope", language: "en" });
    const { renderWorkspaceTerminals } = await load();
    await settle();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();

    dataListener?.("tab-1", CWD("/proj"));
    await settle();

    expect(() =>
      sidebar()?.querySelector<HTMLElement>('.file-tree-row[data-directory="false"]')?.click(),
    ).not.toThrow();
    await settle();

    expect(document.getElementById("workspace-terminal")?.hidden).toBe(false);
  });
});

// Dismissing the sidebar, and what a closed pane leaves behind. Same
// harness as the block above; kept apart because both are about the
// sidebar's visibility rather than its root.
describe("dismissing the terminal tab's file sidebar", () => {
  beforeEach(() => harness());

  const CWD = (path: string) => `]7;file://${path}`;
  const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));
  const sidebar = () => document.querySelector<HTMLElement>(".terminal-explorer");

  async function tabWithSidebar(): Promise<
    typeof import("./workspace-terminal.js") & { listed: string[][] }
  > {
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    jarvis["terminalSettings"] = () =>
      Promise.resolve({ blocks: true, inputEditor: true, notifyAfterSeconds: 0, home: "/h" });
    const listed: string[][] = [];
    jarvis["listTerminalDir"] = (paneKey: string, path: string) => {
      listed.push([paneKey, path]);
      return Promise.resolve([{ name: "src", directory: true }]);
    };
    const module = await load();
    await settle();
    return Object.assign(module, { listed });
  }

  /** The palette's own entry, run the way a user runs it. */
  function runAction(label: string): void {
    const palette = document.querySelector<HTMLElement>(".terminal-palette");
    const input = palette?.querySelector("input");
    if (input === null || input === undefined) throw new Error("no palette input");
    input.value = label;
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
  }

  it("closes the sidebar from the command palette", async () => {
    const { renderWorkspaceTerminals } = await tabWithSidebar();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();
    dataListener?.("tab-1", CWD("/proj"));
    await settle();
    expect(sidebar()?.hidden).toBe(false);

    FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
    runAction("Toggle file sidebar");

    expect(sidebar()?.hidden).toBe(true);
  });

  // A sidebar the user dismissed stays dismissed through every later
  // prompt — and comes back only when they ask for it again.
  it("keeps it closed across a cd, and re-opens it on a second toggle", async () => {
    const { renderWorkspaceTerminals } = await tabWithSidebar();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();
    dataListener?.("tab-1", CWD("/proj"));
    await settle();
    FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
    runAction("Toggle file sidebar");

    dataListener?.("tab-1", CWD("/proj/src"));
    await settle();
    expect(sidebar()?.hidden).toBe(true);

    FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
    runAction("Toggle file sidebar");

    expect(sidebar()?.hidden).toBe(false);
    expect(sidebar()?.textContent).toContain("src");
  });

  // Closing the pane the sidebar was following leaves it rooted for a dead
  // shell. If the pane that takes the focus has never said where it is,
  // there is nothing honest to show.
  it("clears the sidebar when the pane that takes the focus has no directory", async () => {
    const { renderWorkspaceTerminals } = await tabWithSidebar();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    FakeTerminal.instances[0]?.pressKey({ key: "d", metaKey: true });
    await settle();
    // Only the split pane ever reports a directory.
    dataListener?.("tab-1:p1", CWD("/proj/split"));
    await settle();
    expect(sidebar()?.hidden).toBe(false);

    FakeTerminal.instances[1]?.pressKey({ key: "w", metaKey: true });
    await settle();

    expect(sidebar()?.textContent).toBe("");
    expect(sidebar()?.hidden).toBe(true);
  });

  // The palette offers the toggle before any pane has reported a
  // directory, so this order is one keypress away in a fresh tab: a
  // toggle there must not arm a dismissal the first prompt then runs into.
  it("still opens on the first directory after a toggle in a tab that had none", async () => {
    const { renderWorkspaceTerminals } = await tabWithSidebar();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();
    // A prompt with no OSC 7: the palette opens, the sidebar has nothing.
    dataListener?.("tab-1", `]133;A$ ]133;B`);
    await settle();
    expect(sidebar()?.hidden).toBe(true);

    FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
    runAction("Toggle file sidebar");

    dataListener?.("tab-1", CWD("/proj"));
    await settle();
    expect(sidebar()?.hidden).toBe(false);
  });
});

// Task 8: the plan panel mounted in each terminal tab — DOM order, the
// palette and tab-menu toggles, the drag handle's width clamp and
// persistence, and auto-open on a plans:changed push.
describe("the terminal tab's plan panel", () => {
  beforeEach(() => harness());

  /** OSC 7, exactly as the zsh wrapper prints it in precmd. */
  const CWD = (path: string) => `]7;file://${path}`;
  const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));
  /** Real time, not fake timers (this file's established pattern) — long
   *  enough to clear scheduleSessionPlanRefresh's 300ms per-tab debounce. */
  const advance = (ms: number): Promise<unknown> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  async function tabWithPanel(): Promise<typeof import("./workspace-terminal.js")> {
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    jarvis["terminalSettings"] = () =>
      Promise.resolve({ blocks: true, inputEditor: false, notifyAfterSeconds: 0, home: "/h" });
    const module = await load();
    await settle();
    return module;
  }

  const tabPane = () => document.querySelector<HTMLElement>(".workspace-terminal-pane");
  const handle = () => document.querySelector<HTMLElement>(".plan-panel-handle");
  const panel = () => document.querySelector<HTMLElement>(".plan-panel");

  function runAction(label: string): void {
    const palette = document.querySelector<HTMLElement>(".terminal-palette");
    const input = palette?.querySelector("input");
    if (input === null || input === undefined) throw new Error("no palette input");
    input.value = label;
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
  }

  it("builds the tab's file sidebar, its panes, a drag handle and the plan panel in that order", async () => {
    const { renderWorkspaceTerminals } = await tabWithPanel();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();

    const classNames = Array.from(tabPane()?.children ?? []).map((el) => el.className);
    expect(classNames).toEqual([
      "terminal-explorer",
      "terminal-split",
      "plan-panel-handle",
      "plan-panel",
    ]);
  });

  it("starts closed, with the handle hidden alongside it", async () => {
    const { renderWorkspaceTerminals } = await tabWithPanel();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();

    expect(panel()?.hidden).toBe(true);
    expect(handle()?.hidden).toBe(true);
  });

  it("toggles open and closed from the command palette, showing the handle with it", async () => {
    const { renderWorkspaceTerminals } = await tabWithPanel();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();

    FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
    runAction("Toggle plan panel");
    await settle();
    expect(panel()?.hidden).toBe(false);
    expect(handle()?.hidden).toBe(false);

    FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
    runAction("Toggle plan panel");
    await settle();
    expect(panel()?.hidden).toBe(true);
    expect(handle()?.hidden).toBe(true);
  });

  it("toggles from the tab menu's Plans push, by tab id", async () => {
    const { renderWorkspaceTerminals } = await tabWithPanel();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();

    tabPlansListener?.("tab-1");
    await settle();
    expect(panel()?.hidden).toBe(false);

    tabPlansListener?.("tab-1");
    await settle();
    expect(panel()?.hidden).toBe(true);
  });

  it("ignores the Plans push for a tab id with no pane", async () => {
    await tabWithPanel();

    expect(() => tabPlansListener?.("unknown-tab")).not.toThrow();
  });

  it("disposes the panel and drops it from the DOM when the tab closes", async () => {
    const { renderWorkspaceTerminals } = await tabWithPanel();
    renderWorkspaceTerminals([tab()], "tab-1", "acme");
    await settle();

    renderWorkspaceTerminals([], undefined, "acme");

    expect(document.querySelector(".plan-panel")).toBeNull();
  });

  describe("width clamp and persistence", () => {
    it("clamps a width between 300px and 60% of the container, dropping the upper bound at zero", async () => {
      const { clampPlanPanelWidth } = await load();

      expect(clampPlanPanelWidth(100, 1000)).toBe(300);
      expect(clampPlanPanelWidth(900, 1000)).toBe(600);
      expect(clampPlanPanelWidth(450, 1000)).toBe(450);
      expect(clampPlanPanelWidth(9000, 0)).toBe(9000);
    });

    it("resizes on drag, clamped to the container, and persists the final width on mouseup", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();
      FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
      runAction("Toggle plan panel");
      await settle();

      tabPane()!.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 0,
          width: 1000,
          height: 600,
          left: 0,
          right: 1000,
          top: 0,
          bottom: 600,
        }) as DOMRect;

      handle()!.dispatchEvent(new MouseEvent("mousedown", { clientX: 700, bubbles: true }));
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 600, bubbles: true }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      expect(panel()?.style.width).toBe("400px");
      expect(window.localStorage.getItem("jarvis.planPanelWidth.tab-1")).toBe("400");
    });

    it("clamps a drag past 60% of the container to the 60% ceiling", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();
      FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
      runAction("Toggle plan panel");
      await settle();

      tabPane()!.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 0,
          width: 1000,
          height: 600,
          left: 0,
          right: 1000,
          top: 0,
          bottom: 600,
        }) as DOMRect;

      handle()!.dispatchEvent(new MouseEvent("mousedown", { clientX: 900, bubbles: true }));
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100, bubbles: true }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      expect(panel()?.style.width).toBe("600px");
    });

    // Minor (fix round 1): a panel wider than 60% of the window is fine
    // until the window itself narrows — nothing re-checks the clamp
    // without this.
    it("re-clamps to 60% of the container on a window resize", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();
      FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
      runAction("Toggle plan panel");
      await settle();

      // 500px was a legal width against the container's previous size.
      panel()!.style.width = "500px";
      panel()!.getBoundingClientRect = () =>
        ({
          x: 500,
          y: 0,
          width: 500,
          height: 600,
          left: 500,
          right: 1000,
          top: 0,
          bottom: 600,
        }) as DOMRect;

      // The window narrows to 600px — 60% of that is 360px, below 500px.
      Object.defineProperty(tabPane()!, "clientWidth", { value: 600, configurable: true });
      window.dispatchEvent(new Event("resize"));

      expect(panel()?.style.width).toBe("360px");
    });

    it("leaves the width alone on a resize that keeps it under 60%", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();
      FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
      runAction("Toggle plan panel");
      await settle();

      Object.defineProperty(tabPane()!, "clientWidth", { value: 1000, configurable: true });
      panel()!.style.width = "400px";
      panel()!.getBoundingClientRect = () =>
        ({
          x: 600,
          y: 0,
          width: 400,
          height: 600,
          left: 600,
          right: 1000,
          top: 0,
          bottom: 600,
        }) as DOMRect;

      window.dispatchEvent(new Event("resize"));

      expect(panel()?.style.width).toBe("400px");
    });

    // jsdom's `clientWidth` is always 0 (no layout engine), so a saved
    // width above 300 applies verbatim here — the 60% ceiling only ever
    // bites against a real, positive container width (proven above via
    // clampPlanPanelWidth directly, and via the drag test's own
    // getBoundingClientRect stub).
    it("applies a previously saved width on the next tab open, clamped at the 300px floor", async () => {
      window.localStorage.setItem("jarvis.planPanelWidth.tab-1", "50");
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();

      expect(panel()?.style.width).toBe("300px");
    });
  });

  describe("auto-open on plans:changed", () => {
    // Every plans:changed push now also schedules its own 300ms debounced
    // session-plan lookup (fix round 1), keyed to the tab's own Pane
    // object. A test that pushes and moves on without waiting that out
    // leaves a real, armed setTimeout behind; when it fires — during
    // whatever test happens to be running ~300ms later — its callback
    // reads `window.jarvis` fresh (not the object captured when the timer
    // was scheduled) and pushes into the single shared `calls` array,
    // silently polluting an unrelated test's own call count. Draining once
    // here, after every test in this block, is simpler and far less
    // fragile than annotating each push site by hand.
    afterEach(async () => {
      await advance(320);
    });

    it("opens a closed panel for the pushed path that matches this tab's own session plan, without moving focus", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();
      const focusedBefore = FakeTerminal.instances[0]?.focused;

      sessionPlanEntry = { path: "/plans/build.md" };
      dataListener?.("tab-1", CWD("/proj"));
      await settle();
      await advance(320); // clears the 300ms per-tab debounce

      plansChangedListener?.("/plans/build.md");
      await settle();

      expect(panel()?.hidden).toBe(false);
      expect(FakeTerminal.instances[0]?.focused).toBe(focusedBefore);
    });

    // Fix round 1: closePanel() resets the picker (plan-panel.ts), and
    // openPlanPanelWithoutStealingFocus saves/restores document.activeElement
    // as a defensive net besides — together they must survive a panel that
    // was left with its picker open before being closed manually. FakeTerminal's
    // own focus() is a call counter, not a real DOM focus (see
    // terminal-double.ts), so a real, independently-focusable element
    // stands in for "the terminal has the keys" here.
    it("never steals focus back to the picker, even if it was left open before a manual close", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();

      FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
      runAction("Toggle plan panel");
      await settle();
      panel()?.querySelector<HTMLElement>('[data-action="open-picker"]')?.click();
      expect(panel()?.querySelector(".plan-panel__picker")).toBeTruthy();

      FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
      runAction("Toggle plan panel");
      await settle();
      expect(panel()?.hidden).toBe(true);

      const terminalStandIn = document.createElement("input");
      document.body.append(terminalStandIn);
      terminalStandIn.focus();
      expect(document.activeElement).toBe(terminalStandIn);

      sessionPlanEntry = { path: "/plans/build.md" };
      dataListener?.("tab-1", CWD("/proj"));
      await settle();
      await advance(320);
      plansChangedListener?.("/plans/build.md");
      await settle();
      await advance(50); // the extra macrotask openPlanPanelWithoutStealingFocus waits on

      expect(panel()?.hidden).toBe(false);
      expect(panel()?.querySelector(".plan-panel__picker")).toBeFalsy();
      expect(document.activeElement).toBe(terminalStandIn);
    });

    it("does not open for a path that is not this tab's own session plan", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();

      sessionPlanEntry = { path: "/plans/build.md" };
      dataListener?.("tab-1", CWD("/proj"));
      await settle();
      await advance(320);

      plansChangedListener?.("/plans/unrelated.md");
      await settle();

      expect(panel()?.hidden).toBe(true);
    });

    it("does not auto-open before the debounced session-plan lookup has answered", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();

      sessionPlanEntry = { path: "/plans/build.md" };
      dataListener?.("tab-1", CWD("/proj"));
      await settle(); // the cwd event lands, but the 300ms debounce has not fired yet

      plansChangedListener?.("/plans/build.md");
      await settle();

      expect(panel()?.hidden).toBe(true);
    });

    // Controller ruling (fix round 1): never re-open a panel the user
    // closed manually for the same session plan path — the earlier
    // "spec rule 3 is literal" reading was overturned in review.
    it("never re-opens for the session plan path the user just closed manually", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();
      sessionPlanEntry = { path: "/plans/build.md" };
      dataListener?.("tab-1", CWD("/proj"));
      await settle();
      await advance(320);
      plansChangedListener?.("/plans/build.md");
      await settle();
      expect(panel()?.hidden).toBe(false);

      FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
      runAction("Toggle plan panel");
      await settle();
      expect(panel()?.hidden).toBe(true);

      plansChangedListener?.("/plans/build.md");
      await settle();
      await advance(320); // the push's own debounced re-check, too

      expect(panel()?.hidden).toBe(true);
    });

    // The other half of the same ruling: a *different* session plan is not
    // what the user dismissed, so it re-arms auto-open.
    it("re-arms auto-open once a different session plan path resolves", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();
      sessionPlanEntry = { path: "/plans/build.md" };
      dataListener?.("tab-1", CWD("/proj"));
      await settle();
      await advance(320);
      plansChangedListener?.("/plans/build.md");
      await settle();
      expect(panel()?.hidden).toBe(false);

      FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
      runAction("Toggle plan panel");
      await settle();
      expect(panel()?.hidden).toBe(true);

      // The session moves on to a different plan file — a new cwd event
      // re-resolves the session plan to something other than what was
      // dismissed.
      sessionPlanEntry = { path: "/plans/second.md" };
      dataListener?.("tab-1", CWD("/proj/sub"));
      await settle();
      await advance(320);

      plansChangedListener?.("/plans/second.md");
      await settle();

      expect(panel()?.hidden).toBe(false);
    });

    // Fix round 1's own missing test: onFocus with an unknown cwd must
    // clear the *cached* session plan too, not only cancel a pending
    // lookup — otherwise a stale sessionPlanPath from before the focus
    // change could still match a later push.
    it("clears the cached session plan when the newly focused pane has no known cwd", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();
      sessionPlanEntry = { path: "/plans/build.md" };
      dataListener?.("tab-1", CWD("/proj"));
      await settle();
      await advance(320); // sessionPlanPath resolves to build.md

      // Split off a new pane and focus it — it has never reported a cwd,
      // so onFocus sees path === undefined.
      FakeTerminal.instances[0]?.pressKey({ key: "d", metaKey: true });
      await settle();

      plansChangedListener?.("/plans/build.md");
      await settle();

      // Nothing was ever dismissed — the cached value was simply cleared,
      // so it no longer matches the pushed path.
      expect(panel()?.hidden).toBe(true);
    });

    // Fix round 2: workspace-terminal.ts used to clear dismissedPlanPath
    // whenever a resolution's own path differed from it — including
    // `resolved === undefined`. Focusing a sibling split with a real cwd
    // but no active session (a plain shell) resolved "undefined" and wiped
    // the dismissal; focusing back onto the claude pane then re-opened the
    // very plan the user had just closed.
    it("keeps a dismissed plan dismissed after focusing a sibling split with no session of its own", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();
      sessionPlanEntry = { path: "/plans/build.md" };
      dataListener?.("tab-1", CWD("/proj"));
      await settle();
      await advance(320);
      plansChangedListener?.("/plans/build.md");
      await settle();
      expect(panel()?.hidden).toBe(false);

      FakeTerminal.instances[0]?.pressKey({ key: "p", metaKey: true });
      runAction("Toggle plan panel");
      await settle();
      expect(panel()?.hidden).toBe(true);

      // Split off a plain shell pane, focus it, and let it report its own
      // real cwd — no active claude session there, so its own lookup
      // resolves session: undefined.
      FakeTerminal.instances[0]?.pressKey({ key: "d", metaKey: true });
      await settle();
      sessionPlanEntry = undefined;
      dataListener?.("tab-1:p1", CWD("/proj/other"));
      await settle();
      await advance(320); // resolves sessionPlanPath to undefined for the sibling

      // Focus back onto the original claude pane — its own last-known cwd
      // ("/proj") re-resolves through the same debounce.
      FakeTerminal.instances[1]?.pressKey({ key: "ArrowLeft", metaKey: true, altKey: true });
      await settle();
      sessionPlanEntry = { path: "/plans/build.md" };
      await advance(320);

      // The dismissal must have survived the detour through the sibling.
      plansChangedListener?.("/plans/build.md");
      await settle();
      await advance(320);
      expect(panel()?.hidden).toBe(true);

      // A genuinely different session plan still re-arms auto-open.
      sessionPlanEntry = { path: "/plans/second.md" };
      dataListener?.("tab-1", CWD("/proj/sub"));
      await settle();
      await advance(320);
      plansChangedListener?.("/plans/second.md");
      await settle();
      expect(panel()?.hidden).toBe(false);
    });

    // Fix round 1: a foreground process like `claude` never re-emits OSC 7
    // while it works, so the cached session plan can go stale exactly when
    // a plan just changed — the brief's own required fix is a fresh,
    // debounced plansList scheduled from the push itself, not only from
    // cwd/focus events.
    it("resolves a session plan that only changed after the last cwd event, from the plans:changed push itself", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();
      sessionPlanEntry = { path: "/plans/old.md" };
      dataListener?.("tab-1", CWD("/proj"));
      await settle();
      await advance(320); // sessionPlanPath resolves to old.md; no further cwd event ever follows

      sessionPlanEntry = { path: "/plans/new.md" };
      plansChangedListener?.("/plans/new.md");
      await settle();
      await advance(320); // the push's own debounced plansList resolves

      expect(panel()?.hidden).toBe(false);
    });

    // Fix round 1's own required guard: clearTimeout only cancels a timer
    // that has not fired yet, never an in-flight plansList promise — two
    // requests can still race, and the older one must never win.
    it("never lets a stale plansList answer overwrite a newer one", async () => {
      const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
      const resolvers: Array<
        (value: { session?: { path: string }; planMode: never[]; repo: never[] }) => void
      > = [];
      jarvis["plansList"] = (paneKey: string, cwd?: string) => {
        calls.push({ call: "plansList", args: [paneKey, cwd] });
        return new Promise((resolve) => resolvers.push(resolve));
      };
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();

      dataListener?.("tab-1", CWD("/proj-a"));
      await settle();
      await advance(320); // request #1 fires and is held open

      dataListener?.("tab-1", CWD("/proj-b"));
      await settle();
      await advance(320); // request #2 fires and is held open

      expect(resolvers).toHaveLength(2);
      // The newer request resolves first…
      resolvers[1]?.({ session: { path: "/plans/b.md" }, planMode: [], repo: [] });
      await settle();
      // …then the stale, older one arrives late. Without the request-id
      // guard this would overwrite sessionPlanPath back to "a.md".
      resolvers[0]?.({ session: { path: "/plans/a.md" }, planMode: [], repo: [] });
      await settle();

      plansChangedListener?.("/plans/b.md");
      await settle();

      expect(panel()?.hidden).toBe(false);
    });

    // The other side of the same rule: a panel already open for the
    // matching path stays open through a repeat push — notifyChanged
    // refreshes it, never open()/close() again.
    it("leaves an already-open panel open on a repeat push for the same path", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();
      sessionPlanEntry = { path: "/plans/build.md" };
      dataListener?.("tab-1", CWD("/proj"));
      await settle();
      await advance(320);
      plansChangedListener?.("/plans/build.md");
      await settle();
      expect(panel()?.hidden).toBe(false);

      plansChangedListener?.("/plans/build.md");
      await settle();

      expect(panel()?.hidden).toBe(false);
    });

    it("debounces the session-plan lookup to one plansList call per tab across rapid cwd changes", async () => {
      const { renderWorkspaceTerminals } = await tabWithPanel();
      renderWorkspaceTerminals([tab()], "tab-1", "acme");
      await settle();
      calls = calls.filter((c) => c.call === "plansList"); // drop anything unrelated so length is exact

      dataListener?.("tab-1", CWD("/proj"));
      await settle();
      dataListener?.("tab-1", CWD("/proj/src"));
      await settle();
      await advance(320);

      const plansListCalls = calls.filter((c) => c.call === "plansList");
      expect(plansListCalls).toHaveLength(1);
      expect(plansListCalls[0]?.args).toEqual(["tab-1", "/proj/src"]);
    });
  });
});
