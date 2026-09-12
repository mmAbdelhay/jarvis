import { hostPlatform, matchChord } from "./keys.js";
import type { BlockNav } from "./block-nav.js";
import type { Palette, PaletteAction } from "./terminal-palette.js";
import { ClipboardAddon } from "./vendor/addon-clipboard.mjs";
import { LigaturesAddon } from "./vendor/addon-ligatures.mjs";
import { SearchAddon } from "./vendor/addon-search.mjs";
import { Unicode11Addon } from "./vendor/addon-unicode11.mjs";
import { WebLinksAddon } from "./vendor/addon-web-links.mjs";
import { WebglAddon } from "./vendor/addon-webgl.mjs";
import type { Terminal } from "./vendor/xterm.mjs";

// Everything both of Jarvis's terminals — the Workspace's Terminal tabs and
// the agent Session view — need on top of a bare xterm instance.
//
// It lives here rather than in either module because the two are the same
// surface in the user's eyes: a key that works in one and not the other is a
// bug, and one place to decide the behaviour is the only reliable way to
// prevent that.

export type TerminalHooks = {
  /** Sends bytes to this terminal's pty. */
  sendInput: (data: string) => void;
  /** Opens a URL the user clicked in the terminal. The caller decides where
   *  a link goes, because only it knows which project the terminal belongs
   *  to — and links open as ordinary Workspace tabs, never in an external
   *  browser, so the app's own navigation rules still apply. */
  openLink: (url: string) => void;
  /** Consulted before anything else on every key, and the reason it lives
   *  here at all: xterm keeps exactly one custom key handler, so a caller
   *  that attached its own would silently replace this module's and take
   *  Cmd+F, Cmd+V and Shift+Enter with it. Returning false means the key
   *  was claimed. Absent for a terminal with no autocomplete. */
  interceptKey?: ((event: KeyboardEvent) => boolean) | undefined;
  /** Selection, jumping and filtering over a pane's frozen blocks — ⌘↑/⌘↓
   *  move the selection, ⌘⇧F toggles the failed-only filter. Absent for a
   *  terminal with no blocks (the Session route today, or a pane with
   *  blocks switched off), which is exactly why every key below guards on
   *  it: those keys must behave exactly as they do today when it is
   *  missing, not silently claim a keystroke and do nothing with it. */
  blockNav?: BlockNav | undefined;
  /** Opens the command palette over this pane's actions — ⌘P, claimed
   *  unconditionally, in every pane state. Unlike `^R` (see
   *  terminal-pane.ts's own capture-phase listener, which is where that
   *  one is claimed, and only while the editor is showing), a Cmd chord is
   *  never a byte a running program could want: the OS and the browser
   *  already keep it away from anything a pty could receive, so there is
   *  no state in which claiming it costs a program its keystroke. Absent
   *  for a terminal with no palette (the Session route today), which is
   *  exactly why this key is left alone below when it is missing rather
   *  than claimed and made to do nothing. */
  openPalette?: (() => void) | undefined;
};

/** What the split keys act on — the tab's tree of panes, plus the tab
 *  itself, because ⌘W closes the focused pane and falls through to closing
 *  the tab when there was no other pane to fall back to. */
export type SplitKeys = {
  split(direction: "row" | "column"): void;
  /** False when the focused pane was the last one and nothing was closed. */
  closeFocused(): boolean;
  focus(delta: -1 | 1): void;
  closeTab(): void;
};

/**
 * The split chords: split beside, split below, close the pane (or the tab,
 * when it was the pane's last), and move the focus. keys.ts holds how each
 * is spelled on each platform — ⌘D/⌘⇧D/⌘W/⌥⌘←→ on macOS,
 * Ctrl+Shift+D/E/W and Alt+←→ elsewhere.
 *
 * Returns false when the key was claimed — the same contract as
 * `TerminalHooks.interceptKey`, and it is chained through exactly that
 * rather than through xterm's key handler alone, because a pane with the
 * command editor live never lets a keystroke reach xterm at all: the event
 * targets the editor's own field. Both paths consult interceptKey, so this
 * is the one place both can see.
 */
