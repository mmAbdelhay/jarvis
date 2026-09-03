// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createPalette, type PaletteAction } from "./terminal-palette.js";

/** A plain object cast as a KeyboardEvent, the same way
 *  terminal-completion.test.ts drives Completion.handleKey — the palette
 *  never attaches a key handler of its own, so the tests drive it exactly
 *  the way terminal-addons.ts and terminal-pane.ts do. */
function keydown(key: string): KeyboardEvent {
  let prevented = false;
  return {
    type: "keydown",
    key,
    preventDefault: () => {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  } as unknown as KeyboardEvent;
}

function action(label: string): { action: PaletteAction; calls: number[] } {
  const calls: number[] = [];
  return {
    action: {
      id: label,
      label,
      run: () => {
        calls.push(1);
      },
    },
    calls,
  };
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

describe("createPalette — closed", () => {
  it("returns true for every key while closed, the dropdown's own rule", () => {
    const palette = createPalette(document.createElement("div"));

    for (const key of ["a", "Tab", "ArrowUp", "ArrowDown", "Enter", "Escape"]) {
      expect(palette.handleKey(keydown(key))).toBe(true);
    }
    expect(palette.isOpen()).toBe(false);
  });
});

describe("createPalette — open(actions)", () => {
  it("renders every action's label through textContent, never innerHTML", () => {
    const host = document.createElement("div");
    const palette = createPalette(host);
    const evil = action("<img src=x onerror=alert(1)>");

    palette.open([evil.action]);

    expect(host.querySelectorAll("img")).toHaveLength(0);
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("filters the list case-insensitively on a substring as the user types", () => {
    const host = document.createElement("div");
    const palette = createPalette(host);
    const one = action("Copy output");
    const two = action("Copy command");
    const three = action("Clear terminal");
    palette.open([one.action, two.action, three.action]);

    const input = host.querySelector("input") as HTMLInputElement;
    typeInto(input, "COPY");

    const text = host.textContent ?? "";
    expect(text).toContain("Copy output");
    expect(text).toContain("Copy command");
    expect(text).not.toContain("Clear terminal");
  });

  it("moves the selection with the arrows and wraps at both ends", () => {
    const host = document.createElement("div");
    const palette = createPalette(host);
    const items = ["a", "b", "c"].map((label) => action(label));
    palette.open(items.map((i) => i.action));

    // Selects the first item on open.
    expect(host.querySelector(".terminal-palette-item.selected")?.textContent).toBe("a");

    expect(palette.handleKey(keydown("ArrowDown"))).toBe(false);
    expect(host.querySelector(".terminal-palette-item.selected")?.textContent).toBe("b");

    expect(palette.handleKey(keydown("ArrowUp"))).toBe(false);
    expect(palette.handleKey(keydown("ArrowUp"))).toBe(false);
    expect(host.querySelector(".terminal-palette-item.selected")?.textContent).toBe("c");

    expect(palette.handleKey(keydown("ArrowDown"))).toBe(false);
    expect(host.querySelector(".terminal-palette-item.selected")?.textContent).toBe("a");
  });

  it("runs the selected action's run exactly once on Enter, and closes", () => {
    const host = document.createElement("div");
    const palette = createPalette(host);
    const chosen = action("Re-run");
    const other = action("Clear");
    palette.open([chosen.action, other.action]);

    expect(palette.handleKey(keydown("Enter"))).toBe(false);

    expect(chosen.calls).toEqual([1]);
    expect(other.calls).toEqual([]);
    expect(palette.isOpen()).toBe(false);
  });

  it("does not run anything on Escape, and closes", () => {
    const host = document.createElement("div");
    const palette = createPalette(host);
    const entry = action("Clear");
    palette.open([entry.action]);

    expect(palette.handleKey(keydown("Escape"))).toBe(false);

    expect(entry.calls).toEqual([]);
    expect(palette.isOpen()).toBe(false);
  });

  it("goes back to claiming nothing once closed", () => {
    const host = document.createElement("div");
    const palette = createPalette(host);
    palette.open([action("a").action]);
    palette.close();

    expect(palette.handleKey(keydown("ArrowDown"))).toBe(true);
    expect(palette.handleKey(keydown("Enter"))).toBe(true);
  });
});

describe("createPalette — ask(items)", () => {
  it("resolves to the chosen string on Enter", async () => {
    const host = document.createElement("div");
    const palette = createPalette(host);

    const result = palette.ask(["git status", "git log"], "History");
    palette.handleKey(keydown("ArrowDown"));
    palette.handleKey(keydown("Enter"));

    expect(await result).toBe("git log");
    expect(palette.isOpen()).toBe(false);
  });

  it("resolves to undefined on Escape", async () => {
    const host = document.createElement("div");
    const palette = createPalette(host);

    const result = palette.ask(["git status"], "History");
    palette.handleKey(keydown("Escape"));

    expect(await result).toBeUndefined();
  });

  it("filters case-insensitively, same as open()", () => {
    const host = document.createElement("div");
    const palette = createPalette(host);

    void palette.ask(["npm run build", "git status"], "History");
    const input = host.querySelector("input") as HTMLInputElement;
    typeInto(input, "GIT");

    const text = host.textContent ?? "";
    expect(text).toContain("git status");
    expect(text).not.toContain("npm run build");
  });
});

// `ask([], placeholder)` — free text: no list to choose from, so Enter
// resolves to whatever was typed instead of requiring a match. This is
// what a workflow's placeholder prompts are built from.
describe("createPalette — ask([]) free text", () => {
  it("resolves to whatever was typed on Enter", async () => {
    const host = document.createElement("div");
    const palette = createPalette(host);

    const result = palette.ask([], "branch");
    const input = host.querySelector("input") as HTMLInputElement;
    typeInto(input, "feature/login");
    palette.handleKey(keydown("Enter"));

    expect(await result).toBe("feature/login");
    expect(palette.isOpen()).toBe(false);
  });

  it("still resolves to undefined on Escape, never to what was typed", async () => {
    const host = document.createElement("div");
    const palette = createPalette(host);

    const result = palette.ask([], "branch");
    const input = host.querySelector("input") as HTMLInputElement;
    typeInto(input, "feature/login");
    palette.handleKey(keydown("Escape"));

    expect(await result).toBeUndefined();
  });

  it("resolves to an empty string when Enter is pressed with nothing typed", async () => {
    const host = document.createElement("div");
    const palette = createPalette(host);

    const result = palette.ask([], "branch");
    palette.handleKey(keydown("Enter"));

    expect(await result).toBe("");
  });
});
