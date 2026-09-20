import { describe, expect, it } from "vitest";
import { MAX_TURNS_SHOWN, type TurnView, mergeTurns, parseTurn, parseTurnList } from "./turns";

const TURN_ID = "a".repeat(32);

const VALID: Record<string, unknown> = {
  role: "assistant",
  text: "hello",
  language: "en",
  at: 1_000,
  replyTo: TURN_ID,
  sessionId: "s1",
};

describe("parseTurn", () => {
  it("round-trips a valid turn", () => {
    expect(parseTurn(VALID)).toEqual<TurnView>({
      role: "assistant",
      text: "hello",
      language: "en",
      at: 1_000,
      replyTo: TURN_ID,
      sessionId: "s1",
    });
  });

  // [bite-proof: copy `replyTo` unchecked] — if parseTurn spread `raw` or
  // copied `raw.replyTo` without validating it against TURN_ID_PATTERN
  // first, this malformed value would leak through instead of being
  // dropped while the rest of the turn is kept.
  it("drops a malformed replyTo while keeping the turn", () => {
    const turn = parseTurn({ ...VALID, replyTo: "not-a-turn-id" });
    expect(turn).toBeDefined();
    expect(turn?.replyTo).toBeUndefined();
    expect(turn?.text).toBe("hello");
  });

  it("drops a malformed sessionId while keeping the turn", () => {
    const turn = parseTurn({ ...VALID, sessionId: "" });
    expect(turn).toBeDefined();
    expect(turn?.sessionId).toBeUndefined();
  });

  it("rejects an unknown language", () => {
    expect(parseTurn({ ...VALID, language: "fr" })).toBeUndefined();
  });

  it("rejects an unknown role", () => {
    expect(parseTurn({ ...VALID, role: "system" })).toBeUndefined();
  });

  it("rejects a non-string text", () => {
    expect(parseTurn({ ...VALID, text: 42 })).toBeUndefined();
  });

  it("rejects a non-finite at", () => {
    expect(parseTurn({ ...VALID, at: Number.NaN })).toBeUndefined();
  });

  it("rejects a non-object payload", () => {
    expect(parseTurn(null)).toBeUndefined();
    expect(parseTurn("hello")).toBeUndefined();
    expect(parseTurn([VALID])).toBeUndefined();
  });

  it("does not copy extra keys", () => {
    const turn = parseTurn({ ...VALID, extra: "leak" }) as unknown as Record<string, unknown>;
    expect(Object.hasOwn(turn, "extra")).toBe(false);
  });
});

describe("parseTurnList", () => {
  it("skips invalid items and keeps valid ones", () => {
    const list = parseTurnList([VALID, { role: "nope" }, null, VALID]);
    expect(list).toHaveLength(2);
  });

  it("returns [] for a non-array", () => {
    expect(parseTurnList("not an array")).toEqual([]);
    expect(parseTurnList(undefined)).toEqual([]);
  });
});

describe("mergeTurns", () => {
  function turn(at: number, overrides: Partial<TurnView> = {}): TurnView {
    return { role: "user", text: `t${at}`, language: "en", at, ...overrides };
  }

  it("removes duplicates by (role, at, text, replyTo)", () => {
    const a = turn(1);
    const merged = mergeTurns([a], [{ ...a }]);
    expect(merged).toHaveLength(1);
  });

  it("sorts the result by at ascending", () => {
    const merged = mergeTurns([turn(3), turn(1)], [turn(2)]);
    expect(merged.map((t) => t.at)).toEqual([1, 2, 3]);
  });

  it("keeps only the last MAX_TURNS_SHOWN of 60 inputs", () => {
    const inputs = Array.from({ length: 60 }, (_, i) => turn(i));
    const merged = mergeTurns([], inputs);
    expect(merged).toHaveLength(MAX_TURNS_SHOWN);
    expect(merged[0]?.at).toBe(10);
    expect(merged.at(-1)?.at).toBe(59);
  });

  it("an incoming turn replaces a current one with the same key", () => {
    const original = turn(1, { text: "first" });
    const replacement: TurnView = { ...original, text: "first" };
    const merged = mergeTurns([original], [replacement]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(replacement);
  });
});
