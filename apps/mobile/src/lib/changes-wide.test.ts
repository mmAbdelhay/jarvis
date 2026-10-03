import { describe, expect, it } from "vitest";
import {
  commitFilesLabel,
  groupFiles,
  gutterNumber,
  numberedDiffRows,
  splitDiffRows,
  stageGroupTargets,
  unstageAllTargets,
} from "./changes-screen";
import { loadDiffMode, loadPrefs, type PrefsStore, setDiffMode } from "./prefs";

const FILES = [
  { path: "a", staged: true },
  { path: "b", staged: false },
  { path: "c", staged: true },
  { path: "d", staged: false },
  { path: "e", staged: false },
];

const line = (
  kind: "context" | "added" | "removed",
  text: string,
  beforeLine: number | undefined,
  afterLine: number | undefined,
) => ({ kind, text, beforeLine, afterLine });

describe("groupFiles", () => {
  it("splits staged from unstaged with the counts, keeping order", () => {
    const groups = groupFiles(FILES);
    expect(groups.staged.map((f) => f.path)).toEqual(["a", "c"]);
    expect(groups.unstaged.map((f) => f.path)).toEqual(["b", "d", "e"]);
  });
  it("unstageAllTargets takes only staged paths, stageGroupTargets only unstaged", () => {
    expect(unstageAllTargets(FILES)).toEqual(["a", "c"]);
    expect(stageGroupTargets(FILES)).toEqual(["b", "d", "e"]);
  });
});

describe("commitFilesLabel", () => {
  it("pluralises in English", () => {
    expect(commitFilesLabel(0, "en")).toBe("Commit");
    expect(commitFilesLabel(1, "en")).toBe("Commit 1 file");
    expect(commitFilesLabel(2, "en")).toBe("Commit 2 files");
  });
  it("pluralises in Arabic (one, two, 3-10, 11+)", () => {
    expect(commitFilesLabel(1, "ar")).toBe("احفظ ملفًا واحدًا");
    expect(commitFilesLabel(2, "ar")).toBe("احفظ ملفين");
    expect(commitFilesLabel(5, "ar")).toBe("احفظ 5 ملفات");
    expect(commitFilesLabel(11, "ar")).toBe("احفظ 11 ملفًا");
  });
});

describe("numbered unified rows", () => {
  const diff = {
    path: "f.ts",
    hunks: [
      {
        header: "@@ -1,2 +1,2 @@",
        lines: [
          line("context", "a", 1, 1),
          line("removed", "b", 2, undefined),
          line("added", "B", undefined, 2),
        ],
      },
      {
        header: "@@ -10 +10,2 @@",
        lines: [line("added", "x", undefined, 10), line("added", "y", undefined, 11)],
      },
    ],
  };
  it("numbers lines by their own position and continues across hunks", () => {
    const rows = numberedDiffRows(diff);
    expect(rows.map((r) => (r.kind === "hunk" ? "H" : r.number))).toEqual([
      "H",
      1,
      2,
      2,
      "H",
      10,
      11,
    ]);
  });
  it("right-aligns the gutter in four columns", () => {
    expect(gutterNumber(7)).toBe("   7");
    expect(gutterNumber(1234)).toBe("1234");
    expect(gutterNumber(undefined)).toBe("    ");
  });
});

describe("splitDiffRows", () => {
  it("pairs removed with added in order and pads the shorter run", () => {
    const rows = splitDiffRows({
      path: "f.ts",
      hunks: [
        {
          header: "@@ @@",
          lines: [
            line("context", "c", 1, 1),
            line("removed", "r1", 2, undefined),
            line("removed", "r2", 3, undefined),
            line("added", "a1", undefined, 2),
            line("context", "d", 4, 3),
            line("added", "a2", undefined, 4),
          ],
        },
      ],
    });
    const pairs = rows.filter((r) => r.kind === "pair");
    expect(pairs).toHaveLength(5);
    expect(pairs[0]).toMatchObject({ left: { number: 1 }, right: { number: 1 } });
    expect(pairs[1]).toMatchObject({
      left: { text: "r1", number: 2 },
      right: { text: "a1", number: 2 },
    });
    expect(pairs[2]).toMatchObject({ left: { text: "r2" }, right: undefined });
    expect(pairs[3]).toMatchObject({ left: { number: 4 }, right: { number: 3 } });
    // the trailing lone addition: left padded
    expect(rows.at(-1)).toMatchObject({ kind: "pair", left: undefined, right: { text: "a2" } });
  });
  it("starts a new change run for a removal after additions, and keeps keys unique", () => {
    const rows = splitDiffRows({
      path: "f",
      hunks: [
        {
          header: "h0",
          lines: [
            line("added", "a", undefined, 1),
            line("removed", "r", 1, undefined),
            line("context", "c", 2, 2),
          ],
        },
        { header: "h1", lines: [line("removed", "z", 9, undefined)] },
      ],
    });
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(rows[1]).toMatchObject({ left: undefined, right: { text: "a" } });
    expect(rows[2]).toMatchObject({ left: { text: "r" }, right: undefined });
  });
});

function memoryStore(initial?: string): PrefsStore & { text: string | undefined } {
  const store = {
    text: initial,
    async read() {
      return store.text;
    },
    async write(text: string) {
      store.text = text;
    },
  };
  return store;
}

describe("diff mode pref", () => {
  it("defaults to unified and drops unknown values", async () => {
    expect(await loadDiffMode(memoryStore(), "en")).toBe("unified");
    expect(await loadDiffMode(memoryStore('{"changesDiffMode":"side"}'), "en")).toBe("unified");
  });
  it("round-trips split without touching other prefs", async () => {
    const store = memoryStore('{"speakReplies":false}');
    await setDiffMode(store, "en", "split");
    expect(await loadDiffMode(store, "en")).toBe("split");
    expect((await loadPrefs(store, "en")).speakReplies).toBe(false);
  });
});
