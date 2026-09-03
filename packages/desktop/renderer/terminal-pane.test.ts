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

  function press(p: { element: HTMLElement }, init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    textarea(p)?.dispatchEvent(event);
    return event;
  }

  it("shows the editor once the shell says it is at a prompt", () => {
    const { p } = editorPane();
    p.write(`${A}$ ${B}`);
    expect(p.element.dataset["state"]).toBe("blocks");
    expect(editorEl(p)?.hidden).toBe(false);
  });

  it("hides the editor while a command is running and lets the pty have the keys", () => {
    const { p, sendInput } = editorPane();
    p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}`);
    expect(p.element.dataset["state"]).toBe("running");
    expect(editorEl(p)?.hidden).toBe(true);
    // Hidden is only half the claim: the keystroke has to arrive somewhere,
    // and while a command runs that somewhere is the pty, raw.
    FakeTerminal.instances[0]?.emitData("y");
    expect(sendInput).toHaveBeenCalledWith("y");
  });

  // The one whose loss a user would notice within a minute.
  it("interrupts a running command with ^C", () => {
    const { p, sendInput } = editorPane();
    p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}`);
    FakeTerminal.instances[0]?.emitData("\u0003");
    expect(sendInput).toHaveBeenCalledWith("\u0003");
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
    // Once. A line sent twice runs the command twice.
    expect(sendInput).toHaveBeenCalledTimes(1);
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

  it("sends nothing for a Ctrl chord that has no control byte", () => {
    const { p, sendInput } = editorPane();
    p.write(`${A}$ ${B}`);
    const field = textarea(p);
    if (field === null) throw new Error("no editor");
    field.value = "ls -l";

    const event = press(p, { key: "1", ctrlKey: true });

    // Nothing to the pty — zsh's line buffer would otherwise hold "1" while
    // the editor showed "ls -l", and the next Enter would run "1ls -l".
    expect(sendInput).not.toHaveBeenCalled();
    expect(field.value).toBe("ls -l");
    // And the key was not swallowed either: nothing was sent, so nothing was
    // prevented.
    expect(event.defaultPrevented).toBe(false);
  });

  // ↑ takes the line away; ↓ has to give it back. Losing a half-typed
  // command to a stray arrow is the kind of small betrayal that stops people
  // trusting the editor.
  it("gives the half-typed line back when the arrows walk off the newest entry", async () => {
    const { p } = editorPane(EDITOR_SETTINGS, async () => ["git status", "ls"]);
    p.write(`${A}$ ${B}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const field = textarea(p);
    if (field === null) throw new Error("no editor");
    field.value = "half-typed";

    press(p, { key: "ArrowUp" });
    expect(field.value).toBe("git status");
    press(p, { key: "ArrowDown" });
    expect(field.value).toBe("half-typed");
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

  // Re-run fills; it never runs. With an editor live it must fill *that* —
  // putting the command into zsh's line buffer instead would leave the shell
  // and the line on screen disagreeing until the next prompt.
  it("fills the editor on re-run, sending nothing to the pty", () => {
    const { p, sendInput } = editorPane();
    p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}${A}$ ${B}`);
    expect(editorEl(p)?.hidden).toBe(false);

    p.element.querySelector<HTMLElement>(".block-rerun")?.click();

    expect(textarea(p)?.value).toBe("ls");
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("types the command at the prompt on re-run when there is no editor", () => {
    const { p, sendInput } = editorPane({ ...EDITOR_SETTINGS, inputEditor: false });
    p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}${A}$ ${B}`);

    p.element.querySelector<HTMLElement>(".block-rerun")?.click();

    expect(editorEl(p)).toBeNull();
    // The command only — a re-run that appended a return would run it.
    expect(sendInput).toHaveBeenCalledWith("ls");
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  // "No editor" also covers a hidden one, and a re-run that fell through
  // to typing at the prompt in that state would be typing straight into
  // whatever is now reading stdin — a running program, not zsh. The
  // block's own ↻ control has been reachable since Task 6/7; this is the
  // regression test for the fix that finally guards it.
  it("sends nothing when the block's own re-run control is clicked while a command is running", () => {
    const { p, sendInput } = editorPane({ ...EDITOR_SETTINGS, inputEditor: false });
    p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}${A}$ ${B}`);
    p.write(`sleep 9\r\n${C("sleep 9")}`);
    expect(p.element.dataset["state"]).toBe("running");
    sendInput.mockClear();

    p.element.querySelector<HTMLElement>(".block-rerun")?.click();

    expect(sendInput).not.toHaveBeenCalled();
  });

  it("sends nothing when the block's own re-run control is clicked while the alt screen is held", () => {
    const { p, sendInput } = editorPane({ ...EDITOR_SETTINGS, inputEditor: false });
    p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}${A}$ ${B}`);
    p.write(`top\r\n${C("top")}[?1049h`);
    expect(p.element.dataset["state"]).toBe("alt");
    sendInput.mockClear();

    p.element.querySelector<HTMLElement>(".block-rerun")?.click();

    expect(sendInput).not.toHaveBeenCalled();
  });

  it("reads the command log once per prompt, not once per state change", async () => {
    let reads = 0;
    const { p } = editorPane(EDITOR_SETTINGS, async () => {
      reads += 1;
      return [];
    });
    p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}${A}$ ${B}`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Two prompts in that stream — the one before `ls` and the one after it.
    expect(reads).toBe(2);
  });

  // A tab closed while a command is still running: the pane is gone, and
  // nothing the editor path does may throw into what is left.
  it("survives a pane disposed in the middle of a command", () => {
    const { p } = editorPane();
    p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}`);
    p.dispose();
    expect(() => p.write(`out\r\n${D(0)}${A}$ ${B}`)).not.toThrow();
  });

  // What terminal-completion.ts reads instead of the xterm buffer, and
  // what it writes a suggestion back through — see Task 10.
  describe("what the pane exposes for completion to read and write", () => {
    it("reads the editor's own value while it is visible", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}`);
      const field = textarea(p);
      if (field === null) throw new Error("no editor");
      field.value = "git sta";

      expect(p.readInput()).toBe("git sta");
    });

    it("has no input to read when there is no editor at all", () => {
      const { p } = editorPane({ ...EDITOR_SETTINGS, inputEditor: false });
      p.write(`${A}$ ${B}`);
      expect(p.readInput()).toBeUndefined();
    });

    it("has no input to read while the editor is hidden — a command running", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}`);
      expect(p.readInput()).toBeUndefined();
    });

    it("applies a suggestion by setting the editor's value, not by touching the pty", () => {
      const { p, sendInput } = editorPane();
      p.write(`${A}$ ${B}`);

      p.applyInput("git status");

      expect(textarea(p)?.value).toBe("git status");
      expect(sendInput).not.toHaveBeenCalled();
    });

    it("exposes the editor's own element for the dropdown to anchor to", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}`);
      expect(p.editorElement()).toBe(editorEl(p));
    });

    it("has no editor element to expose when the editor is off", () => {
      const { p } = editorPane({ ...EDITOR_SETTINGS, inputEditor: false });
      p.write(`${A}$ ${B}`);
      expect(p.editorElement()).toBeUndefined();
    });
  });

  // The dropdown claims a key over the editor's textarea the same way it
  // claims one over xterm: consulted first, before anything else acts on
  // it. xterm's own attachCustomKeyEventHandler never sees these — the
  // event targets the editor's <textarea>, not xterm's, and never bubbles
  // there — so this is the pane's own consultation point instead.
  describe("interceptKey — the dropdown's first look at an editor keystroke", () => {
    function editorPaneWithIntercept(interceptKey: (event: KeyboardEvent) => boolean) {
      const host = document.createElement("div");
      document.body.append(host);
      const sendInput = vi.fn();
      const p = createPane(host, {
        sendInput,
        resize: vi.fn(),
        attach: async () => "",
        settings: EDITOR_SETTINGS,
        history: async () => ["git status", "ls"],
        interceptKey,
      });
      return { p, sendInput };
    }

    it("asks interceptKey before the editor acts on the same key", () => {
      const seen: string[] = [];
      const { p } = editorPaneWithIntercept((event) => {
        seen.push(event.key);
        return true;
      });
      p.write(`${A}$ ${B}`);

      press(p, { key: "ArrowUp" });

      expect(seen).toEqual(["ArrowUp"]);
    });

    it("stops the editor from also handling a key the dropdown claimed", async () => {
      const { p } = editorPaneWithIntercept(() => false);
      p.write(`${A}$ ${B}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const field = textarea(p);
      if (field === null) throw new Error("no editor");
      field.value = "half-typed";

      // ArrowUp would normally walk into Jarvis's command log.
      press(p, { key: "ArrowUp" });

      expect(field.value).toBe("half-typed");
    });

    it("lets the editor handle the key normally once interceptKey declines it", async () => {
      const { p } = editorPaneWithIntercept(() => true);
      p.write(`${A}$ ${B}`);
      await new Promise((resolve) => setTimeout(resolve, 0));

      press(p, { key: "ArrowUp" });

      expect(textarea(p)?.value).toBe("git status");
    });

    it("never consults interceptKey once the editor is hidden", () => {
      const seen: string[] = [];
      const { p, sendInput } = editorPaneWithIntercept((event) => {
        seen.push(event.key);
        return true;
      });
      p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}`);

      FakeTerminal.instances[0]?.emitData("y");

      expect(seen).toEqual([]);
      expect(sendInput).toHaveBeenCalledWith("y");
    });
  });

  // ⌘P and `^R`: Task 12's palette, over the focused pane. Both are claimed
  // by the same capture-phase listener the dropdown uses, gated the same
  // way — only while the editor is what is showing.
  describe("the command palette", () => {
    function paletteEl(p: { element: HTMLElement }): HTMLElement | null {
      return p.element.querySelector(".terminal-palette");
    }

    it("opens on Cmd+P at an idle prompt, listing the pane's actions", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}`);

      press(p, { key: "p", metaKey: true });

      const palette = paletteEl(p);
      expect(palette?.hidden).toBe(false);
      expect(palette?.textContent).toContain("Clear terminal");
      expect(palette?.textContent).toContain("Collapse all blocks");
    });

    // The pane's own capture-phase listener (this file's `press`, which
    // targets the editor's textarea) defers Cmd+P once the editor is
    // hidden — it is not the listener that claims it in that state.
    // terminal-addons.ts's attachKeys is, unconditionally, via the
    // `openPalette` hook exercised directly below and covered end to end
    // in terminal-addons.test.ts.
    it("the editor-gated listener leaves Cmd+P unclaimed once the editor is hidden", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}`);

      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "p",
        metaKey: true,
      });
      p.element.dispatchEvent(event);

      expect(paletteEl(p)?.hidden).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    });

    // What actually claims ⌘P in every state that is not "the editor is
    // showing": terminal-addons.ts's attachKeys calls exactly this method,
    // unconditionally — see terminal-addons.test.ts for that wiring, and
    // workspace-terminal.ts for `hooks.openPalette: () => view.openPalette()`.
    it("openPalette() opens while a command is running", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}`);
      expect(p.element.dataset["state"]).toBe("running");

      p.openPalette();

      const palette = paletteEl(p);
      expect(palette?.hidden).toBe(false);
      expect(palette?.textContent).toContain("Clear terminal");
    });

    it("openPalette() opens while the alternate screen is held", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}top\r\n${C("top")}[?1049h`);
      expect(p.element.dataset["state"]).toBe("alt");

      p.openPalette();

      expect(paletteEl(p)?.hidden).toBe(false);
    });

    it("openPalette() opens with the input editor off entirely", () => {
      const { p } = editorPane({ ...EDITOR_SETTINGS, inputEditor: false });
      p.write(`${A}$ ${B}`);
      expect(editorEl(p)).toBeNull();

      p.openPalette();

      expect(paletteEl(p)?.hidden).toBe(false);
    });

    it("runs the chosen action exactly once on Enter, and closes", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}`);
      press(p, { key: "p", metaKey: true });

      const input = paletteEl(p)?.querySelector("input");
      if (input === null || input === undefined) throw new Error("no palette input");
      input.value = "Clear terminal";
      input.dispatchEvent(new Event("input"));
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));

      expect(FakeTerminal.instances[0]?.cleared).toBe(1);
      expect(paletteEl(p)?.hidden).toBe(true);
    });

    it("offers copy/re-run for the selected block only when a block is selected", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}${A}$ ${B}`);

      press(p, { key: "p", metaKey: true });
      expect(paletteEl(p)?.textContent).not.toContain("Re-run command");

      // Closing and selecting a block before opening again.
      press(p, { key: "Escape" });
      p.blockNav?.move(1);
      press(p, { key: "p", metaKey: true });

      expect(paletteEl(p)?.textContent).toContain("Re-run command");
      expect(paletteEl(p)?.textContent).toContain("Copy output");
      expect(paletteEl(p)?.textContent).toContain("Copy command");
    });

    // The selection survives into "running" — this is the palette's half
    // of the fix: re-run offering to type the command straight into
    // whatever is now reading stdin. Copy stays offered; nothing about it
    // touches the pty.
    it("drops the re-run entry (but keeps copy) once a command starts running with a block still selected", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}${A}$ ${B}`);
      p.blockNav?.move(1);
      p.write(`sleep 9\r\n${C("sleep 9")}`);
      expect(p.element.dataset["state"]).toBe("running");

      p.openPalette();

      const text = paletteEl(p)?.textContent ?? "";
      expect(text).toContain("Copy output");
      expect(text).toContain("Copy command");
      expect(text).not.toContain("Re-run command");
    });

    it("drops the re-run entry while the alt screen is held, same as while running", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}${A}$ ${B}`);
      p.blockNav?.move(1);
      p.write(`top\r\n${C("top")}[?1049h`);
      expect(p.element.dataset["state"]).toBe("alt");

      p.openPalette();

      expect(paletteEl(p)?.textContent).not.toContain("Re-run command");
    });

    it("re-runs the selected block by filling the editor, never sending it", () => {
      const { p, sendInput } = editorPane();
      p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}${A}$ ${B}`);
      p.blockNav?.move(1);
      press(p, { key: "p", metaKey: true });

      const input = paletteEl(p)?.querySelector("input");
      if (input === null || input === undefined) throw new Error("no palette input");
      input.value = "Re-run command";
      input.dispatchEvent(new Event("input"));
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));

      expect(textarea(p)?.value).toBe("ls");
      expect(sendInput).not.toHaveBeenCalled();
    });

    it("offers no split actions with no splitKeys — nothing reachable through it does nothing", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}`);

      press(p, { key: "p", metaKey: true });

      expect(paletteEl(p)?.textContent).not.toContain("Split right");
    });

    it("leaves Cmd+P claiming nothing before this pane has ever seen a prompt", () => {
      const { p } = editorPane();

      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "p",
        metaKey: true,
      });
      p.element.dispatchEvent(event);

      expect(paletteEl(p)?.hidden ?? true).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    });

    it("^R asks over Jarvis's own command log and fills the editor with the choice, never running it", async () => {
      const { p, sendInput } = editorPane(EDITOR_SETTINGS, async () => ["git status", "git log"]);
      p.write(`${A}$ ${B}`);
      await new Promise((resolve) => setTimeout(resolve, 0));

      press(p, { key: "r", ctrlKey: true });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const palette = paletteEl(p);
      expect(palette?.hidden).toBe(false);
      const input = palette?.querySelector("input");
      if (input === null || input === undefined) throw new Error("no palette input");
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }));
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(textarea(p)?.value).toBe("git log");
      expect(sendInput).not.toHaveBeenCalled();
    });

    it("^R leaves the editor untouched on Escape", async () => {
      const { p } = editorPane(EDITOR_SETTINGS, async () => ["git status"]);
      p.write(`${A}$ ${B}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const field = textarea(p);
      if (field === null) throw new Error("no editor");
      field.value = "half-typed";

      press(p, { key: "r", ctrlKey: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const input = paletteEl(p)?.querySelector("input");
      input?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(field.value).toBe("half-typed");
    });

    // A pane can be disposed while historySearch() is still awaiting
    // palette.ask() — dispose() must close the palette (and so resolve
    // that promise to undefined) rather than leave it pending forever.
    it("closes the palette on dispose, resolving a ^R search still in flight", async () => {
      const { p } = editorPane(EDITOR_SETTINGS, async () => ["git status"]);
      p.write(`${A}$ ${B}`);
      await new Promise((resolve) => setTimeout(resolve, 0));

      press(p, { key: "r", ctrlKey: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(paletteEl(p)?.hidden).toBe(false);

      expect(() => p.dispose()).not.toThrow();

      expect(paletteEl(p)?.hidden).toBe(true);
    });

    function editorPaneWithCloseCompletion(closeCompletion: () => void) {
      const host = document.createElement("div");
      document.body.append(host);
      const p = createPane(host, {
        sendInput: vi.fn(),
        resize: vi.fn(),
        attach: async () => "",
        settings: EDITOR_SETTINGS,
        history: async () => [],
        closeCompletion,
      });
      return { p };
    }

    it("closes the completion dropdown before opening via openPalette()", () => {
      let closed = 0;
      const { p } = editorPaneWithCloseCompletion(() => (closed += 1));
      p.write(`${A}$ ${B}`);

      p.openPalette();

      expect(closed).toBe(1);
      expect(paletteEl(p)?.hidden).toBe(false);
    });

    it("closes the completion dropdown before opening via the editor-gated Cmd+P listener", () => {
      let closed = 0;
      const { p } = editorPaneWithCloseCompletion(() => (closed += 1));
      p.write(`${A}$ ${B}`);

      press(p, { key: "p", metaKey: true });

      expect(closed).toBe(1);
      expect(paletteEl(p)?.hidden).toBe(false);
    });
  });
});
