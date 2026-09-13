// One terminal, as the user sees it: a list of finished blocks with a live
// terminal underneath.
//
// The pane has four states, and `element.dataset.state` names the one it is
// in so the stylesheet can lay it out without this file measuring anything:
//
//   "blocks"  a prompt is waiting; blocks above, live terminal at the cursor
//   "running" a command is in flight; its bytes draw live and accumulate
//   "alt"     a program holds the alternate screen; the terminal takes all
//   "plain"   no integration, or blocks switched off: today's terminal
//
// The invariant this file exists to keep: every byte of the pty stream
// reaches the live terminal, in order, whether blocks are on or off. The
// splitter guarantees that every non-mark byte comes back as an "output"
// event; write() does nothing with those but hand them straight to xterm.
// Everything else here — freezing a block, the state attribute, the scroll —
// is an enhancement, so every part of it is guarded: a pane whose block
// machinery fails is still a working terminal.

import type { Workflow } from "@jarvis/platform";
import type { TerminalChips } from "../src/ipc.js";
import { createBlockNav, type BlockNav } from "./block-nav.js";
import { createBlockView, type BlockView } from "./block-view.js";
import { handlePaletteKey, type PaletteKeys, type SplitKeys } from "./terminal-addons.js";
import { createSplitter, type BlockEvent, type BlockRecord } from "./terminal-blocks.js";
import { createChipRow } from "./terminal-chips.js";
import { createEditor, type TerminalEditor } from "./terminal-input.js";
import { createPalette, type Palette, type PaletteAction } from "./terminal-palette.js";
import { SCROLLBACK_LINES, TERMINAL_FONT, TERMINAL_THEME } from "./terminal-theme.js";
import { FitAddon } from "./vendor/addon-fit.mjs";
import { Terminal } from "./vendor/xterm.mjs";

export type PaneHooks = {
  sendInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  /**
   * Whether the pty repaints its whole screen on every resize — ConPTY does,
   * a POSIX pty does not. Supplied by the caller (which knows the platform);
   * absent means it does not, which is every platform but Windows.
   */
  ptyRepaintsOnResize?: boolean | undefined;
  attach: () => Promise<string>;
  /** The full renderer-facing settings payload — see window.jarvis.terminalSettings()
   *  in src/ipc.ts, which is where `home` comes from. */
  settings: {
    blocks: boolean;
    inputEditor: boolean;
    notifyAfterSeconds: number;
    home: string;
    /** Lines of scrollback, from `performance.terminalScrollback`. Anything
     *  that is not a positive number leaves the pane on SCROLLBACK_LINES —
     *  this arrives over IPC, so it is not the type checker's to promise,
     *  and 0 is what the renderer holds before the answer comes back. */
    scrollback: number;
  };
  /** Tells the outside world a block finished — the pane never calls
   *  `Notification` itself, since that is what makes the decision (and the
   *  guard around a constructor that can throw) testable at all. Called
   *  only for a block whose own duration meets `settings.notifyAfterSeconds`
   *  while this pane was not the one being watched. */
  notify: (title: string, body: string) => void;
  /** The most recent commands from Jarvis's own command log, newest first —
   *  what ↑/↓ in the command editor walk. Absent (or failing) means the
   *  arrows find nothing, which is a line that simply does not change. */
  history?: (() => Promise<string[]>) | undefined;
  /** This project's saved workflows, for ⌘P's "Run workflow…". Absent
   *  means the action is left out of the palette entirely, the same rule
   *  `splitKeys` follows for split right/split down/close pane. */
  workflows?: (() => Promise<Workflow[]>) | undefined;
  /** Consulted before the editor acts on a key, while the editor is
   *  visible — the same contract as `TerminalHooks.interceptKey` in
   *  terminal-addons.ts, and for the same reason: terminal-completion.ts's
   *  dropdown claims Tab/↑/↓/Enter/Escape for as long as it is open.
   *  xterm's own custom key handler cannot do this job here — it only ever
   *  sees a keydown that lands on its own textarea, and while the editor
   *  is visible the event targets the editor's own instead. Returning
   *  false means the key was claimed. Absent for a terminal with no
   *  autocomplete wired up, which is exactly why every keystroke below
   *  reaches the editor unless this says otherwise — never affecting
   *  the pane's behaviour when it is not passed. */
  interceptKey?: ((event: KeyboardEvent) => boolean) | undefined;
  /** What the palette's split right / split down / close pane act on — the
   *  tab's own tree, shared across every pane split off it. Absent for a
   *  terminal with no splits at all (the Session route), which is exactly
   *  why the palette's action list leaves those three out when it is
   *  missing rather than offering an action that does nothing. */
  splitKeys?: SplitKeys | undefined;
  /** Hides the completion dropdown — called right before the palette
   *  opens, so a suggestion list left showing from mid-typing does not sit
   *  stale underneath it. Absent for a terminal with no completion wired
   *  up, in which case there is nothing to close. */
  closeCompletion?: (() => void) | undefined;
  /**
   * The two AI actions' only route out of this pane — window.jarvis.terminalAi,
   * one call per action, never called anywhere else in this file. Absent
   * (no brain configured at all, the main-process side of the "absent
   * means no AI actions" rule) leaves both actions out of the palette
   * entirely, the same way `workflows` being absent leaves out "Run
   * workflow…".
   */
  terminalAi?: ((kind: "generate" | "explain", text: string) => Promise<string>) | undefined;
  /** The shell's working directory, as of the prompt about to be drawn —
   *  called every time the splitter sees a fresh OSC 7, which is what lets
   *  a file sidebar follow a `cd` the moment it finishes rather than when
   *  the next command starts. Absent means nothing follows it. */
  onCwd?: ((path: string) => void) | undefined;
  /** The chip row's data for this pane, read fresh on every `cwd` event —
   *  the same trigger `onCwd` fires on, since a prompt returning is exactly
   *  when the directory, the branch and the dirty counts can all have
   *  changed. Called with the pane's live OSC 7 directory — the very path
   *  `onCwd` just carried — because main knows only where the shell was
   *  started, and a chip describing that after a `cd` is wrong rather than
   *  absent. Absent means no chip row is ever populated (it stays empty);
   *  a read that rejects leaves the row showing whatever it already had —
   *  a slow or broken repository must never block the input. At most one
   *  call is ever outstanding per pane; see `refreshChips`. */
  chips?: ((path: string) => Promise<TerminalChips | undefined>) | undefined;
  /** Shows or hides the tab's file sidebar. Offered as a palette action
   *  and nowhere else — the sidebar has no chord of its own, and this is
   *  what keeps it dismissable. Absent means the tab has no sidebar, and
   *  the action is left out entirely rather than doing nothing. */
  toggleExplorer?: (() => void) | undefined;
  /** Re-lists the tab's file sidebar where it stands. Offered as a palette
   *  action, the same way `toggleExplorer` is, and absent the same way for
   *  a tab with no sidebar. Nothing watches the filesystem, so this is the
   *  only way to see a file a command just created or removed without
   *  leaving the directory and coming back. */
  refreshExplorer?: (() => void) | undefined;
};

