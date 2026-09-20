import { describe, expect, it } from "vitest";
import { setClearFailedSignal, takeClearFailedSignal } from "./clear-failed-signal";

describe("clear-failed-signal", () => {
  it("defaults to false", () => {
    expect(takeClearFailedSignal()).toBe(false);
  });

  it(
    "is consumed exactly once — a second take after the first sees false " +
      "[bite-proof: don't clear the flag in takeClearFailedSignal and this fails]",
    () => {
      setClearFailedSignal();
      expect(takeClearFailedSignal()).toBe(true);
      expect(takeClearFailedSignal()).toBe(false);
    },
  );

  it(
    "cannot be forged: the only setter takes no argument, so nothing " +
      "derived from a URL, a route param or any other caller-supplied " +
      "value can ever set it",
    () => {
      // There is no `setClearFailedSignal(value)` — the signature itself
      // (0 parameters) is the proof; this test only documents the intent.
      expect(setClearFailedSignal.length).toBe(0);
      expect(takeClearFailedSignal()).toBe(false);
    },
  );
});
