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

import { createBlockNav, type BlockNav } from "./block-nav.js";
import { createBlockView, type BlockView } from "./block-view.js";
import { handlePaletteKey, type PaletteKeys, type SplitKeys } from "./terminal-addons.js";
import { createSplitter, type BlockEvent, type BlockRecord } from "./terminal-blocks.js";
import { createEditor, type TerminalEditor } from "./terminal-input.js";
import { createPalette, type Palette, type PaletteAction } from "./terminal-palette.js";
import { SCROLLBACK_LINES, TERMINAL_FONT, TERMINAL_THEME } from "./terminal-theme.js";
import { FitAddon } from "./vendor/addon-fit.mjs";
import { Terminal } from "./vendor/xterm.mjs";

export type PaneHooks = {
  sendInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  attach: () => Promise<string>;
  /** The full renderer-facing settings payload — see window.jarvis.terminalSettings()
   *  in src/ipc.ts, which is where `home` comes from. */
  settings: { blocks: boolean; inputEditor: boolean; notifyAfterSeconds: number; home: string };
  /** The most recent commands from Jarvis's own command log, newest first —
   *  what ↑/↓ in the command editor walk. Absent (or failing) means the
   *  arrows find nothing, which is a line that simply does not change. */
  history?: (() => Promise<string[]>) | undefined;
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
};

export type { BlockView };

export type TerminalPane = {
  element: HTMLElement;
  /** Feed it a chunk from the pty. */
  write(chunk: string): void;
  focus(): void;
  refit(): void;
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

export function createPane(host: HTMLElement, hooks: PaneHooks): TerminalPane {
  const element = document.createElement("div");
  element.className = "terminal-pane";
  element.dataset["state"] = hooks.settings.blocks ? "blocks" : "plain";

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

  // Selection, jumping and filtering: nothing to navigate with blocks off,
  // so `nav` stays undefined and the pane's `blockNav` — what
  // terminal-addons.ts's key handler checks — follows it.
  const nav = hooks.settings.blocks ? createBlockNav(list, sticky) : undefined;

  const terminal = new Terminal({
    scrollback: SCROLLBACK_LINES,
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
  terminal.onResize(({ cols, rows }) => hooks.resize(cols, rows));

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
        submit: (line) => attempt(() => hooks.sendInput(`${line}\r`)),
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
    if (editorEl === undefined) return;
    attempt(() => {
      if (state === "blocks" && idle()) {
        resetHistoryCursor();
        editorEl.show(promptText());
      } else {
        editorEl.hide();
      }
      refocus(editorEl);
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
      if (editor !== undefined && editor.isVisible()) {
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
   * route). Workflows and the two AI actions are later tasks and belong
   * here too, once they exist — nothing about this list is final.
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
        actions.push({ id: "rerun", label: "Re-run command", run: () => fill(selected.record.command) });
      }
    }
    actions.push({
      id: "collapse-all",
      label: "Collapse all blocks",
      run: () => attempt(() => views.forEach((view) => view.collapse(true))),
    });
    actions.push({ id: "clear", label: "Clear terminal", run: () => attempt(() => terminal.clear()) });
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

  const paletteKeys: PaletteKeys = { palette: paletteForKeys, actions: paletteActions, historySearch };

  function freeze(record: BlockRecord): void {
    const view = createBlockView(record, {
      cols: terminal.cols,
      fill,
      copy,
      home: hooks.settings.home,
      filterToCommand: (command) => attempt(() => nav?.filterToCommand(command)),
    });
    views.push(view);
    list.append(view.element);
    while (views.length > MAX_BLOCKS) views.shift()?.element.remove();
    attempt(() => nav?.sync(views));
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
      attempt(() => applyState("running"));
      return;
    }
    if (event.type === "block-done") {
      // Freezing may fail (a hostile `cols`, a DOM that says no); the reset
      // that follows must happen either way, or the live terminal would go
      // on showing output the block above it is also showing.
      attempt(() => freeze(event.block));
      // The frozen block now holds what the live terminal was drawing.
      terminal.reset();
      attempt(() => applyState("blocks"));
      // renderOutput() paints a block's output a macrotask after
      // createBlockView() returns (see its own contract) — scrolling here,
      // synchronously, would settle at a height that does not include that
      // block's output yet. Deferred behind the same kind of macrotask so
      // the pane lands at the true bottom once painting has actually
      // happened, not before.
      setTimeout(() => {
        if (disposed) return;
        attempt(() => {
          element.scrollTop = element.scrollHeight;
        });
      }, 0);
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
    focus: () => {
      if (editor !== undefined && editor.isVisible()) {
        editor.focus();
        return;
      }
      terminal.focus();
    },
    refit: () => {
      // A pane with no layout yet (hidden, or the window minimised) measures
      // as zero and would make the addon throw.
      if (element.clientWidth === 0 || element.clientHeight === 0) return;
      attempt(() => fit.fit());
    },
    dispose: () => {
      disposed = true;
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
    readInput: () => (editor !== undefined && editor.isVisible() ? editor.value() : undefined),
    applyInput: (line) => attempt(() => editor?.setValue(line)),
    editorElement: () => editor?.element,
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
