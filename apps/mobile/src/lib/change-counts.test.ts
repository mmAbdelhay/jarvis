import { describe, expect, it } from "vitest";
import { parseChangeCounts } from "./change-counts";

const row = { sessionId: "s1", files: 2, insertions: 84, deletions: 12 };

describe("parseChangeCounts", () => {
  it("keys the counts by session id", () => {
    expect(parseChangeCounts([row, { ...row, sessionId: "s2", files: 0 }])).toEqual({
      s1: { files: 2, insertions: 84, deletions: 12 },
      s2: { files: 0, insertions: 84, deletions: 12 },
    });
  });

  it("drops rows missing numbers or with a non-string session id", () => {
    expect(
      parseChangeCounts([
        { sessionId: "a", files: 1, insertions: 1 },
        { sessionId: "b", files: "1", insertions: 1, deletions: 1 },
        { ...row, sessionId: 7 },
        { ...row, sessionId: "c", deletions: -1 },
        null,
        "x",
      ]),
    ).toEqual({});
  });

  it("is empty for a non-array payload", () => {
    expect(parseChangeCounts({ s1: row })).toEqual({});
  });
});
