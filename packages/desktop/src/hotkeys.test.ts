import { describe, expect, it } from "vitest";
import {
  PRIMARY_HOTKEYS,
  WINDOWS_FALLBACK_HOTKEYS,
  registerVoiceHotkeys,
  type HotkeyDeps,
} from "./hotkeys.js";

/** A globalShortcut that refuses the accelerators in `taken`. */
function shortcuts(taken: string[] = []) {
  const registered: string[] = [];
  const unregistered: string[] = [];
  const deps: HotkeyDeps = {
    register: (accelerator) => {
      if (taken.includes(accelerator)) return false;
      registered.push(accelerator);
      return true;
    },
    unregister: (accelerator) => {
      unregistered.push(accelerator);
    },
    onStart: () => {},
    onStop: () => {},
  };
  return { deps, registered, unregistered };
}

describe("registerVoiceHotkeys", () => {
  it("registers the primary pair when it is free", () => {
    const { deps, registered } = shortcuts();

    expect(registerVoiceHotkeys(deps, "darwin")).toEqual({
      active: PRIMARY_HOTKEYS,
      refused: [],
      fellBack: false,
    });
    expect(registered).toEqual(["Alt+Space", "Alt+Shift+Space"]);
  });

  it("reports a collision and tries nothing else off Windows", () => {
    const { deps, registered, unregistered } = shortcuts(["Alt+Space"]);

    expect(registerVoiceHotkeys(deps, "darwin")).toEqual({
      active: undefined,
      refused: ["Alt+Space"],
      fellBack: false,
    });
    // The stop key that did register is released: a stop with no start is a
    // key that appears to do nothing.
    expect(registered).toEqual(["Alt+Shift+Space"]);
    expect(unregistered).toEqual(["Alt+Shift+Space"]);
  });

  // PowerToys Run holds Alt+Space on a great many Windows machines.
  it("falls back to the second pair on Windows when the first is taken", () => {
    const { deps, registered } = shortcuts(["Alt+Space"]);

    expect(registerVoiceHotkeys(deps, "win32")).toEqual({
      active: WINDOWS_FALLBACK_HOTKEYS,
      refused: ["Alt+Space"],
      fellBack: true,
    });
    expect(registered).toContain("Ctrl+Shift+Space");
    expect(registered).toContain("Ctrl+Alt+Shift+Space");
  });

  it("gives up, naming everything refused, when the fallback is taken too", () => {
    const { deps } = shortcuts(["Alt+Space", "Ctrl+Alt+Shift+Space"]);

    expect(registerVoiceHotkeys(deps, "win32")).toEqual({
      active: undefined,
      refused: ["Alt+Space", "Ctrl+Alt+Shift+Space"],
      fellBack: false,
    });
  });
});
