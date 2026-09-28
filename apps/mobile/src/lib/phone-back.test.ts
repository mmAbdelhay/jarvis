import { describe, expect, it, vi } from "vitest";
import { phoneBackHandler } from "./phone-back";

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
