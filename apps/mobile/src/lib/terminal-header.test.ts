import { describe, expect, it } from "vitest";
import { paneChips, terminalTitle } from "./terminal-header";

describe("terminalTitle", () => {
  it("uses the tab title", () => {
    expect(terminalTitle({ title: "claude-main" }, "p1")).toBe("claude-main");
  });

  it("falls back to the pane key without a tab or with a blank title", () => {
    expect(terminalTitle(undefined, "p1")).toBe("p1");
    expect(terminalTitle({ title: "  " }, "p1")).toBe("p1");
  });
});

describe("paneChips", () => {
  it("numbers the panes and marks the current and exited ones", () => {
    const chips = paneChips(
      [
        { paneKey: "a", exited: false },
        { paneKey: "b", exited: true },
      ],
      "b",
    );
    expect(chips).toEqual([
      { paneKey: "a", number: 1, current: false, exited: false },
      { paneKey: "b", number: 2, current: true, exited: true },
    ]);
  });

  it("marks none current when the pane is not in the inventory", () => {
    expect(paneChips([{ paneKey: "a", exited: false }], "z").some((c) => c.current)).toBe(false);
  });
});
