// Which global hotkeys start and stop a recording, and what to do when the
// first choice is already taken.
//
// Alt+Space is the app's hotkey everywhere. globalShortcut reports a
// collision by returning false rather than throwing — and on Windows that
// collision is routine rather than rare: PowerToys Run, the launcher on a
// great many Windows machines, claims Alt+Space by default, as does every
// other launcher modelled on Spotlight. A headline feature that is dead on
// arrival for that many machines is not acceptable, so Windows falls back to
// a second pair and the renderer is told which one is live, so that every
// hint it draws names a key that actually works.
//
// Only Windows falls back. On macOS a collision is rare and the advice
// ("close the app holding it, or change its shortcut") is actionable; on
// Linux under Wayland no application can hold a global shortcut at all, and
// a fallback pair would fail exactly as the first did.

export type HotkeyPair = { start: string; stop: string };

/** Electron accelerator strings. The same on every platform. */
export const PRIMARY_HOTKEYS: HotkeyPair = { start: "Alt+Space", stop: "Alt+Shift+Space" };

/**
 * Tried on Windows when the primary pair is taken.
 *
 * Not Ctrl+Alt+Space: Ctrl+Alt is AltGr, and that combination was refused on
 * the machine this was written on. Ctrl+Shift+Space is claimed by no
 * launcher and no input-method switcher, and registered everywhere it was
 * tried — and it is the same Ctrl+Shift the terminal chords use off macOS,
 * so it is the modifier a Windows user is already pressing for Jarvis.
 */
export const WINDOWS_FALLBACK_HOTKEYS: HotkeyPair = {
  start: "Ctrl+Shift+Space",
  stop: "Ctrl+Alt+Shift+Space",
};

export type HotkeyRegistration = {
  /** The pair that is live, or undefined when nothing could be registered —
   *  the mic button still works; only the keys are gone. */
  active: HotkeyPair | undefined;
  /** Every accelerator that was refused, for the message. */
  refused: string[];
  /** True when `active` is the fallback rather than the primary pair. */
  fellBack: boolean;
};

export type HotkeyDeps = {
  /** globalShortcut.register — false on collision, never a throw. */
  register: (accelerator: string, handler: () => void) => boolean;
  /** globalShortcut.unregister. A half-registered pair is released, so a
   *  stop key never sits there with no start key beside it. */
  unregister: (accelerator: string) => void;
  onStart: () => void;
  onStop: () => void;
};

function tryPair(pair: HotkeyPair, deps: HotkeyDeps): string[] {
  const refused: string[] = [];
  const startOk = deps.register(pair.start, deps.onStart);
  if (!startOk) refused.push(pair.start);
  const stopOk = deps.register(pair.stop, deps.onStop);
  if (!stopOk) refused.push(pair.stop);
  if (refused.length > 0) {
    if (startOk) deps.unregister(pair.start);
    if (stopOk) deps.unregister(pair.stop);
  }
  return refused;
}

/**
 * Registers the voice hotkeys: the primary pair, or on Windows the fallback
 * pair when the primary is taken.
 */
export function registerVoiceHotkeys(deps: HotkeyDeps, platform: NodeJS.Platform): HotkeyRegistration {
  const refused = tryPair(PRIMARY_HOTKEYS, deps);
  if (refused.length === 0) return { active: PRIMARY_HOTKEYS, refused: [], fellBack: false };
  if (platform !== "win32") return { active: undefined, refused, fellBack: false };

  const fallbackRefused = tryPair(WINDOWS_FALLBACK_HOTKEYS, deps);
  if (fallbackRefused.length === 0) {
    return { active: WINDOWS_FALLBACK_HOTKEYS, refused, fellBack: true };
  }
  return { active: undefined, refused: [...refused, ...fallbackRefused], fellBack: false };
}
