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
import { createSplitter, type BlockEvent, type BlockRecord } from "./terminal-blocks.js";
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

  // Re-run and copy, for a block with no input editor yet (that is a later
  // task): fill types the command at the live prompt without a trailing
  // return, so it lands ready to edit and never runs on its own; copy goes
  // straight to the system clipboard, the same call the rest of the
  // terminal already makes for a selection or a `tmux save-buffer`.
  function fill(command: string): void {
    attempt(() => hooks.sendInput(command));
  }

  function copy(text: string): void {
    attempt(() => {
      void navigator.clipboard?.writeText(text);
    });
  }

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
      attempt(() => {
        element.dataset["state"] = event.active ? "alt" : "blocks";
      });
      return;
    }
    if (event.type === "command-start") {
      attempt(() => {
        element.dataset["state"] = "running";
      });
      return;
    }
    if (event.type === "block-done") {
      // Freezing may fail (a hostile `cols`, a DOM that says no); the reset
      // that follows must happen either way, or the live terminal would go
      // on showing output the block above it is also showing.
      attempt(() => freeze(event.block));
      // The frozen block now holds what the live terminal was drawing.
      terminal.reset();
      attempt(() => {
        element.dataset["state"] = "blocks";
      });
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
    // "prompt": nothing to do — the live terminal is already drawing it.
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
    focus: () => terminal.focus(),
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
    },
    // A copy: the internal array goes on changing as commands finish, and a
    // caller holding what it was told is a readonly list must not see it move.
    blocks: () => [...views],
    blockNav: nav,
  };
}
