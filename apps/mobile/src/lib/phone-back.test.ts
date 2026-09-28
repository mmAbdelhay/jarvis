import { describe, expect, it, vi } from "vitest";
import { phoneBackHandler, phoneBackListens } from "./phone-back";

describe("phoneBackHandler (Android hardware Back on an inherited selection)", () => {
  it("clears the inherited selection and consumes the press while the back chip shows", () => {
    const clear = vi.fn();
    expect(phoneBackHandler(true, clear)()).toBe(true);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("leaves Back to the navigator when there is no inherited selection", () => {
    const clear = vi.fn();
    expect(phoneBackHandler(false, clear)()).toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });
});

describe("phoneBackListens", () => {
  it("listens only on Android (web's BackHandler logs an error; iOS has no Back key)", () => {
    expect(phoneBackListens("android", true)).toBe(true);
    expect(phoneBackListens("web", true)).toBe(false);
    expect(phoneBackListens("ios", true)).toBe(false);
  });

  it("does not listen without an inherited selection", () => {
    expect(phoneBackListens("android", false)).toBe(false);
  });
});
