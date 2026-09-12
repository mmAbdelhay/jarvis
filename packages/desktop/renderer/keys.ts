// Every chord the app claims, in one table, resolved per platform.
//
// It exists because the same shortcut is spelled twice — once for the code
// that dispatches it and once for the hint that advertises it — and two
// spellings drift. A hint that names a key which does nothing is worse than
// no hint at all.
//
// The platforms differ in more than glyphs. On macOS the app modifier is ⌘,
// which has never had a terminal meaning, so Ctrl stays entirely the shell's.
// On Linux the natural app modifier IS Ctrl, and Ctrl+C, Ctrl+D, Ctrl+R and
// the rest are control bytes the shell must keep receiving. So every app
// chord there takes Shift as well — which is what GNOME Terminal, Konsole,
// VS Code and Warp all do, and it is why the chords that already use Shift on
// macOS (⌘⇧D, ⌘⇧F) get a letter of their own rather than a second Shift.
//
// This module imports nothing: a renderer module may not import a value from
// a workspace package, and this one has no reason to want to.

/** Something the app does in response to a chord. The terminal owns most of
 *  them; sendRequest and saveRequest belong to the API tab's editor. */
export type ChordAction =
  | "palette"
  | "historySearch"
  | "search"
  | "filterFailed"
  | "blockPrev"
  | "blockNext"
  | "copy"
  | "paste"
  | "clearScreen"
  | "splitRow"
  | "splitColumn"
  | "closePane"
  | "focusPrev"
  | "focusNext"
  | "sendRequest"
  | "saveRequest";

/** A chord a caller can ask for a label of, including the two the main
 *  process owns — the voice hotkeys are registered by globalShortcut, not
 *  matched here, but they are advertised in the same places. */
export type LabelledChord = ChordAction | "voiceStart" | "voiceStop";

/**
 * One chord. Every modifier not named must be *absent* — a chord is matched
 * exactly, never as a subset.
 *
 * That strictness is what lets ⌘F and ⌘⇧F, or ⌘D and ⌘⇧D, sit in the same
 * table without an ordering rule between them: neither matches the other's
 * event, so the table can be read in any order.
 */
type Chord = {
  /** `event.key`, compared case-insensitively — Shift changes its case. */
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
};

type Binding = { darwin: Chord; linux: Chord; label: { darwin: string; linux: string } };

const BINDINGS: Record<LabelledChord, Binding> = {
  palette: {
    darwin: { key: "p", meta: true },
    linux: { key: "p", ctrl: true, shift: true },
    label: { darwin: "⌘P", linux: "Ctrl+Shift+P" },
  },
  // The one control byte claimed on both platforms. zsh and bash both bind
  // ^R to reverse-i-search, and this supersedes it deliberately: the palette
  // searches the same command log, against the same history the editor's own
  // ↑/↓ walk, so leaving it to the shell would be the shell doing a worse job
  // of a feature the app already owns.
  historySearch: {
    darwin: { key: "r", ctrl: true },
    linux: { key: "r", ctrl: true },
    label: { darwin: "^R", linux: "Ctrl+R" },
  },
  search: {
    darwin: { key: "f", meta: true },
    linux: { key: "f", ctrl: true, shift: true },
    label: { darwin: "⌘F", linux: "Ctrl+Shift+F" },
  },
  // ⌘⇧F on macOS. On Linux Shift is already spent making the chord an app
  // chord at all, so this gets its own letter rather than a second Shift.
  filterFailed: {
    darwin: { key: "f", meta: true, shift: true },
    linux: { key: "g", ctrl: true, shift: true },
    label: { darwin: "⌘⇧F", linux: "Ctrl+Shift+G" },
  },
  blockPrev: {
    darwin: { key: "ArrowUp", meta: true },
    linux: { key: "ArrowUp", ctrl: true, shift: true },
    label: { darwin: "⌘↑", linux: "Ctrl+Shift+↑" },
  },
  blockNext: {
    darwin: { key: "ArrowDown", meta: true },
    linux: { key: "ArrowDown", ctrl: true, shift: true },
    label: { darwin: "⌘↓", linux: "Ctrl+Shift+↓" },
  },
  copy: {
    darwin: { key: "c", meta: true },
    linux: { key: "c", ctrl: true, shift: true },
    label: { darwin: "⌘C", linux: "Ctrl+Shift+C" },
  },
  paste: {
    darwin: { key: "v", meta: true },
    linux: { key: "v", ctrl: true, shift: true },
    label: { darwin: "⌘V", linux: "Ctrl+Shift+V" },
  },
  clearScreen: {
    darwin: { key: "k", meta: true },
    linux: { key: "k", ctrl: true, shift: true },
    label: { darwin: "⌘K", linux: "Ctrl+Shift+K" },
  },
  splitRow: {
    darwin: { key: "d", meta: true },
    linux: { key: "d", ctrl: true, shift: true },
    label: { darwin: "⌘D", linux: "Ctrl+Shift+D" },
  },
  // ⌘⇧D on macOS — same key, two directions. Its own letter on Linux, for the
  // same reason filterFailed has one.
  splitColumn: {
    darwin: { key: "d", meta: true, shift: true },
    linux: { key: "e", ctrl: true, shift: true },
    label: { darwin: "⌘⇧D", linux: "Ctrl+Shift+E" },
  },
  closePane: {
    darwin: { key: "w", meta: true },
    linux: { key: "w", ctrl: true, shift: true },
    label: { darwin: "⌘W", linux: "Ctrl+Shift+W" },
  },
  // Option is required on macOS because ⌘← and ⌘→ are start-of-line and
  // end-of-line, which no split may take. Linux has no such claim on
  // Alt+arrow, so it needs no second modifier.
  focusPrev: {
    darwin: { key: "ArrowLeft", meta: true, alt: true },
    linux: { key: "ArrowLeft", alt: true },
    label: { darwin: "⌥⌘←", linux: "Alt+←" },
  },
  focusNext: {
    darwin: { key: "ArrowRight", meta: true, alt: true },
    linux: { key: "ArrowRight", alt: true },
    label: { darwin: "⌥⌘→", linux: "Alt+→" },
  },
  // The API tab's request editor, not the terminal. Ctrl+Enter and Ctrl+S are
  // safe there precisely because no shell is listening: a text field is.
  sendRequest: {
    darwin: { key: "Enter", meta: true },
    linux: { key: "Enter", ctrl: true },
    label: { darwin: "⌘Enter", linux: "Ctrl+Enter" },
  },
  saveRequest: {
    darwin: { key: "s", meta: true },
    linux: { key: "s", ctrl: true },
    label: { darwin: "⌘S", linux: "Ctrl+S" },
  },
  // Registered by the main process with globalShortcut, never matched here —
  // but advertised in the Dashboard hint, the mic button's label and the
  // composer placeholder, which is why the spelling lives in this table too.
  voiceStart: {
    darwin: { key: " ", alt: true },
    linux: { key: " ", alt: true },
    label: { darwin: "⌥Space", linux: "Alt+Space" },
  },
  voiceStop: {
    darwin: { key: " ", alt: true, shift: true },
    linux: { key: " ", alt: true, shift: true },
    label: { darwin: "⌥⇧Space", linux: "Alt+Shift+Space" },
  },
};

