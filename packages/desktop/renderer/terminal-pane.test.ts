// @vitest-environment jsdom
//
// One terminal as the user sees it: frozen blocks above, a live terminal
// below. xterm.js is doubled the way every other renderer terminal test
// doubles it, and block-render.js is stubbed because what a finished block
// *looks* like is block-render's own test's business — what is under test
// here is the pane's state machine and, above all, that every byte still
// reaches the live terminal.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFitAddon, FakeTerminal } from "./terminal-double.js";

vi.mock("./vendor/xterm.mjs", () => ({ Terminal: FakeTerminal }));
vi.mock("./vendor/addon-fit.mjs", () => ({ FitAddon: FakeFitAddon }));
// A vi.fn() wrapper, not a bare arrow function, so one test (the deferred
// scroll below) can swap in a renderOutput that actually defers, matching
// its documented contract, without disturbing every other test's default.
const renderOutputMock = vi.fn((ansi: string, _cols: number) => {
  const element = document.createElement("div");
  element.className = "block-output";
  element.textContent = ansi;
  return element;
});
vi.mock("./block-render.js", () => ({
  renderOutput: (ansi: string, cols: number) => renderOutputMock(ansi, cols),
}));

const { createPane } = await import("./terminal-pane.js");

const A = "\u001b]133;A\u0007";
const B = "\u001b]133;B\u0007";
const C = (c: string) => `\u001b]133;C;${c}\u0007`;
const D = (n: number) => `\u001b]133;D;${n}\u0007`;

function pane(settings = { blocks: true, inputEditor: false, notifyAfterSeconds: 0, home: "/Users/x" }) {
  const host = document.createElement("div");
  document.body.append(host);
  return createPane(host, {
    sendInput: vi.fn(),
    resize: vi.fn(),
    attach: async () => "",
    settings,
  });
}

beforeEach(() => {
  FakeTerminal.instances = [];
  document.body.replaceChildren();
});