export function handleSplitKey(
  event: KeyboardEvent,
  keys: SplitKeys,
  platform: NodeJS.Platform = hostPlatform(),
): boolean {
  const action = matchChord(event, platform);

  if (action === "focusPrev" || action === "focusNext") {
    attempt(() => keys.focus(action === "focusNext" ? 1 : -1));
    return claim(event);
  }

  if (action === "splitRow" || action === "splitColumn") {
    attempt(() => keys.split(action === "splitColumn" ? "column" : "row"));
    return claim(event);
  }

  if (action === "closePane") {
    // The last pane is the tab, so closing it is closing the tab — which is
    // also what reaps whatever shells the tab still has.
    attempt(() => {
      if (!keys.closeFocused()) keys.closeTab();
    });
    return claim(event);
  }

  return true;
}

/** What ⌘P and `^R` act on: the palette itself, the (freshly assembled,
 *  each time it opens) action list ⌘P shows, and history search's own
 *  flow — a promise, not a plain action list, since `^R`'s choice fills
 *  the editor rather than running anything. */
export type PaletteKeys = {
  palette: Palette;
  /** Built fresh on every ⌘P — the selected block, the filter state and
   *  what is worth re-running can all have changed since the palette last
   *  opened. */
  actions: () => readonly PaletteAction[];
  /** `^R`'s whole flow: ask the palette over history, and put whatever was
   *  chosen in the editor. Fire-and-forget from here — the key is claimed
   *  the moment the palette opens, and the editor is filled once the user
   *  has actually chosen something, or never, on Escape. */
  historySearch: () => void;
};

/**
 * The palette's two opening chords: ⌘P shows the action list, `^R` opens
 * history search. Once the palette is open, every other key goes straight
 * to `palette.handleKey` — filtering, ↑/↓, Enter, Escape — which is also
 * where "closed, every key comes back true" lives, so a plain `return true`
 * below is exactly as safe as the completion dropdown's.
 *
 * `^R` is the one control byte this module claims: everywhere else Ctrl is
 * deliberately left to the shell, but zsh's own reverse-i-search is
 * superseded by this — the palette already searches the same command log,
 * against the same history the editor's own ↑/↓ walk, so `^R` finding
 * nothing here would only be zsh's line editor doing a worse job of the
 * feature the app now owns.
 */
export function handlePaletteKey(
  event: KeyboardEvent,
  keys: PaletteKeys,
  platform: NodeJS.Platform = hostPlatform(),
): boolean {
  if (event.type !== "keydown") return true;

  if (keys.palette.isOpen()) return keys.palette.handleKey(event);

  const action = matchChord(event, platform);

  if (action === "palette") {
    keys.palette.open(keys.actions(), "Actions");
    return claim(event);
  }

  if (action === "historySearch") {
    keys.historySearch();
    return claim(event);
  }

  return true;
}

/** ESC then CR. xterm encodes Shift+Enter as a bare CR, byte-identical to
 *  Enter, so nothing downstream can tell "newline" from "run this". This is
 *  the sequence the convention settled on for the distinction, and the one
 *  Claude Code's own /terminal-setup configures iTerm2 to send. */
const SHIFT_ENTER = "\u001b\r";

/**
 * Loads the addon stack and wires the key bindings a terminal is expected to
 * have. Call once per terminal, after `terminal.open(host)` — WebGL needs a
 * real element to attach its context to.
 */
export function enhanceTerminal(
  terminal: Terminal,
  host: HTMLElement,
  hooks: TerminalHooks,
  platform: NodeJS.Platform = hostPlatform(),
): void {
  loadAddons(terminal, hooks);
  const search = attachSearch(terminal, host, hooks);
  attachKeys(terminal, hooks, search, platform);
}