export type { BlockView };

export type TerminalPane = {
  element: HTMLElement;
  /** Feed it a chunk from the pty. */
  write(chunk: string): void;
  focus(): void;
  refit(): void;
  /** Drops every frozen block — the elements, not merely their visibility —
   *  along with any selection and any filter over them, and leaves the live
   *  terminal exactly as it is (its own `reset()` is a separate decision the
   *  caller makes beside this one).
   *
   *  For a pane that outlives what it is showing: the Session view keeps one
   *  pane and points it at whichever agent is open, so switching sessions
   *  must not leave one agent's blocks sitting under another's terminal. A
   *  Terminal tab never needs this — its pane and its shell begin and end
   *  together. */
  reset(): void;
  dispose(): void;
  /** The frozen blocks, oldest first — what Tasks 6, 7 and 12 act on. */
  blocks(): readonly BlockView[];
  /** Selection, jumping and filtering over `blocks()`. Undefined for a pane
   *  with blocks switched off (`settings.blocks === false`) — there is
   *  nothing to navigate, and callers use this to leave the app's Cmd
   *  chords behaving exactly as they do today rather than claiming a key
   *  and doing nothing with it. */
  blockNav: BlockNav | undefined;
  terminal: Terminal;
  /** What terminal-completion.ts reads instead of the xterm buffer: the
   *  editor's own value while it is visible, undefined the rest of the
   *  time — no editor at all, or one hidden because a command is running.
   *  Undefined is exactly the signal the buffer scrape's fallback wants:
   *  every one of those states already has no prompt mark for completion
   *  to work from either. */
  readInput(): string | undefined;
  /** Accepts a suggestion into the editor directly — no backspaces, since
   *  the pty never held the line the buffer scrape would otherwise erase.
   *  A pane with no editor, or a hidden one, quietly does nothing: there
   *  is nowhere for the line to go. */
  applyInput(line: string): void;
  /** The editor's own element, for the dropdown to anchor its position to
   *  — undefined exactly when `readInput` and `applyInput` have nothing to
   *  work with either. */
  editorElement(): HTMLElement | undefined;
  /** Whether the shell is sitting at a prompt with nothing running.
   *
   *  Completion needs this because it cannot see it for itself here: in
   *  blocks mode the raw stream never reaches xterm (write() below feeds
   *  the splitter and writes only what it emits), and the splitter eats
   *  the "133;" marks completion's own OSC handler listens for. The
   *  splitter is what told this pane a prompt is waiting, so the pane is
   *  the one that can answer. */
  atPrompt(): boolean;
  /** Opens the command palette over this pane's actions — what ⌘P calls,
   *  from terminal-addons.ts's own key handler, in every pane state:
   *  "blocks", "running", "alt" and "plain" alike. Never gated on the
   *  editor or on `idle()` the way `^R` is — see terminal-addons.ts's
   *  `openPalette` hook for why the two chords differ. */
  openPalette(): void;
};

/** Blocks a pane keeps, oldest dropped first. A session that ran thousands
 *  of commands must not grow a DOM node per command forever. */
const MAX_BLOCKS = 500;

/** A failing build's output is not a prompt: capped here, before it ever
 *  crosses IPC, so a megabyte of build log never leaves this process in
 *  the first place — ipc.ts caps again on the far side, but that is the
 *  boundary that must hold regardless of what this process sends, not a
 *  reason to send more than the brain will ever be asked about. */
const EXPLAIN_OUTPUT_CAP = 4000;

/** Runs a piece of the block machinery, swallowing anything it throws. The
 *  same discipline terminal-addons.ts follows, and for the same reason:
 *  nothing here is worth taking a terminal down for. */
function attempt(work: () => void): void {
  try {
    work();
  } catch {
    // The terminal is untouched.
  }
}

/**
 * The C0 control byte a Ctrl chord stands for, or undefined when it stands
 * for nothing.
 *
 * A chord over `@`–`_` — every letter, once upper-cased — is the byte the
 * terminal has always sent for it: ^C is \u0003, ^D is \u0004, and losing
 * those two would make the terminal feel broken. That is the whole of it.
 *
 * Everything else returns undefined, and the caller then sends nothing and
 * prevents nothing. This is deliberate and load-bearing: falling back to the
 * key's own character would put a raw `1` into zsh's line buffer for Ctrl+1
 * while the editor went on showing the line the user can see, so the next
 * Enter would run a command neither of them displayed. A chord Jarvis has no
 * byte for is a chord that does nothing, which is the only answer that
 * cannot make the DOM line and the shell's line disagree.
 */
export function controlByte(event: KeyboardEvent): string | undefined {
  if (!event.ctrlKey || event.key.length !== 1) return undefined;
  const code = event.key.toUpperCase().charCodeAt(0);
  if (code < 64 || code > 95) return undefined;
  return String.fromCharCode(code - 64);
}

/**
 * The bytes that run one submitted line.
 *
 * A single line is itself and a carriage return, exactly as it always was.
 * A *multi-line* line is wrapped in bracketed paste first, because zsh's
 * line editor binds `^J` to accept-line just as it binds `^M`: sent raw,
 * every newline in a Shift+Enter entry (or in text pasted into the editor)
 * is a second Enter, and the user who pressed Enter once watches several
 * commands run, each becoming its own block. Inside the paste brackets zsh
 * takes the newlines as text and the one trailing `\r` as the only Enter —
 * which is what "typed it and pressed Enter" is supposed to mean.
 */