describe("a terminal pane", () => {
  // The whole stream, exactly: everything but the marks themselves, in the
  // order the shell wrote it, once each. "Contains" would pass for a pane
  // that dropped the prompt, doubled a chunk or reordered two events, and
  // this is the assertion the feature's one unbreakable rule rests on.
  it("writes every byte to the live terminal", () => {
    const p = pane();
    p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}`);
    expect(FakeTerminal.instances[0]?.written.join("")).toBe("$ ls\r\na b\r\n");
  });

  // One read from the pty can carry a whole command and the start of the
  // next. Every event in it is handled in order, and a freeze in the middle
  // does not disturb what follows it.
  it("keeps the stream in order when one chunk holds several commands", () => {
    const p = pane();
    p.write(
      `${A}$ ${B}a\r\n${C("a")}1\r\n${D(0)}` + `${A}$ ${B}b\r\n${C("b")}2\r\n${D(0)}`,
    );
    expect(FakeTerminal.instances[0]?.written.join("")).toBe("$ a\r\n1\r\n$ b\r\n2\r\n");
    expect(p.blocks().map((view) => view.record.command)).toEqual(["a", "b"]);
  });

  // A mark can be torn in half by the read boundary. The splitter holds the
  // fragment back, so the pane must not have written it as plain bytes — and
  // must still see the command it named.
  it("loses nothing when a mark is split across two writes", () => {
    const p = pane();
    p.write(`${A}$ ${B}ls\r\n\u001b]133;C;l`);
    p.write(`s\u0007a b\r\n${D(0)}`);
    expect(FakeTerminal.instances[0]?.written.join("")).toBe("$ ls\r\na b\r\n");
    expect(p.blocks()[0]?.record.command).toBe("ls");
  });

  it("freezes a finished command into a block and clears the live terminal", () => {
    const p = pane();
    p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}`);
    expect(p.blocks()).toHaveLength(1);
    expect(p.blocks()[0]?.record.command).toBe("ls");
    expect(FakeTerminal.instances[0]?.resets).toBeGreaterThan(0);
  });

  it("keeps the live terminal alone while a command is still running", () => {
    const p = pane();
    p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}working`);
    expect(p.blocks()).toHaveLength(0);
    expect(FakeTerminal.instances[0]?.resets).toBe(0);
  });

  it("gives the whole pane to a full-screen program and takes it back after", () => {
    const p = pane();
    p.write(`${A}$ ${B}top\r\n${C("top")}\u001b[?1049h`);
    expect(p.element.dataset["state"]).toBe("alt");
    p.write("\u001b[?1049l");
    // The exit sequence on its own, before the D that ends the command: with
    // the two in one chunk, block-done would put the state back to "blocks"
    // and this would pass even if the alt-screen branch did nothing at all.
    expect(p.element.dataset["state"]).toBe("blocks");
    p.write(D(0));
    expect(p.blocks()).toHaveLength(1);
  });

  // Not one byte is examined, let alone withheld: the chunk goes to xterm
  // exactly as it arrived, marks and all, which is the terminal Jarvis
  // shipped before blocks existed.
  it("builds no blocks at all when blocks are off", () => {
    const p = pane({ blocks: false, inputEditor: false, notifyAfterSeconds: 0, home: "/Users/x" });
    const chunk = `${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}`;
    p.write(chunk);
    expect(p.blocks()).toHaveLength(0);
    expect(FakeTerminal.instances[0]?.written.join("")).toBe(chunk);
  });

  // renderOutput() populates its element a macrotask after it returns (see
  // its own contract in block-render.ts) — a scroll fired the instant the
  // block is appended would settle at a height that does not include its
  // output yet. This pins the fix: the pane must not have scrolled to the
  // true bottom until that macrotask has actually run.
  it("scrolls to the bottom only once the block has finished painting, not before", async () => {
    let painted = false;
    renderOutputMock.mockImplementationOnce((ansi: string) => {
      const element = document.createElement("div");
      element.className = "block-output";
      setTimeout(() => {
        painted = true;
        element.textContent = ansi;
      }, 0);
      return element;
    });

    const p = pane();
    Object.defineProperty(p.element, "scrollHeight", {
      configurable: true,
      get: () => (painted ? 500 : 100),
    });

    p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}`);
    // Synchronously after block-done: the output has not painted yet, so a
    // scroll fired now would land short.
    expect(p.element.scrollTop).not.toBe(500);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(painted).toBe(true);
    expect(p.element.scrollTop).toBe(500);
  });

  it("drops the oldest blocks past the cap", () => {
    const p = pane();
    for (let i = 0; i < 505; i += 1) p.write(`${A}$ ${B}x\r\n${C(`x${i}`)}out\r\n${D(0)}`);
    expect(p.blocks()).toHaveLength(500);
    expect(p.blocks()[0]?.record.command).toBe("x5");
    // And the dropped views left the page with the records: a cap that only
    // trimmed the array would leak a DOM node per command forever.
    expect(p.element.querySelector(".terminal-blocks")?.children).toHaveLength(500);
  });
});