/** Which side of every binding this platform reads. Anything that is not
 *  darwin is spelled the Linux way — Windows is not a target, and if it ever
 *  is, Ctrl+Shift is the convention there too. */
function side(platform: NodeJS.Platform): "darwin" | "linux" {
  return platform === "darwin" ? "darwin" : "linux";
}

function matches(event: KeyboardEvent, chord: Chord): boolean {
  return (
    event.key.toLowerCase() === chord.key.toLowerCase() &&
    event.metaKey === (chord.meta ?? false) &&
    event.ctrlKey === (chord.ctrl ?? false) &&
    event.altKey === (chord.alt ?? false) &&
    event.shiftKey === (chord.shift ?? false)
  );
}

/**
 * The action this keystroke asks for, or undefined for one the app does not
 * claim — which on Linux is every bare Ctrl chord the shell needs.
 *
 * Only keydown matches. A keyup carrying the same modifiers is the same
 * chord being released, and claiming it twice would fire the action twice.
 */
export function matchChord(
  event: KeyboardEvent,
  platform: NodeJS.Platform,
): ChordAction | undefined {
  if (event.type !== "keydown") return undefined;
  const which = side(platform);
  for (const [action, binding] of Object.entries(BINDINGS)) {
    if (action === "voiceStart" || action === "voiceStop") continue;
    if (matches(event, binding[which])) return action as ChordAction;
  }
  return undefined;
}

/**
 * The voice hotkeys main actually registered, when they are not the pair in
 * the table.
 *
 * The two voice entries are the only chords this module does not match
 * itself — globalShortcut owns them, and on Windows it may have had to take
 * a different pair because another app held Alt+Space (see src/hotkeys.ts).
 * A label that names a key nothing listens to is exactly what this module
 * exists to prevent, so main's answer wins over the table.
 */
let liveVoiceHotkeys: { start: string; stop: string } | undefined;

export function setVoiceHotkeys(hotkeys: { start: string; stop: string }): void {
  liveVoiceHotkeys = hotkeys;
}

/** How a chord is written where a user can read it. */
export function keyLabel(action: LabelledChord, platform: NodeJS.Platform): string {
  if (liveVoiceHotkeys !== undefined) {
    if (action === "voiceStart") return liveVoiceHotkeys.start;
    if (action === "voiceStop") return liveVoiceHotkeys.stop;
  }
  return BINDINGS[action].label[side(platform)];
}

/**
 * The platform this renderer is running on, from the preload bridge.
 *
 * The chord handlers default to it so the platform does not have to be
 * threaded through every pane, split and tab that owns a keystroke — but each
 * of them still takes it as a parameter, which is what lets one test run
 * assert both spellings of every chord.
 *
 * darwin when the bridge is absent, which is only ever a test that did not
 * set one, and is the spelling those tests were written in.
 */
export function hostPlatform(): NodeJS.Platform {
  const bridge = (globalThis as { jarvis?: { platform?: NodeJS.Platform } }).jarvis;
  return bridge?.platform ?? "darwin";
}
