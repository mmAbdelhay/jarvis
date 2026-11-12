import { describe, expect, it } from "vitest";
import { setClearFailedSignal, takeClearFailedSignal } from "./clear-failed-signal";

describe("clear-failed-signal", () => {
  it("defaults to nothing", () => {
    expect(takeClearFailedSignal()).toBeUndefined();
  });

  it("round-trips the machine's id", () => {
    setClearFailedSignal("a_1");
    expect(takeClearFailedSignal()).toEqual({ id: "a_1" });
  });

  it("round-trips the null scope, which is not the same as no signal", () => {
    setClearFailedSignal(null);
    expect(takeClearFailedSignal()).toEqual({ id: null });
    expect(takeClearFailedSignal()).toBeUndefined();
  });

  it(
    "is consumed exactly once — a second take after the first sees nothing " +
      "[bite-proof: don't clear the flag in takeClearFailedSignal and this fails]",
    () => {
      setClearFailedSignal("a_1");
      expect(takeClearFailedSignal()).toEqual({ id: "a_1" });
      expect(takeClearFailedSignal()).toBeUndefined();
    },
  );
});
