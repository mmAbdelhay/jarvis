// @vitest-environment jsdom
//
// One terminal as the user sees it: frozen blocks above, a live terminal
// below. xterm.js is doubled the way every other renderer terminal test
// doubles it, and block-render.js is stubbed because what a finished block
// *looks* like is block-render's own test's business — what is under test
// here is the pane's state machine and, above all, that every byte still
// reaches the live terminal.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "@jarvis/platform";
import { FakeFitAddon, FakeTerminal } from "./terminal-double.js";
import { SCROLLBACK_LINES } from "./terminal-theme.js";

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

const CWD = (path: string) => `]7;file://${path}`;

function pane(
  settings = {
    blocks: true,
    inputEditor: false,
    notifyAfterSeconds: 0,
    home: "/Users/x",
    scrollback: 0,
  },
  hooks: {
    onCwd?: (path: string) => void;
    chips?: (path: string) => Promise<import("../src/ipc.js").TerminalChips | undefined>;
  } = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  return createPane(host, {
    sendInput: vi.fn(),
    resize: vi.fn(),
    attach: async () => "",
    settings,
    notify: vi.fn(),
    ...hooks,
  });
}

beforeEach(() => {
  FakeTerminal.instances = [];
  document.body.replaceChildren();
});

describe("a terminal pane's scrollback", () => {
  // xterm stores a line as Uint32Array(cols * 3) — 12 bytes a cell — so at
  // 200 columns this number is ~2.4 MB per 1000 lines, per pane.
  it("uses the configured scrollback", () => {
    pane({
      blocks: true,
      inputEditor: false,
      notifyAfterSeconds: 0,
      home: "/Users/x",
      scrollback: 1234,
    });
    expect(FakeTerminal.instances[0]?.options["scrollback"]).toBe(1234);
  });

  // The value arrives over IPC, so it is not the type checker's to promise —
  // and 0 is what the renderer holds before the answer comes back.
  it("falls back to the default for a value that is not a positive number", () => {
    pane({
      blocks: true,
      inputEditor: false,
      notifyAfterSeconds: 0,
      home: "/Users/x",
      scrollback: 0,
    });
    expect(FakeTerminal.instances[0]?.options["scrollback"]).toBe(SCROLLBACK_LINES);

    FakeTerminal.instances = [];
    pane({
      blocks: true,
      inputEditor: false,
      notifyAfterSeconds: 0,
      home: "/Users/x",
      scrollback: Number.NaN,
    });
    expect(FakeTerminal.instances[0]?.options["scrollback"]).toBe(SCROLLBACK_LINES);
  });
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

  // The reset is ordered *behind* xterm's write buffer, not fired from the
  // event loop that handled block-done. Terminal.write() always defers its
  // parsing to a macrotask and reset() neither drains nor discards what is
  // queued, so a synchronous reset clears the screen and then lets the very
  // bytes it was clearing paint over it: for `ls`, whose output and D mark
  // arrive in one pty read, the whole output was redrawn into the live
  // terminal directly under the frozen block already showing it — every
  // finished command, every time.
  //
  // This is the assertion that bites. The double records writes
  // synchronously (every other test reads `written` the instant it is
  // handed over), so no assertion on the *screen* can see the double
  // drawing; what it can see, and what the fix is, is that the reset does
  // not happen in the turn that handled the event and does happen once the
  // write callback has run.
  it("freezes a finished command into a block and clears the live terminal behind the write buffer", async () => {
    const p = pane();
    p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}`);
    expect(p.blocks()).toHaveLength(1);
    expect(p.blocks()[0]?.record.command).toBe("ls");
    // Not yet: the output above is still queued in xterm's parser.
    expect(FakeTerminal.instances[0]?.resets).toBe(0);
    // The state flip travels with the clear, for the same reason.
    expect(p.element.dataset["state"]).toBe("running");

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(FakeTerminal.instances[0]?.resets).toBe(1);
    expect(p.element.dataset["state"]).toBe("blocks");
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
    const p = pane({ blocks: false, inputEditor: false, notifyAfterSeconds: 0, home: "/Users/x", scrollback: 0 });
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

    // Two ticks, not one: the scroll now sits inside the write callback that
    // orders the live terminal's reset behind xterm's parser (one macrotask),
    // and is still deferred from there behind the block's own painting
    // (another). Timing only — where the scroll lands has not changed.
    await new Promise((resolve) => setTimeout(resolve, 0));
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

  // For a pane that outlives what it is showing — the Session view points
  // one pane at whichever agent is open. The elements go with the records,
  // for the same reason the cap removes them: a list that only forgot them
  // would leave one agent's output on the page under another's terminal.
  // The live terminal is not this call's business, and resetting it is the
  // caller's separate decision.
  it("drops every block, its element and its selection on reset", () => {
    const p = pane();
    p.write(`${A}$ ${B}a\r\n${C("a")}1\r\n${D(0)}`);
    p.write(`${A}$ ${B}b\r\n${C("b")}2\r\n${D(1)}`);
    p.blockNav?.move(1);
    expect(p.blockNav?.selected()).toBeDefined();
    const written = FakeTerminal.instances[0]?.written.length ?? 0;

    p.reset();

    expect(p.blocks()).toHaveLength(0);
    expect(p.element.querySelector(".terminal-blocks")?.children).toHaveLength(0);
    expect(p.blockNav?.selected()).toBeUndefined();
    expect(FakeTerminal.instances[0]?.written).toHaveLength(written);
  });

  // The pointer route to the selection, and through it to the palette's
  // "Copy output" / "Re-run command", which act on the selected block and
  // are left out of the list entirely when there is none.
  it("selects a block when its header is clicked", () => {
    const p = pane();
    p.write(`${A}$ ${B}a\r\n${C("a")}1\r\n${D(0)}`);
    p.write(`${A}$ ${B}b\r\n${C("b")}2\r\n${D(0)}`);
    expect(p.blockNav?.selected()).toBeUndefined();

    p.blocks()[1]?.element.querySelector<HTMLElement>(".block-header")?.click();

    expect(p.blockNav?.selected()?.record.command).toBe("b");
  });

  // A filter left over from the last thing the pane showed would hide the
  // next thing's blocks the moment they arrived — a pane that looks empty
  // with nothing to say why.
  it("clears a filter on reset, so the next block is visible", () => {
    const p = pane();
    p.write(`${A}$ ${B}a\r\n${C("a")}1\r\n${D(0)}`);
    p.blockNav?.toggleFailedFilter();
    expect(p.blockNav?.isFiltered()).toBe(true);

    p.reset();
    p.write(`${A}$ ${B}b\r\n${C("b")}2\r\n${D(0)}`);

    expect(p.blockNav?.isFiltered()).toBe(false);
    expect(p.blocks()[0]?.element.hidden).toBe(false);
  });

  // Nothing to reset, and nothing to throw: the same rule every other part
  // of the block machinery follows.
  it("resets a pane with blocks switched off without complaint", () => {
    const p = pane({ blocks: false, inputEditor: false, notifyAfterSeconds: 0, home: "/h", scrollback: 0 });
    p.write("hello");

    expect(() => p.reset()).not.toThrow();
    expect(FakeTerminal.instances[0]?.written.join("")).toBe("hello");
  });

  it("tells its owner when the shell's directory changes", () => {
    const onCwd = vi.fn();
    const p = pane(undefined, { onCwd });
    p.write(`${CWD("/repo/src")}${A}$ ${B}`);
    expect(onCwd).toHaveBeenCalledWith("/repo/src");
  });
});

/** A microtask turn — chip reads resolve on promises the pane never
 *  synchronously awaits. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the chip row in a pane", () => {
  it("mounts a chip row above the editor", () => {
    const p = pane({ blocks: true, inputEditor: true, notifyAfterSeconds: 0, home: "/Users/x", scrollback: 0 });
    const chipsEl = p.element.querySelector(".terminal-chips");
    const editorEl = p.element.querySelector(".terminal-input");
    expect(chipsEl).not.toBeNull();
    expect(editorEl).not.toBeNull();
    // DOM order in a flex-column pane is paint order: the chip row has to
    // precede the editor to land above it, not merely exist somewhere.
    const position = chipsEl?.compareDocumentPosition(editorEl as Node);
    expect((position as number) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reads and renders chips on every cwd event", async () => {
    const chips = vi.fn(async () => ({
      cwd: "/Users/x/proj",
      branch: "main",
      detached: false,
      insertions: 1,
      deletions: 0,
      runtime: undefined,
    }));
    const p = pane(undefined, { chips });
    p.write(`${CWD("/Users/x/proj")}${A}$ ${B}`);
    await settle();
    expect(chips).toHaveBeenCalledTimes(1);
    expect(p.element.querySelectorAll(".terminal-chip").length).toBe(3);
    expect(p.element.querySelector(".terminal-chip--branch")?.textContent).toBe("main");
  });

  // Stale-then-update: the row keeps showing what it already had while the
  // new read is still in flight — an input the user cannot yet type into
  // would be worse than one naming last prompt's branch for a moment.
  it("keeps the previous chips visible while a new read is in flight", async () => {
    let resolveSecond: ((value: unknown) => void) | undefined;
    const chips = vi
      .fn()
      .mockResolvedValueOnce({
        cwd: "/Users/x/proj",
        branch: "main",
        detached: false,
        insertions: 0,
        deletions: 0,
        runtime: undefined,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const p = pane(undefined, { chips });
    p.write(`${CWD("/Users/x/proj")}${A}$ ${B}`);
    await settle();
    expect(p.element.querySelector(".terminal-chip--branch")?.textContent).toBe("main");

    // A second prompt starts a second read that has not resolved yet — the
    // wrapper prints OSC 7 on every precmd, even when the directory has not
    // changed.
    p.write(`${CWD("/Users/x/proj")}${A}$ ${B}`);
    await settle();
    expect(p.element.querySelector(".terminal-chip--branch")?.textContent).toBe("main");

    resolveSecond?.({
      cwd: "/Users/x/proj",
      branch: "feature",
      detached: false,
      insertions: 0,
      deletions: 0,
      runtime: undefined,
    });
    await settle();
    expect(p.element.querySelector(".terminal-chip--branch")?.textContent).toBe("feature");
  });

  it("leaves the previous chips showing when a read rejects", async () => {
    const chips = vi
      .fn()
      .mockResolvedValueOnce({
        cwd: "/Users/x/proj",
        branch: "main",
        detached: false,
        insertions: 0,
        deletions: 0,
        runtime: undefined,
      })
      .mockRejectedValueOnce(new Error("read failed"));
    const p = pane(undefined, { chips });
    p.write(`${CWD("/Users/x/proj")}${A}$ ${B}`);
    await settle();
    p.write(`${CWD("/Users/x/proj")}${A}$ ${B}`);
    await settle();
    expect(p.element.querySelector(".terminal-chip--branch")?.textContent).toBe("main");
  });

  // The chip read is what tells main where the shell is: main's own record
  // is the directory the shell was *started* in, written at open() and
  // never again, so a chip read that did not carry the prompt's own path
  // would describe the project root's repository after any `cd` — the same
  // OSC 7 value that re-roots the file sidebar, so the two would disagree
  // on screen.
  it("reads chips for the directory the prompt reported, not the one before it", async () => {
    const chips = vi.fn(async (path: string) => ({
      cwd: path,
      branch: "main",
      detached: false,
      insertions: 0,
      deletions: 0,
      runtime: undefined,
    }));
    const p = pane(undefined, { chips });

    p.write(`${CWD("/Users/x/proj")}${A}$ ${B}`);
    await settle();
    expect(chips).toHaveBeenLastCalledWith("/Users/x/proj");

    p.write(`${CWD("/Users/x/proj/packages/desktop")}${A}$ ${B}`);
    await settle();
    expect(chips).toHaveBeenLastCalledWith("/Users/x/proj/packages/desktop");
    expect(p.element.querySelector(".terminal-chip--path")?.textContent).toBe(
      "~/proj/packages/desktop",
    );
  });

  // One read is four `git` subprocesses in main. `cwd` fires on every
  // prompt — a held Enter, a pasted 200-line script — and starting a read
  // per prompt is hundreds of concurrent `git status` runs against a large
  // repository, times the panes in a split. At most one read is out at a
  // time; a burst collapses to that read plus one more for the last prompt.
  it("keeps one chip read in flight however many prompts arrive", async () => {
    type Chips = import("../src/ipc.js").TerminalChips | undefined;
    const pending: { path: string; resolve: (value: Chips) => void }[] = [];
    const chips = vi.fn(
      (path: string) =>
        new Promise<Chips>((resolve) => {
          pending.push({ path, resolve });
        }),
    );
    const p = pane(undefined, { chips });

    for (let i = 0; i < 50; i += 1) p.write(`${CWD(`/Users/x/proj/d${i}`)}${A}$ ${B}`);
    await settle();

    // Fifty prompts, one read — for the first prompt, the one that started
    // it.
    expect(chips).toHaveBeenCalledTimes(1);
    expect(pending[0]?.path).toBe("/Users/x/proj/d0");

    pending[0]?.resolve({
      cwd: "/Users/x/proj/d0",
      branch: "stale",
      detached: false,
      insertions: 0,
      deletions: 0,
      runtime: undefined,
    });
    await settle();

    // ...and exactly one more when it lands, for the *last* prompt of the
    // burst: every prompt in between named a directory the shell has
    // already left.
    expect(chips).toHaveBeenCalledTimes(2);
    expect(pending[1]?.path).toBe("/Users/x/proj/d49");

    pending[1]?.resolve({
      cwd: "/Users/x/proj/d49",
      branch: "current",
      detached: false,
      insertions: 0,
      deletions: 0,
      runtime: undefined,
    });
    await settle();

    // The last state wins, and the queue is empty — no third read.
    expect(chips).toHaveBeenCalledTimes(2);
    expect(p.element.querySelector(".terminal-chip--branch")?.textContent).toBe("current");
  });

  // A read that rejects must still release the guard, or one failed `git`
  // call would freeze the row for the life of the pane.
  it("goes on reading after a read rejects mid-burst", async () => {
    const chips = vi
      .fn()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValue({
        cwd: "/Users/x/proj",
        branch: "main",
        detached: false,
        insertions: 0,
        deletions: 0,
        runtime: undefined,
      });
    const p = pane(undefined, { chips });

    p.write(`${CWD("/Users/x/proj")}${A}$ ${B}`);
    p.write(`${CWD("/Users/x/proj")}${A}$ ${B}`);
    await settle();
    await settle();

    expect(chips).toHaveBeenCalledTimes(2);
    expect(p.element.querySelector(".terminal-chip--branch")?.textContent).toBe("main");
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
    scrollback: 0,
  };

  function editorPane(
    settings: {
      scrollback: number;
      blocks: boolean;
      inputEditor: boolean;
      notifyAfterSeconds: number;
      home: string;
    } = EDITOR_SETTINGS,
    history: () => Promise<string[]> = async () => [],
    workflows?: () => Promise<Workflow[]>,
    terminalAi?: (kind: "generate" | "explain", text: string) => Promise<string>,
  ) {
    const host = document.createElement("div");
    document.body.append(host);
    const sendInput = vi.fn();
    const p = createPane(host, {
      sendInput,
      resize: vi.fn(),
      attach: async () => "",
      settings,
      notify: vi.fn(),
      history,
      workflows,
      terminalAi,
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

  // The prompt, once. The editor draws the prompt it read out of the live
  // terminal's own buffer, so with both on screen the user saw it twice with
  // a tall empty terminal between them. The stylesheet hides the live
  // terminal off this attribute — and only where the editor really is the
  // prompt line, which is why it tracks the editor's own visibility rather
  // than the pane's state.
  it("says the editor is the prompt line only while it is actually showing", () => {
    const { p } = editorPane();
    // Blocks, but no integration proved yet: no editor, so the live terminal
    // is still the only prompt there is.
    expect(p.element.dataset["state"]).toBe("blocks");
    expect(p.element.dataset["editor"]).toBe("off");

    p.write(`${A}$ ${B}`);
    expect(p.element.dataset["editor"]).toBe("on");

    p.write(`ls\r\n${C("ls")}`);
    expect(p.element.dataset["state"]).toBe("running");
    expect(p.element.dataset["editor"]).toBe("off");
  });

  it("never claims the editor is the prompt line with no editor at all", () => {
    const { p } = editorPane({ ...EDITOR_SETTINGS, inputEditor: false });
    p.write(`${A}$ ${B}`);
    expect(p.element.dataset["editor"]).toBe("off");
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

  // One Enter, one command. zsh's line editor binds ^J to accept-line just
  // as it binds ^M, so a Shift+Enter entry of two lines — or text pasted
  // into the editor and submitted — sent raw ran every line as its own
  // command and produced a block per line. Bracketed paste is what makes
  // zsh take the newlines as text: the wrapped body is inserted, and the
  // one trailing carriage return after it is the only Enter.
  it("wraps a multi-line submission in bracketed paste so the shell runs it once", () => {
    const { p, sendInput } = editorPane();
    p.write(`${A}$ ${B}`);
    const field = textarea(p);
    if (field === null) throw new Error("no editor");
    field.value = "echo one\necho two";
    press(p, { key: "Enter" });

    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith("\u001b[200~echo one\necho two\u001b[201~\r");
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
        notify: vi.fn(),
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

    /** A key the way the browser delivers it while the palette is open: on
     *  the palette's own <input>, which holds the DOM focus from the moment
     *  it is shown. */
    function pressInPalette(p: { element: HTMLElement }, init: KeyboardEventInit): KeyboardEvent {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      paletteEl(p)?.querySelector("input")?.dispatchEvent(event);
      return event;
    }

    // Two halves of one contract, and the fix is the second.
    //
    // *Opening* on ⌘P is not this listener's job once the editor is hidden:
    // terminal-addons.ts's attachKeys claims that chord unconditionally, via
    // the `openPalette` hook exercised directly below.
    //
    // *Operating* the palette, though, is this listener's job in every pane
    // state, because it is the only listener that can be: the palette's own
    // <input> takes the DOM focus, so xterm's custom key handler never sees
    // the keystroke either. Gated behind the editor, as it was, ⌘P opened a
    // palette in which Escape, Enter and ↑/↓ all did nothing and every other
    // key — ^C included — went into the filter box instead of the pty, with
    // the pointer the only way out.
    it("leaves Cmd+P to xterm's handler with the editor hidden, but owns the keys once the palette is open", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}`);

      const opening = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "p",
        metaKey: true,
      });
      p.element.dispatchEvent(opening);
      expect(paletteEl(p)?.hidden).toBe(true);
      expect(opening.defaultPrevented).toBe(false);

      // What attachKeys does with that same chord.
      p.openPalette();
      expect(paletteEl(p)?.hidden).toBe(false);

      // ↑/↓ move the selection rather than falling through to nothing.
      const down = pressInPalette(p, { key: "ArrowDown" });
      expect(down.defaultPrevented).toBe(true);
    });

    // The state the bug was worst in: a command running, so the editor is
    // hidden, so the old listener returned before the palette ever saw the
    // key. Escape left the overlay on screen for good.
    it("closes on Escape while a command is running", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}`);
      p.openPalette();
      expect(paletteEl(p)?.hidden).toBe(false);

      const escape = pressInPalette(p, { key: "Escape" });

      expect(paletteEl(p)?.hidden).toBe(true);
      expect(escape.defaultPrevented).toBe(true);
    });

    // And the keys come back to the pty with it. The palette's <input> held
    // the focus while it was open; dismissing it must hand the focus back,
    // or the next keystroke lands on a hidden field and ^C never reaches
    // the command the user is trying to interrupt.
    it("gives the keys back to the terminal after it is dismissed", () => {
      const { p, sendInput } = editorPane();
      p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}`);
      const focusedBefore = FakeTerminal.instances[0]?.focused ?? 0;

      p.openPalette();
      pressInPalette(p, { key: "Escape" });

      expect(FakeTerminal.instances[0]?.focused).toBeGreaterThan(focusedBefore);
      FakeTerminal.instances[0]?.emitData("\u0003");
      expect(sendInput).toHaveBeenCalledWith("\u0003");
    });

    // Escape is not the only way out: an action chosen with Enter closes
    // the palette too, and the focus follows on that path as well.
    it("gives the keys back after an action is chosen with Enter", () => {
      const { p } = editorPane();
      p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}`);
      const focusedBefore = FakeTerminal.instances[0]?.focused ?? 0;
      p.openPalette();

      const input = paletteEl(p)?.querySelector("input");
      if (input === null || input === undefined) throw new Error("no palette input");
      input.value = "Clear terminal";
      input.dispatchEvent(new Event("input"));
      pressInPalette(p, { key: "Enter" });

      expect(paletteEl(p)?.hidden).toBe(true);
      expect(FakeTerminal.instances[0]?.cleared).toBe(1);
      expect(FakeTerminal.instances[0]?.focused).toBeGreaterThan(focusedBefore);
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

    describe("Run workflow…", () => {
      const workflow: Workflow = {
        name: "New branch",
        command: "git checkout -b {{branch}} && git push -u origin {{branch}}",
        description: "Start a branch",
        placeholders: ["branch"],
      };

      it("is not offered when the pane has no workflows hook wired up", () => {
        const { p } = editorPane();
        p.write(`${A}$ ${B}`);

        press(p, { key: "p", metaKey: true });

        expect(paletteEl(p)?.textContent).not.toContain("Run workflow");
      });

      it("prompts for each placeholder in order and fills the editor, never sending it", async () => {
        const { p, sendInput } = editorPane(EDITOR_SETTINGS, async () => [], async () => [workflow]);
        p.write(`${A}$ ${B}`);
        await new Promise((resolve) => setTimeout(resolve, 0));

        press(p, { key: "p", metaKey: true });
        const actionsInput = paletteEl(p)?.querySelector("input");
        if (actionsInput === null || actionsInput === undefined) throw new Error("no palette input");
        actionsInput.value = "Run workflow";
        actionsInput.dispatchEvent(new Event("input"));
        actionsInput.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        // The workflow-name prompt.
        expect(paletteEl(p)?.textContent).toContain("New branch");
        paletteEl(p)
          ?.querySelector("input")
          ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // The placeholder prompt — free text, filled in and submitted.
        const branchInput = paletteEl(p)?.querySelector("input");
        if (branchInput === null || branchInput === undefined) throw new Error("no placeholder input");
        branchInput.value = "feature/login";
        branchInput.dispatchEvent(new Event("input"));
        branchInput.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(textarea(p)?.value).toBe(
          "git checkout -b feature/login && git push -u origin feature/login",
        );
        expect(sendInput).not.toHaveBeenCalled();
        expect(paletteEl(p)?.hidden).toBe(true);
      });

      it("abandons the whole thing without filling the editor when Escape is pressed on a placeholder prompt", async () => {
        const { p } = editorPane(EDITOR_SETTINGS, async () => [], async () => [workflow]);
        p.write(`${A}$ ${B}`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const field = textarea(p);
        if (field === null) throw new Error("no editor");
        field.value = "half-typed";

        press(p, { key: "p", metaKey: true });
        const actionsInput = paletteEl(p)?.querySelector("input");
        if (actionsInput === null || actionsInput === undefined) throw new Error("no palette input");
        actionsInput.value = "Run workflow";
        actionsInput.dispatchEvent(new Event("input"));
        actionsInput.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        paletteEl(p)
          ?.querySelector("input")
          ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        paletteEl(p)
          ?.querySelector("input")
          ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(field.value).toBe("half-typed");
      });

      // terminal-pane.ts restates workflows.ts's fillWorkflow rather than
      // importing it (see the no-value-imports guard) — these two exercise
      // the restated copy against the same two behaviours
      // workflows.test.ts's fillWorkflow suite covers on the original:
      // "substitutes both spaced and unspaced forms of the same
      // placeholder" and "leaves an unsupplied placeholder in place rather
      // than becoming 'undefined'". Keep both suites in sync.
      it("substitutes the spaced {{ name }} form, same as workflows.ts's fillWorkflow", async () => {
        const spaced: Workflow = {
          name: "Rebase",
          command: "git rebase {{ branch }} && echo done",
          description: "Rebase onto a branch",
          placeholders: ["branch"],
        };
        const { p } = editorPane(EDITOR_SETTINGS, async () => [], async () => [spaced]);
        p.write(`${A}$ ${B}`);
        await new Promise((resolve) => setTimeout(resolve, 0));

        press(p, { key: "p", metaKey: true });
        const actionsInput = paletteEl(p)?.querySelector("input");
        if (actionsInput === null || actionsInput === undefined) throw new Error("no palette input");
        actionsInput.value = "Run workflow";
        actionsInput.dispatchEvent(new Event("input"));
        actionsInput.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        paletteEl(p)
          ?.querySelector("input")
          ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const branchInput = paletteEl(p)?.querySelector("input");
        if (branchInput === null || branchInput === undefined) throw new Error("no placeholder input");
        branchInput.value = "main";
        branchInput.dispatchEvent(new Event("input"));
        branchInput.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(textarea(p)?.value).toBe("git rebase main && echo done");
      });

      it("leaves an unsupplied placeholder in place rather than becoming 'undefined', same as workflows.ts's fillWorkflow", async () => {
        // Hand-authored so `command` names a placeholder `placeholders`
        // does not — the only way to reach an unsupplied one through the
        // real flow, since every listed placeholder is always asked for.
        const partial: Workflow = {
          name: "Deploy",
          command: "deploy {{branch}} --tag {{tag}}",
          description: "Deploy",
          placeholders: ["branch"],
        };
        const { p } = editorPane(EDITOR_SETTINGS, async () => [], async () => [partial]);
        p.write(`${A}$ ${B}`);
        await new Promise((resolve) => setTimeout(resolve, 0));

        press(p, { key: "p", metaKey: true });
        const actionsInput = paletteEl(p)?.querySelector("input");
        if (actionsInput === null || actionsInput === undefined) throw new Error("no palette input");
        actionsInput.value = "Run workflow";
        actionsInput.dispatchEvent(new Event("input"));
        actionsInput.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        paletteEl(p)
          ?.querySelector("input")
          ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const branchInput = paletteEl(p)?.querySelector("input");
        if (branchInput === null || branchInput === undefined) throw new Error("no placeholder input");
        branchInput.value = "main";
        branchInput.dispatchEvent(new Event("input"));
        branchInput.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(textarea(p)?.value).toBe("deploy main --tag {{tag}}");
      });

      // Escaping the *first* placeholder of one is a weaker claim than
      // escaping the second of three: it never proves an already-answered
      // value was discarded rather than merely never collected.
      it("abandons the whole thing on Escape at the second of three placeholders, leaking no partial values", async () => {
        const threePlaceholders: Workflow = {
          name: "Multi",
          command: "cmd {{a}} {{b}} {{c}}",
          description: "Multi",
          placeholders: ["a", "b", "c"],
        };
        const { p, sendInput } = editorPane(EDITOR_SETTINGS, async () => [], async () => [threePlaceholders]);
        p.write(`${A}$ ${B}`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const field = textarea(p);
        if (field === null) throw new Error("no editor");
        field.value = "half-typed";

        press(p, { key: "p", metaKey: true });
        const actionsInput = paletteEl(p)?.querySelector("input");
        if (actionsInput === null || actionsInput === undefined) throw new Error("no palette input");
        actionsInput.value = "Run workflow";
        actionsInput.dispatchEvent(new Event("input"));
        actionsInput.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Choose "Multi".
        paletteEl(p)
          ?.querySelector("input")
          ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Answer the first placeholder, "a".
        const aInput = paletteEl(p)?.querySelector("input");
        if (aInput === null || aInput === undefined) throw new Error("no placeholder input");
        aInput.value = "1";
        aInput.dispatchEvent(new Event("input"));
        aInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Escape on the second, "b".
        paletteEl(p)
          ?.querySelector("input")
          ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(field.value).toBe("half-typed");
        expect(sendInput).not.toHaveBeenCalled();
        expect(paletteEl(p)?.hidden).toBe(true);
      });
    });

    describe("the two AI actions", () => {
      it("is not offered when the pane has no terminalAi hook wired up", () => {
        const { p } = editorPane();
        p.write(`${A}$ ${B}`);

        press(p, { key: "p", metaKey: true });

        expect(paletteEl(p)?.textContent).not.toContain("Generate command");
      });

      it("Generate command… asks free text, fills the editor with the reply, and never sends it", async () => {
        const calls: [string, string][] = [];
        const { p, sendInput } = editorPane(EDITOR_SETTINGS, async () => [], undefined, async (kind, text) => {
          calls.push([kind, text]);
          return "git status";
        });
        p.write(`${A}$ ${B}`);
        await new Promise((resolve) => setTimeout(resolve, 0));

        press(p, { key: "p", metaKey: true });
        const actionsInput = paletteEl(p)?.querySelector("input");
        if (actionsInput === null || actionsInput === undefined) throw new Error("no palette input");
        actionsInput.value = "Generate command";
        actionsInput.dispatchEvent(new Event("input"));
        actionsInput.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        // The free-text prompt.
        const askInput = paletteEl(p)?.querySelector("input");
        if (askInput === null || askInput === undefined) throw new Error("no free-text input");
        askInput.value = "show me the current branch status";
        askInput.dispatchEvent(new Event("input"));
        askInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calls).toEqual([["generate", "show me the current branch status"]]);
        expect(textarea(p)?.value).toBe("git status");
        expect(sendInput).not.toHaveBeenCalled();
      });

      it("leaves the editor untouched when Generate command… is answered with Escape", async () => {
        const ai = vi.fn(async () => "should not be called");
        const { p } = editorPane(EDITOR_SETTINGS, async () => [], undefined, ai);
        p.write(`${A}$ ${B}`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const field = textarea(p);
        if (field === null) throw new Error("no editor");
        field.value = "half-typed";

        press(p, { key: "p", metaKey: true });
        const actionsInput = paletteEl(p)?.querySelector("input");
        if (actionsInput === null || actionsInput === undefined) throw new Error("no palette input");
        actionsInput.value = "Generate command";
        actionsInput.dispatchEvent(new Event("input"));
        actionsInput.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        paletteEl(p)
          ?.querySelector("input")
          ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(field.value).toBe("half-typed");
        expect(ai).not.toHaveBeenCalled();
      });

      it("offers Explain this failure only for a selected block with a non-zero exit code", () => {
        const { p } = editorPane(EDITOR_SETTINGS, async () => [], undefined, async () => "explanation");
        p.write(`${A}$ ${B}ok\r\n${C("ok")}${D(0)}${A}$ ${B}bad\r\n${C("bad")}${D(1)}${A}$ ${B}`);

        p.blockNav?.move(1); // selects the first block, "ok" (exit 0)
        press(p, { key: "p", metaKey: true });
        expect(paletteEl(p)?.textContent).not.toContain("Explain this failure");
        press(p, { key: "Escape" });

        p.blockNav?.move(1); // "bad" (exit 1)
        press(p, { key: "p", metaKey: true });
        expect(paletteEl(p)?.textContent).toContain("Explain this failure");
      });

      it("Explain this failure sends the command, exit code and output, and renders the reply into the block", async () => {
        const calls: [string, string][] = [];
        const { p } = editorPane(EDITOR_SETTINGS, async () => [], undefined, async (kind, text) => {
          calls.push([kind, text]);
          return "npm test failed because a dependency is missing.";
        });
        p.write(`${A}$ ${B}npm test\r\n${C("npm test")}some output${D(1)}${A}$ ${B}`);
        p.blockNav?.move(1);

        press(p, { key: "p", metaKey: true });
        const actionsInput = paletteEl(p)?.querySelector("input");
        if (actionsInput === null || actionsInput === undefined) throw new Error("no palette input");
        actionsInput.value = "Explain this failure";
        actionsInput.dispatchEvent(new Event("input"));
        actionsInput.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calls).toHaveLength(1);
        expect(calls[0]?.[0]).toBe("explain");
        const payload = JSON.parse(calls[0]?.[1] ?? "{}") as { command: string; exitCode: number; output: string };
        expect(payload).toEqual({ command: "npm test", exitCode: 1, output: "some output" });

        const explanation = p.element.querySelector(".block-explanation");
        expect(explanation?.textContent).toBe("npm test failed because a dependency is missing.");
      });

      // Capped before this ever crosses IPC — a megabyte of build output
      // must not leave this process only to be trimmed on the far side.
      // Asserted on what the fake terminalAi hook actually received, not
      // on anything main.ts builds from it.
      it("sends no more than 4000 characters of output for a block whose output is far larger", async () => {
        const calls: [string, string][] = [];
        const bigOutput = `head-${"x".repeat(6000)}-tail`;
        const { p } = editorPane(EDITOR_SETTINGS, async () => [], undefined, async (kind, text) => {
          calls.push([kind, text]);
          return "explained";
        });
        p.write(`${A}$ ${B}build\r\n${C("build")}${bigOutput}${D(1)}${A}$ ${B}`);
        p.blockNav?.move(1);

        press(p, { key: "p", metaKey: true });
        const actionsInput = paletteEl(p)?.querySelector("input");
        if (actionsInput === null || actionsInput === undefined) throw new Error("no palette input");
        actionsInput.value = "Explain this failure";
        actionsInput.dispatchEvent(new Event("input"));
        actionsInput.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        const payload = JSON.parse(calls[0]?.[1] ?? "{}") as { output: string };
        expect(payload.output.length).toBeLessThanOrEqual(4000);
        expect(payload.output).toBe(bigOutput.slice(-4000));
        expect(payload.output).not.toContain("head-");
      });
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
        notify: vi.fn(),
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

// Task 14: a finished block's own duration (endedAt - startedAt, in
// seconds) compared against settings.notifyAfterSeconds — and, when it
// crosses that line, whether this pane is the one being watched. The
// pane never touches `Notification` itself; it only calls the injected
// `notify` hook, which is what makes every one of these cases assertable
// without a real notification ever firing.
describe("notifications", () => {
  function notifyPane(notifyAfterSeconds: number) {
    const host = document.createElement("div");
    document.body.append(host);
    const notify = vi.fn();
    const p = createPane(host, {
      sendInput: vi.fn(),
      resize: vi.fn(),
      attach: async () => "",
      settings: { blocks: true, inputEditor: false, notifyAfterSeconds, home: "/Users/x", scrollback: 0 },
      notify,
    });
    return { p, notify };
  }

  // jsdom's document.hasFocus() starts out false, and a pane's element is
  // never focused unless a test focuses it — so an untouched pane is
  // already "not watched" without any extra setup, and focusing its own
  // element is what makes it the watched one.
  function focus(p: ReturnType<typeof notifyPane>["p"]): void {
    p.element.tabIndex = -1;
    p.element.focus();
  }

  /** Runs one command whose block spans exactly `seconds` seconds. */
  function runCommand(p: ReturnType<typeof notifyPane>["p"], seconds: number, exitCode = 0): void {
    const start = 1_700_000_000_000;
    const dateSpy = vi.spyOn(Date, "now");
    dateSpy.mockReturnValueOnce(start);
    p.write(`${A}$ ${B}${C("ls -la")}`);
    dateSpy.mockReturnValue(start + seconds * 1000);
    p.write(`a b\r\n${D(exitCode)}`);
    dateSpy.mockRestore();
  }

  it("notifies with the command and its status when a slow block finishes unwatched", () => {
    const { p, notify } = notifyPane(30);

    runCommand(p, 45);

    expect(notify).toHaveBeenCalledTimes(1);
    const [, body] = notify.mock.calls[0] as [string, string];
    expect(body).toContain("ls -la");
    expect(body.toLowerCase()).toMatch(/succeed|finish|done|complet/);
  });

  it("does not notify a fast block", () => {
    const { p, notify } = notifyPane(30);

    runCommand(p, 5);

    expect(notify).not.toHaveBeenCalled();
  });

  it("does not notify a slow block in a focused pane", () => {
    const { p, notify } = notifyPane(30);
    focus(p);

    runCommand(p, 45);

    expect(notify).not.toHaveBeenCalled();
  });

  it("never notifies when notifyAfterSeconds is 0, however slow the block or unwatched the pane", () => {
    const { p, notify } = notifyPane(0);

    runCommand(p, 10_000);

    expect(notify).not.toHaveBeenCalled();
  });
});

// The tab's file sidebar has no chord of its own, so the palette is the
// only way out of it: a panel that cannot be dismissed is not a panel.
describe("the file sidebar's palette action", () => {
  function paneWithSidebar(toggleExplorer?: () => void, refreshExplorer?: () => void) {
    const host = document.createElement("div");
    document.body.append(host);
    const p = createPane(host, {
      sendInput: vi.fn(),
      resize: vi.fn(),
      attach: async () => "",
      settings: { blocks: true, inputEditor: true, notifyAfterSeconds: 0, home: "/Users/x", scrollback: 0 },
      notify: vi.fn(),
      toggleExplorer,
      refreshExplorer,
    });
    return p;
  }

  const palette = (p: { element: HTMLElement }) =>
    p.element.querySelector<HTMLElement>(".terminal-palette");

  function run(p: { element: HTMLElement }, label: string): void {
    const input = palette(p)?.querySelector("input");
    if (input === null || input === undefined) throw new Error("no palette input");
    input.value = label;
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
  }

  it("offers the sidebar toggle and runs it", () => {
    const toggleExplorer = vi.fn();
    const p = paneWithSidebar(toggleExplorer);
    p.write(`${A}$ ${B}`);

    p.openPalette();
    expect(palette(p)?.textContent).toContain("Toggle file sidebar");
    run(p, "Toggle file sidebar");

    expect(toggleExplorer).toHaveBeenCalledTimes(1);
  });

  // Nothing watches the filesystem, and the sidebar does not re-list a
  // root that has not changed — so a file a command just created, or a
  // `git checkout` of a branch with different files, leaves the tree
  // lying until this action is run.
  it("offers the sidebar refresh and runs it", () => {
    const refreshExplorer = vi.fn();
    const p = paneWithSidebar(vi.fn(), refreshExplorer);
    p.write(`${A}$ ${B}`);

    p.openPalette();
    expect(palette(p)?.textContent).toContain("Refresh file sidebar");
    run(p, "Refresh file sidebar");

    expect(refreshExplorer).toHaveBeenCalledTimes(1);
  });

  // The same rule every other optional action follows: absent hook, absent
  // action — never an entry that does nothing.
  it("offers nothing when the pane has no sidebar", () => {
    const p = paneWithSidebar();
    p.write(`${A}$ ${B}`);

    p.openPalette();

    expect(palette(p)?.textContent).not.toContain("Toggle file sidebar");
    expect(palette(p)?.textContent).not.toContain("Refresh file sidebar");
  });
});
