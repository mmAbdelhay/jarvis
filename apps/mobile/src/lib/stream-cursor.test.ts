// Tests for the UTF-16 stream cursor (Task 4). See
// the mobile milestone 7, task 4 plan (docs/superpowers/plans) and
// the M5 plan's ruling 10 for the cursor maths this re-derives.

import { describe, expect, it } from "vitest";
import {
  applyChunk,
  applySnapshot,
  gapMarker,
  parseSnapshot,
  parseStreamChunk,
} from "./stream-cursor";

describe("applyChunk", () => {
  it("the M5 probe rows", () => {
    expect(applyChunk(10, 8, "abcd")).toEqual({
      write: "cd",
      gapUnits: 0,
      reset: false,
      rendered: 12,
    });
    expect(applyChunk(10, 12, "ab")).toEqual({
      write: "ab",
      gapUnits: 2,
      reset: false,
      rendered: 14,
    });
    expect(applyChunk(10, 4, "abc")).toEqual({
      write: "",
      gapUnits: 0,
      reset: false,
      rendered: 10,
    });
  });

  it("a fresh cursor renders the whole first chunk", () => {
    expect(applyChunk(0, 0, "abc")).toEqual({
      write: "abc",
      gapUnits: 0,
      reset: false,
      rendered: 3,
    });
  });

  it(
    "an exact duplicate is skipped " +
      "[bite-proof: compare with < instead of <=; the duplicate is written]",
    () => {
      // end (3+3=6) <= rendered (6): must be dropped entirely.
      expect(applyChunk(6, 3, "def")).toEqual({
        write: "",
        gapUnits: 0,
        reset: false,
        rendered: 6,
      });
    },
  );

  it("never splits a surrogate pair when trimming the front of a chunk", () => {
    // rendered=1 already covers the high surrogate of "😀" (offset 0..2);
    // slicing at rendered-offset=1 would land on the low surrogate.
    const step = applyChunk(1, 0, "😀x");
    expect(step.write).toBe("x");
    expect(step.gapUnits).toBe(1);
    expect(step.reset).toBe(false);
    expect(step.rendered).toBe(3);
    // Never a lone surrogate at the start of what's written.
    expect(step.write.codePointAt(0)).toBeLessThan(0xd800);
  });
});

describe("applySnapshot", () => {
  it("(0, {text:'hello', end:5}) -> 'hello'", () => {
    expect(applySnapshot(0, { text: "hello", end: 5 })).toEqual({
      write: "hello",
      gapUnits: 0,
      reset: false,
      rendered: 5,
    });
  });

  it("(3, {'hello', 5}) -> 'lo'", () => {
    expect(applySnapshot(3, { text: "hello", end: 5 })).toEqual({
      write: "lo",
      gapUnits: 0,
      reset: false,
      rendered: 5,
    });
  });

  it("(0, {'lo', 5}) -> 'lo', gap 3", () => {
    expect(applySnapshot(0, { text: "lo", end: 5 })).toEqual({
      write: "lo",
      gapUnits: 3,
      reset: false,
      rendered: 5,
    });
  });

  it("(5, {'hello', 5}) -> ''", () => {
    expect(applySnapshot(5, { text: "hello", end: 5 })).toEqual({
      write: "",
      gapUnits: 0,
      reset: false,
      rendered: 5,
    });
  });

  it("(9, {'hi', 2}) -> reset, 'hi'", () => {
    expect(applySnapshot(9, { text: "hi", end: 2 })).toEqual({
      write: "hi",
      gapUnits: 0,
      reset: true,
      rendered: 2,
    });
  });

  it(
    "(2, {'cdef', 100}) -> 'cdef', gap 94 " +
      "[bite-proof: write text.slice(...) without the gap branch; the gap row fails]",
    () => {
      expect(applySnapshot(2, { text: "cdef", end: 100 })).toEqual({
        write: "cdef",
        gapUnits: 94,
        reset: false,
        rendered: 100,
      });
    },
  );
});

