import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ChannelPolicy,
  dropHead,
  isKeyedPolicy,
  isSubscriptionKey,
  utf8Bytes,
} from "./policy.js";

describe("isKeyedPolicy", () => {
  it.each<[string, ChannelPolicy, boolean]>([
    [
      "stream",
      {
        kind: "stream",
        maxBytes: 1,
        keyOf: () => undefined,
        chunkOf: () => "",
        offsetOf: () => undefined,
        withChunk: (payload) => payload,
      },
      true,
    ],
    ["reliable with keyOf", { kind: "reliable", keyOf: () => undefined }, true],
    ["reliable without keyOf", { kind: "reliable" }, false],
    ["latest", { kind: "latest" }, false],
  ])("is %s for %s", (_label, policy, expected) => {
    expect(isKeyedPolicy(policy)).toBe(expected);
  });
});

describe("isSubscriptionKey", () => {
  it.each<string>(["tab-1", "tab-1:p2", "550e8400-e29b-41d4-a716-446655440000", "a".repeat(128)])(
    "accepts %j",
    (value) => {
      expect(isSubscriptionKey(value)).toBe(true);
    },
  );

  it.each<unknown>(["", "a".repeat(129), "a b", "../x", "a/b", "é", 42])("refuses %j", (value) => {
    expect(isSubscriptionKey(value)).toBe(false);
  });
});

describe("utf8Bytes", () => {
  it("is Buffer.byteLength(text, 'utf8')", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("\u{1F600}")).toBe(4);
  });
});

describe("policy.ts source", () => {
  it("names no desktop channel — channel names never enter @jarvis/remote", () => {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), "policy.ts");
    const source = readFileSync(path, "utf8");
    for (const prefix of ["terminal:", "session:", "docker:", "metrics:"]) {
      expect(source.includes(prefix)).toBe(false);
    }
  });
});

describe("dropHead", () => {
  it("drops whole code points from the head, by byte count", () => {
    expect(dropHead("abcdef", 2)).toEqual({ rest: "cdef", droppedBytes: 2, droppedUnits: 2 });
  });

  it("counts a 2-byte code point (é) correctly", () => {
    expect(dropHead("é€\u{1F600}x", 1)).toEqual({
      rest: "€\u{1F600}x",
      droppedBytes: 2,
      droppedUnits: 1,
    });
  });

  it("counts a 3-byte code point (€) correctly, after the 2-byte one", () => {
    expect(dropHead("é€\u{1F600}x", 3)).toEqual({
      rest: "\u{1F600}x",
      droppedBytes: 5,
      droppedUnits: 2,
    });
  });

  it(
    "drops a full surrogate-pair code point rather than slicing by UTF-16 unit " +
      "[bite-proof: slice by UTF-16 unit instead of code point; the emoji row leaves a lone surrogate]",
    () => {
      expect(dropHead("\u{1F600}x", 1)).toEqual({ rest: "x", droppedBytes: 4, droppedUnits: 2 });
    },
  );

  it("minBytes <= 0 removes nothing", () => {
    expect(dropHead("abc", 0)).toEqual({ rest: "abc", droppedBytes: 0, droppedUnits: 0 });
  });

  it("minBytes >= utf8Bytes(text) removes everything", () => {
    expect(dropHead("abc", 99)).toEqual({ rest: "", droppedBytes: 3, droppedUnits: 3 });
  });

  it("NaN or non-finite minBytes removes nothing [bite-proof: compare minBytes without a finiteness guard]", () => {
    expect(dropHead("abc", Number.NaN)).toEqual({ rest: "abc", droppedBytes: 0, droppedUnits: 0 });
    expect(dropHead("abc", Number.POSITIVE_INFINITY)).toEqual({
      rest: "abc",
      droppedBytes: 0,
      droppedUnits: 0,
    });
    expect(dropHead("abc", Number.NEGATIVE_INFINITY)).toEqual({
      rest: "abc",
      droppedBytes: 0,
      droppedUnits: 0,
    });
  });

  it(
    "property: utf8Bytes(rest) + droppedBytes === utf8Bytes(text), and rest is well-formed, " +
      "over random strings (fixed seed)",
    () => {
      // A small xorshift PRNG rather than Math.random(), so a failure is
      // reproducible from the seed alone.
      let state = 0x2f6e2b1;
      const next = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state;
      };
      const alphabet = [
        "a",
        "b",
        "é", // 2-byte
        "€", // 3-byte
        "\u{1F600}", // 4-byte (surrogate pair)
        "\uD800", // lone high surrogate
        "\uDC00", // lone low surrogate
      ];
      for (let trial = 0; trial < 500; trial++) {
        const length = next() % 8;
        let text = "";
        for (let i = 0; i < length; i++) {
          text += alphabet[next() % alphabet.length];
        }
        const total = utf8Bytes(text);
        const minBytes = (next() % (total + 2)) - 1; // includes <=0 and >=total cases
        const { rest, droppedBytes, droppedUnits } = dropHead(text, minBytes);
        expect(utf8Bytes(rest) + droppedBytes).toBe(total);
        expect(text.slice(droppedUnits)).toBe(rest);
        // The bound: at least min(minBytes, total) bytes were dropped —
        // dropHead never falls short of what was asked for (or of the
        // whole text, when minBytes overshoots it).
        expect(droppedBytes).toBeGreaterThanOrEqual(Math.min(Math.max(minBytes, 0), total));
        // Minimality: dropping one code point fewer would leave fewer than
        // minBytes dropped — the cut is the smallest unit-aligned one that
        // satisfies the bound, not an arbitrary larger one.
        if (droppedUnits > 0 && minBytes > 0) {
          const lastDroppedCodePoint = [...text.slice(0, droppedUnits)].at(-1) as string;
          const bytesWithoutLast = droppedBytes - utf8Bytes(lastDroppedCodePoint);
          expect(bytesWithoutLast).toBeLessThan(minBytes);
        }
        // `rest` is well-formed: the cut never lands strictly between the
        // two halves of a valid surrogate pair present in the original text.
        for (let i = 0; i < text.length - 1; i++) {
          const hi = text.charCodeAt(i);
          const lo = text.charCodeAt(i + 1);
          const isPair = hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
          if (isPair) expect(droppedUnits).not.toBe(i + 1);
        }
      }
    },
  );
});