function loadAddons(terminal: Terminal, hooks: TerminalHooks): void {
  // Wide characters. Without this an emoji or a CJK glyph is measured as one
  // cell, and every column after it on that line is drawn in the wrong place.
  attempt(() => {
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
  });

  // Clickable URLs. The handler is the caller's: a link opens as a Workspace
  // tab, so it goes through normalizeInput and the app's navigation rules
  // rather than handing an arbitrary string to the OS.
  attempt(() => terminal.loadAddon(new WebLinksAddon((_event, uri) => hooks.openLink(uri))));

  // OSC 52: lets a program running in the terminal put something on the
  // clipboard — how `tmux save-buffer` and friends are meant to work.
  attempt(() => terminal.loadAddon(new ClipboardAddon()));

  // Font ligatures, for the coding fonts that have them. Guarded because it
  // inspects the actual font and has more ways to fail than the rest.
  attempt(() => terminal.loadAddon(new LigaturesAddon()));

  // The GPU renderer, loaded last and the only one whose failure is expected
  // rather than exceptional: a machine with no WebGL2, or a lost context
  // after a GPU reset, falls back to the DOM renderer — slower but correct.
  // A context lost after the fact has to dispose the addon explicitly, or
  // the terminal is left drawing to nothing at all.
  attempt(() => {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    terminal.loadAddon(webgl);
  });
}

/** Every addon here is an enhancement, never a requirement: one that cannot
 *  load must leave a working terminal behind, not a broken one. */
function attempt(load: () => void): void {
  try {
    load();
  } catch {
    // Deliberately silent — see above.
  }
}

/** Like `attempt`, but for the search addon's findNext/findPrevious, whose
 *  boolean result decides whether the frozen blocks get scanned too — a
 *  throw here must read as "no match", not crash the find bar. */
function attemptFind(search: () => boolean): boolean {
  try {
    return search();
  } catch {
    return false;
  }
}

type Search = { open(): void; close(): void; isOpen(): boolean };

/**
 * A find bar over the terminal, since the search addon ships the searching
 * and none of the UI. Built as nodes and appended to the terminal's own host
 * so it travels with the pane it belongs to — no innerHTML, same discipline
 * as every other renderer module.
 */