describe("parseSnapshot", () => {
  it("accepts a well-formed snapshot and returns exactly {text, end}", () => {
    const result = parseSnapshot({ text: "hi", end: 2, extra: "drop me" });
    expect(result).toEqual({ text: "hi", end: 2 });
    expect(Object.keys(result as object).sort()).toEqual(["end", "text"]);
  });

  it("rejects end < text.length", () => {
    expect(parseSnapshot({ text: "hello", end: 2 })).toBeUndefined();
  });

  it("rejects a negative end", () => {
    expect(parseSnapshot({ text: "", end: -1 })).toBeUndefined();
  });

  it("rejects a fractional end", () => {
    expect(parseSnapshot({ text: "", end: 1.5 })).toBeUndefined();
  });

  it("rejects missing fields", () => {
    expect(parseSnapshot({ text: "hi" })).toBeUndefined();
    expect(parseSnapshot({ end: 2 })).toBeUndefined();
  });

  it("rejects arrays and other non-objects", () => {
    expect(parseSnapshot(["hi", 2])).toBeUndefined();
    expect(parseSnapshot(null)).toBeUndefined();
    expect(parseSnapshot("hi")).toBeUndefined();
  });
});

describe("parseStreamChunk", () => {
  it("accepts a well-formed chunk keyed on sessionId and returns exactly {chunk, offset}", () => {
    const result = parseStreamChunk(
      { sessionId: "s1", chunk: "abc", offset: 3, extra: 1 },
      "sessionId",
      "s1",
    );
    expect(result).toEqual({ chunk: "abc", offset: 3 });
    expect(Object.keys(result as object).sort()).toEqual(["chunk", "offset"]);
  });

  it("rejects the wrong key value", () => {
    expect(
      parseStreamChunk({ sessionId: "s2", chunk: "abc", offset: 0 }, "sessionId", "s1"),
    ).toBeUndefined();
  });

  it("rejects a non-string key", () => {
    expect(
      parseStreamChunk({ sessionId: 1, chunk: "abc", offset: 0 }, "sessionId", "s1"),
    ).toBeUndefined();
  });

  it("rejects a missing offset", () => {
    expect(parseStreamChunk({ sessionId: "s1", chunk: "abc" }, "sessionId", "s1")).toBeUndefined();
  });

  it("rejects offset: -1 and offset: 1.5", () => {
    expect(
      parseStreamChunk({ sessionId: "s1", chunk: "abc", offset: -1 }, "sessionId", "s1"),
    ).toBeUndefined();
    expect(
      parseStreamChunk({ sessionId: "s1", chunk: "abc", offset: 1.5 }, "sessionId", "s1"),
    ).toBeUndefined();
  });
});

/** Strips the fixed dim-on/dim-off ANSI codes, leaving only the visible marker text. */
const ANSI_CODE = new RegExp(`${String.fromCharCode(0x1b)}\\[\\d+m`, "g");

function visible(marker: string): string {
  return marker.replace(ANSI_CODE, "").replace(/\r\n/g, "");
}

describe("gapMarker", () => {
  it("formats binary units with one decimal", () => {
    expect(gapMarker(1536)).toContain("1.5 KiB");
    expect(gapMarker(512)).toContain("512 B");
    expect(gapMarker(12_897_320)).toContain("12.3 MiB");
  });

  it("undefined has no digit in its visible text", () => {
    expect(visible(gapMarker(undefined))).not.toMatch(/\d/);
  });

  it("never contains an Arabic code point", () => {
    expect(gapMarker(1536)).not.toMatch(/[؀-ۿ]/);
    expect(gapMarker(undefined)).not.toMatch(/[؀-ۿ]/);
  });

  it("has no letters outside B, KiB and MiB in its visible text", () => {
    expect(visible(gapMarker(1536)).replace(/[^A-Za-z]/g, "")).toBe("KiB");
    expect(visible(gapMarker(512)).replace(/[^A-Za-z]/g, "")).toBe("B");
  });
});