// The command editor: a DOM line that stands in front of the shell, but
// only while the shell is sitting at an idle prompt. Every other moment —
// a command running, a full-screen program, a shell with no integration at
// all — the editor is gone and keystrokes go to the pty raw, which is what
// keeps a sudo password prompt, `git rebase -i` and a ^C for a hung command
// working exactly as they do today.
describe("the command editor in a pane", () => {
  const EDITOR_SETTINGS = {
    blocks: true,
    inputEditor: true,
    notifyAfterSeconds: 0,
    home: "/Users/x",
  };

  function editorPane(
    settings: {
      blocks: boolean;
      inputEditor: boolean;
      notifyAfterSeconds: number;
      home: string;
    } = EDITOR_SETTINGS,
    history: () => Promise<string[]> = async () => [],
  ) {
    const host = document.createElement("div");
    document.body.append(host);
    const sendInput = vi.fn();
    const p = createPane(host, {
      sendInput,
      resize: vi.fn(),
      attach: async () => "",
      settings,
      history,
    });
    return { p, sendInput };
  }

  const editorEl = (p: { element: HTMLElement }) =>
    p.element.querySelector<HTMLElement>(".terminal-input");
  const textarea = (p: { element: HTMLElement }) =>
    p.element.querySelector<HTMLTextAreaElement>("textarea.terminal-input-text");

  function press(p: { element: HTMLElement }, init: KeyboardEventInit): void {
    textarea(p)?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  }

  it("shows the editor once the shell says it is at a prompt", () => {
    const { p } = editorPane();
    p.write(`${A}$ ${B}`);
    expect(p.element.dataset["state"]).toBe("blocks");
    expect(editorEl(p)?.hidden).toBe(false);
  });

  it("hides the editor while a command is running", () => {
    const { p } = editorPane();
    p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}`);
    expect(p.element.dataset["state"]).toBe("running");
    expect(editorEl(p)?.hidden).toBe(true);
  });

  // A TUI owns the screen and every key on it; an editor drawn over that
  // would swallow the keys the program is waiting for.
  it("hides the editor while a program holds the alternate screen", () => {
    const { p } = editorPane();
    p.write(`${A}$ ${B}top\r\n${C("top")}\u001b[?1049h`);
    expect(p.element.dataset["state"]).toBe("alt");
    expect(editorEl(p)?.hidden).toBe(true);
    // Leaving the alternate screen is not the end of the command — a script
    // that calls vim and carries on is still running, and its keys are still
    // its own. The editor comes back at the next prompt, not before.
    p.write("\u001b[?1049l");
    expect(editorEl(p)?.hidden).toBe(true);
    p.write(`${D(0)}${A}$ ${B}`);
    expect(editorEl(p)?.hidden).toBe(false);
  });

  // No OSC 133 means Jarvis cannot tell a prompt from a password prompt, so
  // the editor never appears — the "plain" terminal, in every way that
  // matters to a keystroke.
  it("keeps the editor hidden in a shell with no prompt marks at all", () => {
    const { p } = editorPane();
    p.write("Password: ");
    expect(editorEl(p)?.hidden).toBe(true);
  });

  it("creates no editor at all when the input editor is off", () => {
    const { p, sendInput } = editorPane({ ...EDITOR_SETTINGS, inputEditor: false });
    p.write(`${A}$ ${B}`);
    expect(editorEl(p)).toBeNull();
    // And a keystroke reaches the pty exactly as it does today.
    FakeTerminal.instances[0]?.emitData("x");
    expect(sendInput).toHaveBeenCalledWith("x");
  });

  it("sends a submitted line to the pty with a carriage return", () => {
    const { p, sendInput } = editorPane();
    p.write(`${A}$ ${B}`);
    const field = textarea(p);
    if (field === null) throw new Error("no editor");
    field.value = "ls -la";
    press(p, { key: "Enter" });
    expect(sendInput).toHaveBeenCalledWith("ls -la\r");
  });

  // The two whose loss would make the terminal feel broken: ^C interrupts,
  // ^D ends the shell. Neither is the editor's to eat.
  it("passes a Ctrl chord to the pty as its control byte", () => {
    const { p, sendInput } = editorPane();
    p.write(`${A}$ ${B}`);
    press(p, { key: "c", ctrlKey: true });
    expect(sendInput).toHaveBeenCalledWith("\u0003");
    press(p, { key: "d", ctrlKey: true });
    expect(sendInput).toHaveBeenCalledWith("\u0004");
  });

  // Read off the screen, never modelled: the prompt shown is the one the
  // shell actually drew.
  it("labels the editor with the prompt the shell drew", () => {
    const { p } = editorPane();
    const terminal = FakeTerminal.instances[0];
    terminal?.typeLine("~/p master $ ");
    p.write(`${A}${B}`);
    expect(p.element.querySelector(".terminal-input-prompt")?.textContent).toBe(
      "~/p master $ ",
    );
  });

  // Jarvis's own command log, not zsh's line editor: a line the DOM composed
  // and a line zsh believes it is editing must never be two different things.
  it("walks Jarvis's own command log with the arrows", async () => {
    const { p } = editorPane(EDITOR_SETTINGS, async () => ["git status", "ls"]);
    p.write(`${A}$ ${B}`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    press(p, { key: "ArrowUp" });
    expect(textarea(p)?.value).toBe("git status");
    press(p, { key: "ArrowUp" });
    expect(textarea(p)?.value).toBe("ls");
    press(p, { key: "ArrowDown" });
    expect(textarea(p)?.value).toBe("git status");
  });

  // A tab closed while a command is still running: the pane is gone, and
  // nothing the editor path does may throw into what is left.
  it("survives a pane disposed in the middle of a command", () => {
    const { p } = editorPane();
    p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}`);
    p.dispose();
    expect(() => p.write(`out\r\n${D(0)}${A}$ ${B}`)).not.toThrow();
  });
});
