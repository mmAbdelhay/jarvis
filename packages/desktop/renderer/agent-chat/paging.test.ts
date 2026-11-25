// Which messages stay when the live page is applied over the older ones.
import { describe, expect, it } from "vitest";
import { reply } from "./fixture.js";
import { mergeLive, prependOlder } from "./paging.js";

const list = (...ids: string[]) => ids.map((id) => reply(id, id));
const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

describe("mergeLive", () => {
  it("keeps the older messages in front of the live page", () => {
    expect(ids(mergeLive(list("a", "b", "c"), list("c", "d"), false))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("keeps the older messages when a live id repeats further back", () => {
    // A resumed session can write a record again, under the same id.
    const previous = list("x", "a", "b", "c");
    expect(ids(mergeLive(previous, list("c", "x"), false))).toEqual(["a", "b", "c", "x"]);
  });

  it("drops what a rewound session no longer has after the live page's start", () => {
    expect(ids(mergeLive(list("a", "b", "c", "d"), list("b", "e"), false))).toEqual([
      "a",
      "b",
      "e",
    ]);
  });

  it("keeps the older messages when the live page moved on", () => {
    expect(ids(mergeLive(list("a", "b"), list("c"), false))).toEqual(["a", "b", "c"]);
  });

  it("starts over on reset", () => {
    expect(ids(mergeLive(list("a", "b"), list("c"), true))).toEqual(["c"]);
  });
});

describe("prependOlder", () => {
  it("puts older messages first and skips the ones already shown", () => {
    expect(ids(prependOlder(list("b", "c"), list("a", "b")))).toEqual(["a", "b", "c"]);
  });
});
