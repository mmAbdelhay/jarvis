import { describe, expect, it } from "vitest";
import type { GitDiffLine } from "@jarvis/core";
import { toSideBySide } from "./sidebyside.js";

function line(
  kind: GitDiffLine["kind"],
  text: string,
  beforeLine: number | undefined,
  afterLine: number | undefined,
): GitDiffLine {
  return { kind, text, beforeLine, afterLine };
}

describe("toSideBySide", () => {
  it("puts a context line on both sides of one row", () => {
    expect(toSideBySide([line("context", "same", 1, 1)])).toEqual([
      { before: line("context", "same", 1, 1), after: line("context", "same", 1, 1) },
    ]);
  });

  it("pairs a removed line with the added line that replaced it", () => {
    const rows = toSideBySide([
      line("removed", "old", 5, undefined),
      line("added", "new", undefined, 5),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.before?.text).toBe("old");
    expect(rows[0]?.after?.text).toBe("new");
  });

  it("leaves the shorter side empty when the run lengths differ", () => {
    const rows = toSideBySide([
      line("removed", "a", 1, undefined),
      line("added", "b", undefined, 1),
      line("added", "c", undefined, 2),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.before).toBeUndefined();
    expect(rows[1]?.after?.text).toBe("c");
  });

  it("flushes a pending run when a context line interrupts it", () => {
    const rows = toSideBySide([
      line("removed", "a", 1, undefined),
      line("context", "keep", 2, 1),
      line("added", "b", undefined, 2),
    ]);
    expect(rows.map((row) => [row.before?.text, row.after?.text])).toEqual([
      ["a", undefined],
      ["keep", "keep"],
      [undefined, "b"],
    ]);
  });

  it("returns nothing for no lines", () => {
    expect(toSideBySide([])).toEqual([]);
  });
});