export function submitBytes(line: string): string {
  if (!line.includes("\n")) return `${line}\r`;
  return `\u001b[200~${line}\u001b[201~\r`;
}

export function createPane(host: HTMLElement, hooks: PaneHooks): TerminalPane {
  const element = document.createElement("div");
  element.className = "terminal-pane";
  element.dataset["state"] = hooks.settings.blocks ? "blocks" : "plain";
  // Nothing is standing in front of the live terminal yet — see applyState,
  // which is the only other thing that writes this.
  element.dataset["editor"] = "off";

  // The sticky header lives above the block list so position: sticky can
  // hold it at the pane's own top as blocks scroll under it; block-nav.ts
  // owns everything about what it shows.
  const sticky = document.createElement("div");
  sticky.className = "terminal-sticky-header";
  sticky.hidden = true;
  const list = document.createElement("div");
  list.className = "terminal-blocks";
  const live = document.createElement("div");
  live.className = "terminal-live";
  element.append(sticky, list, live);
  host.append(element);

  // The chip row: naming where the shell is. Mounted here, ahead of the
  // editor built further down (`buildEditor` appends its own wrapper to
  // `element` last), so DOM order alone puts it above the input — a
  // flex-column pane lays out its children in that order without this file
  // measuring anything.
  const chipRow = createChipRow(element, hooks.settings.home);

  // Selection, jumping and filtering: nothing to navigate with blocks off,
  // so `nav` stays undefined and the pane's `blockNav` — what
  // terminal-addons.ts's key handler checks — follows it.
  const nav = hooks.settings.blocks ? createBlockNav(list, sticky) : undefined;

  const terminal = new Terminal({
    scrollback:
      Number.isFinite(hooks.settings.scrollback) && hooks.settings.scrollback > 0
        ? hooks.settings.scrollback
        : SCROLLBACK_LINES,
    ...TERMINAL_FONT,
    theme: TERMINAL_THEME,
    cursorBlink: true,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(live);

  // Every keystroke verbatim, control bytes included — that is what makes
  // Ctrl-C, arrows and Escape work rather than only plain text.
  terminal.onData((data) => hooks.sendInput(data));
  // The pty's size has to track the pane's, or a full-screen program draws
  // to a width that does not exist.
  // The pty's size has to track the pane's, or a full-screen program draws to
  // a width that does not exist.
  //
  // On Windows, not while a command is running. ConPTY answers every resize
  // by repainting its entire screen buffer — every line it holds, with
  // absolute cursor positions — where a POSIX pty only signals the child. The
  // live terminal is shown the moment a command starts and its box differs
  // from the one it had, so the fit that follows resized the pty mid-command
  // and the repaint landed inside the block: every earlier command's output
  // again, under rows of blank. So a resize that arrives while a block is
  // open is held and applied when the block closes, with the shell back at
  // its prompt and the repaint falling on the hidden live terminal — which is
  // cleared before it is shown again. The program that was running saw the
  // size it started with, which is what a POSIX shell would have shown it had
  // the window been resized a moment earlier.
  const repaintsOnResize = hooks.ptyRepaintsOnResize ?? false;
  let heldResize: { cols: number; rows: number } | undefined;
  function flushHeldResize(): void {
    if (heldResize === undefined) return;
    const { cols, rows } = heldResize;
    heldResize = undefined;
    hooks.resize(cols, rows);
  }
  terminal.onResize(({ cols, rows }) => {
    if (repaintsOnResize && splitter.active() !== undefined) {
      heldResize = { cols, rows };
      return;
    }
    heldResize = undefined;
    hooks.resize(cols, rows);
  });

  const splitter = createSplitter();
  const views: BlockView[] = [];
  /** A tab can be closed while its buffered prologue is still in flight, and
   *  writing to a disposed xterm throws. */
  let disposed = false;
  /** Whether the shell has ever said "here is a prompt". Until it has, there
   *  is no integration to trust: Jarvis cannot tell a prompt from `sudo`
   *  asking for a password, so the editor never appears and every keystroke
   *  goes to the pty exactly as it does today. */
  let sawPrompt = false;
  /** The command log, newest first, and where ↑/↓ have walked to in it.
   *  -1 is the line the user is typing, which is held in `draft` while the
   *  arrows are showing something else. */
  let historyLines: readonly string[] = [];
  let historyIndex = -1;
  let draft = "";

  /**
   * The last line the live terminal drew before the cursor — the prompt,
   * since the editor is only ever shown at an idle one.
   *
   * Read out of xterm's buffer, exactly as terminal-completion.ts reads the
   * typed line, and never modelled by accumulating keystrokes. What is on
   * the screen is what the shell drew, so this cannot come to disagree with
   * what the shell believes; a model of the prompt would, the first time a
   * precmd repainted it.
   */
  function promptText(): string {
    try {
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(buffer.baseY + buffer.cursorY);
      if (line === undefined) return "";
      // Verbatim, up to the cursor: the cursor is where the prompt stops,
      // so there is no padding to trim and the trailing space a prompt
      // usually ends in is part of it.
      return line.translateToString(false, 0, buffer.cursorX);
    } catch {
      // A disposed terminal, or a row that has scrolled away: an unlabelled
      // editor beats an exception.
      return "";
    }
  }

  /** Back to the line the user is typing. Costs nothing, so it runs every
   *  time the editor appears. */
  function resetHistoryCursor(): void {
    historyIndex = -1;
    draft = "";
  }

  /** Fresh at every prompt — and only there, because it is an IPC round trip
   *  and the log cannot have changed in between: the command just run is the
   *  one most likely to be wanted back. */
  function loadHistory(): void {
    resetHistoryCursor();
    historyLines = [];
    const read = hooks.history;
    if (read === undefined || editor === undefined) return;
    attempt(() => {
      void read()
        .then((lines) => {
          if (!disposed) historyLines = lines;
        })
        .catch(() => {
          // No history. The arrows leave the line alone.
        });
    });
  }

  /** ↑ (delta < 0) walks back into the log, ↓ walks forward and off the end
   *  of it to the empty line the user started from. Undefined means "leave
   *  the line as it is" — at the oldest command, or already on that empty
   *  line. */
  function historyStep(delta: number): string | undefined {
    const next = historyIndex + (delta < 0 ? 1 : -1);
    if (next >= historyLines.length) return undefined;
    if (next < 0) {
      if (historyIndex < 0) return undefined;
      historyIndex = -1;
      // The half-typed line the arrows took away, handed back intact.
      return draft;
    }
    // Leaving the line the user was typing: keep it, or walking up and back
    // down would quietly destroy a command they had half written.
    if (historyIndex < 0) draft = editor?.value() ?? "";
    historyIndex = next;
    return historyLines[next];
  }

  /** Focus follows the editor, but only inside a pane that already holds it:
   *  a command finishing in a background tab must not steal the caret from
   *  wherever the user actually is. */
  function refocus(editorEl: TerminalEditor): void {
    if (!element.contains(document.activeElement)) return;
    if (editorEl.isVisible()) editorEl.focus();
    else terminal.focus();
  }

  const editor = hooks.settings.inputEditor ? buildEditor() : undefined;

  // The palette and the dropdown's first look at an editor keystroke. A
  // capture-phase listener on the pane's own root sees a keydown before it
  // reaches the editor's own (bubble-phase) listener in createEditor —
  // capture always runs before bubble, on every ancestor, regardless of
  // which was registered first — so this is where the palette gets to
  // claim ⌘P and `^R` (and, once open, everything it filters and navigates
  // with) before the editor's history walk, submit, ^R-as-a-passthrough-
  // byte or nothing at all acts on the same key. stopPropagation() is what
  // keeps a claimed key from also reaching that listener; both handlers
  // have already called preventDefault() on anything they claim.
  //
  // Gated on the editor actually being what is showing — the one moment
  // this is safe. Every other moment (nothing running, no editor; running;
  // the alt screen) is a moment `^R` is a real control byte a shell's own
  // reverse-i-search or a running program (vim, fzf, `less`) may still
  // want, and xterm's own custom key handler is where a keystroke in that
  // state actually lands — this listener is never consulted for it, since
  // an editor that is not visible does not have the focus a keydown would
  // need to reach it.
  const interceptKey = hooks.interceptKey;
  element.addEventListener(
    "keydown",
    (event) => {
      // The open palette first, and before the editor gate below: ⌘P is
      // claimed unconditionally (terminal-addons.ts's own key handler, in
      // every pane state), so the palette can be open with no editor
      // showing at all — a command running, the alternate screen held, or
      // blocks switched off. Its own <input> holds the DOM focus in every
      // one of those states, so xterm's custom key handler never sees the
      // keystroke either: if this listener declined here, Escape, Enter
      // and ↑/↓ would all do nothing and the overlay could only be
      // dismissed with the pointer. Opening was made state-independent;
      // this is operating it on the same terms.
      if (palette.isOpen()) {
        if (!palette.handleKey(event)) {
          event.stopPropagation();
          // The palette gave the keys back (Escape, or a chosen action):
          // so must the focus, or the next keystroke would land on a
          // hidden input and never reach the pty.
          if (!palette.isOpen()) attempt(() => focusPane());
        }
        return;
      }
      if (editor === undefined || !editor.isVisible()) return;
      if (!handlePaletteKey(event, paletteKeys)) {
        event.stopPropagation();
        return;
      }
      if (interceptKey !== undefined && !interceptKey(event)) event.stopPropagation();
    },
    true,
  );

  function buildEditor(): TerminalEditor | undefined {
    try {
      return createEditor(element, {
        // The one thing that runs a command, and only from a key the user
        // pressed: the line, then the carriage return the shell is waiting
        // for. Nothing else here writes a newline to the pty.
        submit: (line) => attempt(() => hooks.sendInput(submitBytes(line))),
        // Not ours to eat — ^C interrupts, ^D ends the shell. The byte goes
        // to the pty and the browser is told to keep its hands off the key.
        passthrough: (event) =>
          attempt(() => {
            const byte = controlByte(event);
            if (byte === undefined) return;
            event.preventDefault();
            hooks.sendInput(byte);
          }),
        history: (delta) => historyStep(delta),
      });
    } catch {
      // No editor. The terminal underneath is untouched and takes the keys.
      return undefined;
    }
  }

  /** The newest block, at the bottom. The block list is the element that
   *  scrolls (it is capped so the live terminal always keeps its share of
   *  the pane), and the pane itself is scrolled too for the layouts —
   *  "alt", "plain" — where the list is not on screen at all. */
  function scrollToBottom(): void {
    list.scrollTop = list.scrollHeight;
    element.scrollTop = element.scrollHeight;
  }

  /** The keys go to the editor whenever it is on screen, and to the live
   *  terminal every other moment. Both `focus()` and the palette's own
   *  hand-back call this, so there is one answer to "who has the keys". */
  function focusPane(): void {
    if (editor?.isVisible()) {
      editor.focus();
      return;
    }
    terminal.focus();
  }

  /** Re-measures the live terminal's cell grid. Guarded on the live
   *  element rather than the pane: the live terminal is display:none at an
   *  idle prompt (the editor is the prompt line there), and fitting a box
   *  with no layout at all makes the addon measure nonsense. */
  function refit(): void {
    if (live.clientWidth === 0 || live.clientHeight === 0) return;
    attempt(() => fit.fit());
  }

  /** Whether the shell is sitting at a prompt with nothing running: the one
   *  moment the editor may stand in front of it. A program that leaves the
   *  alternate screen part-way through its run (a script that calls vim and
   *  carries on) is still running, and its keys are still its own. */
  function idle(): boolean {
    return sawPrompt && splitter.active() === undefined;
  }

  /**
   * The state → visibility rule, in one place.
   *
   * The editor is shown in "blocks" — and only there, and only once the
   * shell's integration has proved itself — and hidden in "running", "alt"
   * and "plain". Scattering show() calls through the event handlers is how a
   * pane ends up with an editor over a running command, eating the keystroke
   * that would have interrupted it.
   */
  function applyState(state: "blocks" | "running" | "alt" | "plain"): void {
    element.dataset["state"] = state;
    const editorEl = editor;
    if (editorEl === undefined) {
      // No editor ever means no editor row: the live terminal is the prompt
      // in every state, and the stylesheet must not hide it.
      element.dataset["editor"] = "off";
      return;
    }
    attempt(() => {
      if (state === "blocks" && idle()) {
        resetHistoryCursor();
        editorEl.show(promptText());
      } else {
        editorEl.hide();
      }
      // Whether the editor is *actually* the prompt line right now. The
      // stylesheet hides the live terminal only when it is — the editor
      // draws the prompt it read out of that terminal's own buffer, so
      // showing both is showing the prompt twice with a tall empty
      // terminal between them. With the editor hidden (no integration yet,
      // a command running, the alternate screen) the live terminal is the
      // only prompt there is and must stay on screen.
      element.dataset["editor"] = editorEl.isVisible() ? "on" : "off";
      refocus(editorEl);
      // Showing or hiding the live terminal changes its box; xterm only
      // learns a new cell grid from a fit. The ResizeObserver below catches
      // this too where it exists, but a fit here is what makes the pty's
      // rows right on the tick the state actually changed.
      refit();
    });
  }

  // Re-run and copy. Filling is the whole of re-run: neither path appends a
  // return, so nothing about it can run a command on its own.
  //
  // With an editor live the command goes into it — putting it into zsh's
  // line buffer instead would leave the shell holding one line while the
  // editor showed another, the divergence this design refuses everywhere.
  // With no editor it is typed at the live prompt, exactly as it was
  // before the editor existed — but only when there *is* a live prompt to
  // type it at. "No editor" also covers a hidden one, and the editor is
  // hidden exactly while a command is running or the alt screen is held —
  // states in which whatever is reading stdin right now is `vim`, a REPL,
  // or a running program, never zsh waiting for a line. idle() is the same
  // check applyState() already uses to decide whether the editor belongs
  // on screen at all, so this is not a new rule, only this path finally
  // honouring it. Copy goes straight to the system clipboard, the same
  // call the rest of the terminal already makes for a selection.
  function fill(command: string): void {
    attempt(() => {
      if (editor?.isVisible()) {
        editor.setValue(command);
        editor.focus();
        return;
      }
      if (!idle()) return;
      hooks.sendInput(command);
    });
  }

  function copy(text: string): void {
    attempt(() => {
      void navigator.clipboard?.writeText(text);
    });
  }

  // The command palette: ⌘P over this pane, `^R` for history search. Built
  // once per pane, host = the pane's own root — the same host the find bar
  // and the completion dropdown are appended to, so it travels with the
  // pane it belongs to.
  const palette = createPalette(element);

  /** Moves the selection forward, wrapping, until it lands on a failed
   *  block — or gives up after one full pass, when nothing in what is
   *  currently visible has failed. Built on `nav.move` rather than a new
   *  BlockNav method: `move` already walks the filtered, visible list in
   *  order and wraps at both ends, which is exactly the search this
   *  needs. */
  function jumpToNextFailed(): void {
    if (nav === undefined) return;
    for (let step = 0; step < views.length; step += 1) {
      nav.move(1);
      const current = nav.selected();
      if (current === undefined) return;
      if (current.record.exitCode !== 0) return;
    }
  }

  /**
   * Everything ⌘P offers over this pane, assembled fresh on every open —
   * the selected block, the filter state and what is worth re-running can
   * all have changed since it last opened.
   *
   * Copy/re-run act on the selected block and are left out entirely when
   * there is none to act on, rather than offered as an action that does
   * nothing. Re-run is left out on top of that unless the pane is idle —
   * selection survives into "running" and "alt", and offering re-run there
   * would be offering to type the command straight into whatever program
   * is currently reading stdin (see fill()'s own guard, which this mirrors
   * rather than relies on: the action simply is not in the list, instead
   * of being present and silently doing nothing when chosen). Split
   * right/split down/close pane are left out the same way when this pane
   * has no splits to act on (`hooks.splitKeys` absent — the Session
   * route). "Generate command…" and "Explain this failure" follow the same
   * rule: left out entirely when `hooks.terminalAi` is absent (no brain
   * configured), and "Explain this failure" further requires a selected
   * block whose exit code is a real, non-zero number.
   */
  function paletteActions(): PaletteAction[] {
    const actions: PaletteAction[] = [];
    const selected = nav?.selected();
    if (selected !== undefined) {
      actions.push(
        { id: "copy-output", label: "Copy output", run: () => copy(selected.record.output) },
        { id: "copy-command", label: "Copy command", run: () => copy(selected.record.command) },
      );
      if (idle()) {
        actions.push({
          id: "rerun",
          label: "Re-run command",
          run: () => fill(selected.record.command),
        });
      }
      // Only a real failure — a defined, non-zero exit code — has a
      // command, a code and an output worth sending; an unknown exit code
      // (should not normally reach a frozen block) offers nothing rather
      // than explaining a status that was never actually observed.
      if (
        hooks.terminalAi !== undefined &&
        selected.record.exitCode !== undefined &&
        selected.record.exitCode !== 0
      ) {
        actions.push({ id: "explain-failure", label: "Explain this failure", run: explainFailure });
      }
    }
    actions.push({
      id: "collapse-all",
      label: "Collapse all blocks",
      run: () =>
        attempt(() => {
          for (const view of views) view.collapse(true);
        }),
    });
    actions.push({
      id: "clear",
      label: "Clear terminal",
      run: () => attempt(() => terminal.clear()),
    });
    const toggleExplorer = hooks.toggleExplorer;
    if (toggleExplorer !== undefined) {
      actions.push({
        id: "toggle-explorer",
        label: "Toggle file sidebar",
        run: () => attempt(() => toggleExplorer()),
      });
    }
    const refreshExplorer = hooks.refreshExplorer;
    if (refreshExplorer !== undefined) {
      actions.push({
        id: "refresh-explorer",
        label: "Refresh file sidebar",
        run: () => attempt(() => refreshExplorer()),
      });
    }
    if (hooks.workflows !== undefined && editor !== undefined) {
      actions.push({ id: "run-workflow", label: "Run workflow…", run: runWorkflow });
    }
    if (hooks.terminalAi !== undefined && editor !== undefined) {
      actions.push({ id: "generate-command", label: "Generate command…", run: generateCommand });
    }
    if (nav !== undefined) {
      const currentNav = nav;
      actions.push({ id: "jump-next-failed", label: "Jump to next failed", run: jumpToNextFailed });
      actions.push({
        id: "toggle-failed-filter",
        label: "Toggle failed-only filter",
        run: () => attempt(() => currentNav.toggleFailedFilter()),
      });
    }
    const splitKeys = hooks.splitKeys;
    if (splitKeys !== undefined) {
      actions.push({
        id: "split-right",
        label: "Split right",
        run: () => attempt(() => splitKeys.split("row")),
      });
      actions.push({
        id: "split-down",
        label: "Split down",
        run: () => attempt(() => splitKeys.split("column")),
      });
      actions.push({
        id: "close-pane",
        label: "Close pane",
        // The last pane is the tab, so closing it is closing the tab — the
        // same fallback ⌘W's handleSplitKey follows.
        run: () =>
          attempt(() => {
            if (!splitKeys.closeFocused()) splitKeys.closeTab();
          }),
      });
    }
    return actions;
  }

  /**
   * "Run workflow…"'s whole flow: ask the palette which saved workflow,
   * then ask it again for each of that workflow's placeholders in order —
   * free text, via `palette.ask([], name)` — and put the filled-in command
   * back in the editor. It fills; it never runs, the same rule
   * historySearch and re-run both follow.
   *
   * Escape at any prompt — the workflow itself, or any one placeholder —
   * abandons the whole thing: nothing is written to the editor, not even
   * the placeholders that were already answered. That is `values` never
   * escaping this function on the path where a `palette.ask` resolves
   * undefined.
   *
   * Never throws into the terminal: a workflow read that fails, or a
   * palette closed with Escape, simply leaves the editor as it was.
   */
  function runWorkflow(): void {
    const read = hooks.workflows;
    if (read === undefined || editor === undefined) return;
    const editorEl = editor;
    void (async () => {
      let workflows: Workflow[];
      try {
        workflows = await read();
      } catch {
        return;
      }
      if (workflows.length === 0) return;

      let chosenName: string | undefined;
      try {
        chosenName = await palette.ask(
          workflows.map((workflow) => workflow.name),
          "Run workflow…",
        );
      } catch {
        return;
      }
      if (chosenName === undefined) return;
      const workflow = workflows.find((candidate) => candidate.name === chosenName);
      if (workflow === undefined) return;

      const values: Record<string, string> = {};
      for (const placeholder of workflow.placeholders) {
        let value: string | undefined;
        try {
          value = await palette.ask([], placeholder);
        } catch {
          return;
        }
        if (value === undefined) return;
        values[placeholder] = value;
      }

      attempt(() => editorEl.setValue(fillWorkflow(workflow, values)));
    })();
  }

  /** @jarvis/platform's fillWorkflow, restated: substitutes every
   *  `{{name}}` / `{{ name }}` occurrence a value was supplied for, and
   *  leaves the rest in place. Restated rather than imported — a renderer
   *  module may only import *types* from a workspace package (see
   *  no-value-imports.test.ts); the real implementation lives in
   *  workflows.ts, whose fillWorkflow suite is the source of truth this
   *  copy must track: "substitutes both spaced and unspaced forms of the
   *  same placeholder" and "leaves an unsupplied placeholder in place
   *  rather than becoming 'undefined'" (workflows.test.ts). Both are
   *  exercised against this copy too, in terminal-pane.test.ts's "Run
   *  workflow…" suite — keep all three in sync on any change here. */
  function fillWorkflow(workflow: Workflow, values: Record<string, string>): string {
    return workflow.command.replace(/\{\{\s*([^\s{}]+)\s*\}\}/g, (whole: string, name: string) => {
      const value = values[name];
      return value === undefined ? whole : value;
    });
  }

  /**
   * "Generate command…"'s whole flow: ask the palette for a free-text
   * description, hand it to `terminalAi("generate", …)`, and put whatever
   * comes back in the editor. It fills; it never runs — the result is
   * never handed to `hooks.sendInput`, the same rule re-run and workflows
   * both follow, so the user always reads a generated command before it
   * can do anything.
   *
   * Never throws into the terminal: Escape at the prompt, or a brain call
   * that fails (which resolves "" rather than rejecting, but this still
   * guards the await), simply leaves the editor as it was. An empty result
   * also leaves the editor untouched — "" is not a command worth showing.
   */
  function generateCommand(): void {
    const ai = hooks.terminalAi;
    if (ai === undefined || editor === undefined) return;
    const editorEl = editor;
    void (async () => {
      // Yields once before touching the palette — the same gap `runWorkflow`
      // and `historySearch` get for free from their own leading `await
      // read()`. Without it, this action's own `palette.ask` would be set
      // up and torn down inside the *same* synchronous call: the "Actions"
      // palette's `chooseSelected` runs this action's `run()` and then
      // immediately closes the palette, and a nested `ask()` opened before
      // that close call would be the thing it closes.
      await Promise.resolve();
      let request: string | undefined;
      try {
        request = await palette.ask([], "What should this do?");
      } catch {
        return;
      }
      if (request === undefined || request === "") return;
      let result: string;
      try {
        result = await ai("generate", request);
      } catch {
        return;
      }
      if (result !== "") attempt(() => editorEl.setValue(result));
    })();
  }

  /**
   * "Explain this failure"'s whole flow: send the selected block's command,
   * exit code and output (its last `EXPLAIN_OUTPUT_CAP` characters —
   * capped before this ever reaches IPC, not only once it lands in main)
   * to `terminalAi("explain", …)`, and render whatever comes back inside
   * that same block. Only ever offered — see `paletteActions` — for a
   * selected block whose exit code is a real non-zero number, so there is
   * always a command, a code and an output to send.
   *
   * Never throws into the terminal: a call that fails resolves "" (never
   * rejects), and `BlockView.explain("")` already does nothing.
   */
  function explainFailure(): void {
    const ai = hooks.terminalAi;
    const selected = nav?.selected();
    if (ai === undefined || selected === undefined) return;
    const record = selected.record;
    const payload = JSON.stringify({
      command: record.command,
      exitCode: record.exitCode,
      output: record.output.slice(-EXPLAIN_OUTPUT_CAP),
    });
    void ai("explain", payload)
      .then((result) => attempt(() => selected.explain(result)))
      .catch(() => {
        // No explanation. The block is untouched.
      });
  }

  /**
   * `^R`'s whole flow: ask the palette over Jarvis's own command log — the
   * same log the editor's own ↑/↓ walk, not zsh's — and put whatever was
   * chosen back in the editor. It fills; it never runs, the same rule
   * re-run follows: nothing here appends a return.
   *
   * Never throws into the terminal: a history read that fails, or a
   * palette the user closed with Escape, simply leaves the editor as it
   * was.
   */
  function historySearch(): void {
    const read = hooks.history;
    if (read === undefined || editor === undefined) return;
    const editorEl = editor;
    void (async () => {
      let lines: string[];
      try {
        lines = await read();
      } catch {
        return;
      }
      let chosen: string | undefined;
      try {
        chosen = await palette.ask(lines, "History");
      } catch {
        return;
      }
      if (chosen !== undefined) attempt(() => editorEl.setValue(chosen as string));
    })();
  }

  // A view of `palette` whose `open` first hides the completion dropdown —
  // handed to `handlePaletteKey` rather than `palette` itself, so ⌘P
  // claimed at this listener (the editor-visible state) closes a stale
  // suggestion list the same way `openPalette()` below does for every
  // other state. `isOpen`/`handleKey`/`ask`/`close` are the same
  // functions `palette` itself has — only `open` differs.
  const paletteForKeys: Palette = {
    ...palette,
    open: (actions, placeholder) => {
      attempt(() => hooks.closeCompletion?.());
      palette.open(actions, placeholder);
    },
  };

  const paletteKeys: PaletteKeys = {
    palette: paletteForKeys,
    actions: paletteActions,
    historySearch,
  };

  /** True while this pane is the one the user is looking at: the window
   *  itself has focus, and the focused element is inside this pane (its
   *  live terminal or its command editor — both live under `element`). */
  function isWatched(): boolean {
    return document.hasFocus() && element.contains(document.activeElement);
  }

  function notifyIfUnwatched(record: BlockRecord): void {
    const threshold = hooks.settings.notifyAfterSeconds;
    if (threshold <= 0) return;
    if (record.endedAt === undefined) return;
    const durationSeconds = (record.endedAt - record.startedAt) / 1000;
    if (durationSeconds < threshold) return;
    if (isWatched()) return;
    const status =
      record.exitCode === 0 ? "succeeded" : `failed (exit ${record.exitCode ?? "unknown"})`;
    hooks.notify("Command finished", `${record.command} ${status}`);
  }

  function freeze(record: BlockRecord): void {
    const view = createBlockView(record, {
      cols: terminal.cols,
      fill,
      copy,
      home: hooks.settings.home,
      filterToCommand: (command) => attempt(() => nav?.filterToCommand(command)),
      select: (clicked) => attempt(() => nav?.select(clicked)),
    });
    views.push(view);
    list.append(view.element);
    while (views.length > MAX_BLOCKS) views.shift()?.element.remove();
    attempt(() => nav?.sync(views));
  }

  /** Whether a chip read is outstanding, and the directory of the most
   *  recent prompt that arrived while it was. `cwd` fires on every prompt —
   *  a bare Enter included — and one read is four `git` subprocesses in
   *  main; starting one per prompt means hundreds of concurrent `git
   *  status` runs from a held Enter or a pasted script, times the number of
   *  panes. At most one read is in flight per pane, and a burst collapses
   *  to that read plus one more for whatever the last prompt said. */
  let chipsPending = false;
  let chipsQueued: string | undefined;

  /**
   * Re-reads and re-draws the chip row for whatever prompt just arrived.
   *
   * Stale-then-update: the row goes on showing whatever it already had
   * until this resolves, so a slow repository never means an input the
   * user cannot type into. A rejected read leaves the previous row exactly
   * as it was — `chipRow.render` is only ever called with a result that
   * actually came back.
   *
   * `path` is the directory that prompt reported. It travels with the read
   * because main knows only where the shell was *started*.
   */
  function refreshChips(path: string): void {
    const read = hooks.chips;
    if (read === undefined) return;
    // A read is already out. Remember the directory this prompt was in and
    // re-read once, when that one lands — never start a second beside it.
    // With only ever one read in flight, results also land in the order
    // they were asked for: there is no stale answer that can overwrite a
    // fresher one, and so no generation counter either.
    if (chipsPending) {
      chipsQueued = path;
      return;
    }
    chipsPending = true;
    void read(path)
      .then((chips) => {
        if (disposed) return;
        chipRow.render(chips);
      })
      .catch(() => {
        // The previous row stands.
      })
      .finally(() => {
        chipsPending = false;
        const queued = chipsQueued;
        chipsQueued = undefined;
        // The last prompt of the burst is the one still worth answering:
        // every prompt in between described a directory the shell has
        // already left.
        if (queued !== undefined && !disposed) refreshChips(queued);
      });
  }

  function handle(event: BlockEvent): void {
    // Output first and unguarded: this is the byte stream, and it is the one
    // thing in this function that must never be skipped.
    if (event.type === "output") {
      terminal.write(event.text);
      return;
    }
    if (event.type === "alt-screen") {
      attempt(() => applyState(event.active ? "alt" : "blocks"));
      return;
    }
    if (event.type === "command-start") {
      // A ConPTY repaint that arrived while the live terminal was hidden at
      // the prompt is still sitting in its buffer — the earlier commands'
      // output, which the blocks above already show. Cleared behind xterm's
      // write queue so the command's own echo (the current line, which
      // clear() keeps) has painted first, and only where repaints happen.
      if (repaintsOnResize) terminal.write("", () => attempt(() => terminal.clear()));
      attempt(() => applyState("running"));
      return;
    }
    if (event.type === "cwd") {
      attempt(() => hooks.onCwd?.(event.path));
      // The same OSC 7 path the sidebar re-roots on, handed to the chip
      // read: main knows only where the shell *started*, so without this
      // the sidebar and the chip row describe two different directories.
      attempt(() => refreshChips(event.path));
      return;
    }
    if (event.type === "block-done") {
      // The shell is back at its prompt: a resize held during the command can
      // go to the pty now, and its repaint will fall on the hidden terminal.
      attempt(flushHeldResize);
      // Freezing may fail (a hostile `cols`, a DOM that says no); the reset
      // that follows must happen either way, or the live terminal would go
      // on showing output the block above it is also showing.
      attempt(() => freeze(event.block));
      attempt(() => notifyIfUnwatched(event.block));
      // The frozen block now holds what the live terminal was drawing — so
      // the live terminal is cleared. Ordered *behind* xterm's write buffer,
      // never called straight from here: Terminal.write() always defers its
      // parsing to a macrotask (see block-render.ts, which states the same
      // property), and reset() neither drains nor discards what is queued.
      // A synchronous reset therefore clears the screen first and lets the
      // bytes it was meant to clear paint after it — for `ls`, where the
      // output and its D mark arrive in one pty read, the whole output was
      // redrawn into the live terminal directly under the frozen block
      // already showing it, every finished command, every time.
      //
      // An empty write is the queue's own "when everything before this has
      // been parsed" signal, and the state flip goes inside it for the same
      // reason: flipping to "blocks" before the clear would put the editor
      // in front of a terminal still about to paint.
      terminal.write("", () => {
        if (disposed) return;
        attempt(() => terminal.reset());
        attempt(() => applyState("blocks"));
        // renderOutput() paints a block's output a macrotask after
        // createBlockView() returns (see its own contract) — scrolling here,
        // synchronously, would settle at a height that does not include that
        // block's output yet. Deferred behind the same kind of macrotask so
        // the pane lands at the true bottom once painting has actually
        // happened, not before.
        setTimeout(() => {
          if (disposed) return;
          attempt(() => scrollToBottom());
        }, 0);
      });
      return;
    }
    if (event.type === "prompt") {
      // The shell's integration has spoken: from here on this pane knows a
      // prompt when it sees one.
      sawPrompt = true;
      // Once per prompt, which is the only moment the log can have changed.
      attempt(() => loadHistory());
      attempt(() => applyState("blocks"));
      // The prompt's own bytes are still on their way through xterm's
      // parser when this arrives, so the row promptText() reads is the
      // previous one. Re-read once the screen has caught up; the editor's
      // visibility is already settled above, and only its label changes.
      setTimeout(() => {
        if (disposed || editor === undefined || !editor.isVisible()) return;
        attempt(() => editor.show(promptText()));
      }, 0);
    }
    // Everything else the live terminal is already drawing.
  }

  function write(chunk: string): void {
    if (disposed) return;
    if (!hooks.settings.blocks) {
      terminal.write(chunk);
      return;
    }
    let events: BlockEvent[];
    try {
      events = splitter.push(chunk);
    } catch {
      // The splitter is pure and is not expected to throw, but a chunk that
      // never reaches the screen is the one failure this feature must not
      // have — so a broken split falls back to the raw bytes.
      terminal.write(chunk);
      return;
    }
    for (const event of events) handle(event);
  }

  // The live terminal's own box, which changes size for reasons the pane's
  // outer host never sees: blocks piling up above it, the editor taking
  // over the prompt row, a state flip that hides or shows it. The hosts
  // observe the *leaf*, which a growing block list never resizes — so
  // without this xterm kept its old grid while its box shrank, and spilled
  // visibly over the blocks above it.
  let liveObserver: ResizeObserver | undefined;
  attempt(() => {
    if (typeof ResizeObserver === "undefined") return;
    liveObserver = new ResizeObserver(() => {
      if (disposed) return;
      refit();
    });
    liveObserver.observe(live);
  });

  // Whatever the shell printed before this pane existed — its prompt,
  // usually. It goes through write() rather than straight to xterm because
  // it can carry the marks that say where the prompt is.
  void hooks
    .attach()
    .then((buffered) => {
      if (buffered !== "") write(buffered);
    })
    .catch(() => {
      // No replay. The shell is still there and its next byte still lands.
    });

  return {
    element,
    terminal,
    write,
    // The editor has the keys whenever it is on screen; the terminal has
    // them every other moment.
    focus: focusPane,
    // A pane with no layout yet (hidden, or the window minimised) measures
    // as zero and would make the addon throw — refit() guards that.
    refit,
    reset: () => {
      // The pane is being pointed at something else entirely (the Session
      // view switching agents), so what the *last* thing's shell proved
      // about its integration says nothing about this one's: until the new
      // one emits its own A mark there is no prompt to trust, and the
      // editor must not stand in front of whatever is reading stdin now.
      sawPrompt = false;
      // The nav first, so the selection is dropped while the block it is on
      // is still in the list — the same order sync() relies on.
      attempt(() => nav?.reset());
      for (const view of views.splice(0)) attempt(() => view.element.remove());
    },
    dispose: () => {
      disposed = true;
      // Before the terminal goes: an observer left connected outlives the
      // pane and keeps its element (and this closure) alive.
      attempt(() => liveObserver?.disconnect());
      terminal.dispose();
      for (const view of views.splice(0)) view.element.remove();
      element.remove();
      // Releases the sticky header's document-level scroll listener — left
      // running, it would outlive this tab for the rest of the process.
      attempt(() => nav?.dispose());
      // A pane can be closed while historySearch() is still awaiting
      // palette.ask() — closing here resolves that promise (to undefined,
      // same as Escape) instead of leaving it pending forever.
      attempt(() => palette.close());
    },
    // A copy: the internal array goes on changing as commands finish, and a
    // caller holding what it was told is a readonly list must not see it move.
    blocks: () => [...views],
    blockNav: nav,
    readInput: () => (editor?.isVisible() ? editor.value() : undefined),
    applyInput: (line) => attempt(() => editor?.setValue(line)),
    editorElement: () => editor?.element,
    atPrompt: () => idle(),
    // Unconditional — no state check here. That is the whole point: the
    // palette must open whether a command is running, the alt screen is
    // held, or there is no editor at all. Only the *actions* it offers
    // are state-dependent, inside paletteActions() itself.
    openPalette: () =>
      attempt(() => {
        hooks.closeCompletion?.();
        palette.open(paletteActions(), "Actions");
      }),
  };
}