function attachSearch(terminal: Terminal, host: HTMLElement, hooks: TerminalHooks): Search {
  const addon = new SearchAddon();
  attempt(() => terminal.loadAddon(addon));

  const bar = document.createElement("div");
  bar.className = "terminal-find";
  bar.hidden = true;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "terminal-find-input mono";
  input.placeholder = "Find";
  input.spellcheck = false;

  const close = document.createElement("span");
  close.className = "terminal-find-close";
  close.textContent = "×";
  close.setAttribute("role", "button");

  bar.append(input, close);
  host.append(bar);

  const options = { caseSensitive: false, regex: false, wholeWord: false };
  const find = (forward: boolean): void => {
    if (input.value === "") return;
    // The live terminal first — it is where the user is looking. Only once
    // the search addon itself reports no match does the frozen list above
    // it get scanned; a pane with no blocks (hooks.blockNav undefined)
    // simply stops here, same as today.
    const matched = attemptFind(() =>
      forward ? addon.findNext(input.value, options) : addon.findPrevious(input.value, options),
    );
    if (!matched) attempt(() => hooks.blockNav?.findText(input.value));
  };

  const hide = (): void => {
    bar.hidden = true;
    attempt(() => addon.clearDecorations());
    terminal.focus();
  };

  close.addEventListener("click", hide);
  input.addEventListener("keydown", (event) => {
    // The bar is an ordinary text field: its keys are its own and must not
    // reach the pty, which is why nothing here bubbles.
    event.stopPropagation();
    if (event.key === "Escape") {
      hide();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    find(!event.shiftKey);
  });

  return {
    open: () => {
      bar.hidden = false;
      input.focus();
      input.select();
    },
    close: hide,
    isOpen: () => !bar.hidden,
  };
}

/**
 * Claims a key for the app: stops the browser acting on it as well, and
 * tells xterm not to encode it.
 *
 * Returning false alone is not enough. It only means "xterm, do not encode
 * this" — the keystroke still has its own default, and for Enter that
 * default delivers a carriage return to the textarea xterm listens on. So
 * Shift+Enter sent the ESC+CR it meant *and then* a bare CR behind it, and
 * Claude Code read the pair as "newline, then submit": every multi-line
 * message went off half-written. The same doubling would hit Cmd+V, which
 * reads the clipboard here and would have had the browser paste it again.
 */
function claim(event: KeyboardEvent): false {
  event.preventDefault();
  return false;
}

function attachKeys(
  terminal: Terminal,
  hooks: TerminalHooks,
  search: Search,
  platform: NodeJS.Platform,
): void {
  terminal.attachCustomKeyEventHandler((event) => {
    // First, and only ever while it has something open: an autocomplete
    // dropdown owns Tab and the arrows for as long as it is showing, and
    // hands every key straight back the moment it is not.
    if (hooks.interceptKey !== undefined && !hooks.interceptKey(event)) return false;

    if (event.type !== "keydown") return true;

    // Shift+Enter, and Option+Enter as its Mac alias.
    if (event.key === "Enter" && (event.shiftKey || event.altKey)) {
      hooks.sendInput(SHIFT_ENTER);
      return claim(event);
    }

    // Everything below is a chord the app owns rather than the shell. Which
    // chord that is differs by platform and lives in keys.ts — on a Mac ⌘,
    // which never had a terminal meaning to shadow; elsewhere Ctrl+Shift,
    // because bare Ctrl+C, Ctrl+V and Ctrl+K are real control bytes a
    // program may want.
    const action = matchChord(event, platform);
    if (action === undefined) return true;

    if (action === "search") {
      search.open();
      return claim(event);
    }

    // The command palette. Claimed here, unconditionally, rather than
    // guarded by pane state the way `^R` is: a command running, or the
    // alternate screen held, is exactly when a user most wants to reach
    // for "copy this block's output" or "jump to next failed" — a palette
    // that went inert the moment a command started would deny both at
    // precisely the wrong moment.
    //
    // Both this and handlePaletteKey ask keys.ts, which is what makes them
    // agree on exactly which modifiers claim the palette. They did not always
    // — an extra modifier claimed it in one pane state and not the other.
    if (action === "palette") {
      if (hooks.openPalette === undefined) return true;
      hooks.openPalette();
      return claim(event);
    }

    // Jump the selection between blocks. Undefined blockNav (no blocks in
    // this pane) leaves the key to xterm exactly as before this existed.
    if (action === "blockPrev" || action === "blockNext") {
      if (hooks.blockNav === undefined) return true;
      hooks.blockNav.move(action === "blockNext" ? 1 : -1);
      return claim(event);
    }

    // Failed-only filter.
    if (action === "filterFailed") {
      if (hooks.blockNav === undefined) return true;
      hooks.blockNav.toggleFailedFilter();
      return claim(event);
    }

    // Copy. xterm draws to a canvas and owns its own selection, so the
    // browser's default copy has nothing to act on — without this, Cmd+C
    // over a selection silently does nothing at all.
    if (action === "copy") {
      const selection = terminal.getSelection();
      if (selection === "") return true;
      void navigator.clipboard?.writeText(selection);
      return claim(event);
    }

    // Paste goes in as bytes, exactly as if typed.
    if (action === "paste") {
      void navigator.clipboard?.readText().then((text) => {
        if (text !== "") hooks.sendInput(text);
      });
      return claim(event);
    }

    if (action === "clearScreen") {
      terminal.clear();
      return claim(event);
    }

    return true;
  });
}
