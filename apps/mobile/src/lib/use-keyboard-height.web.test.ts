import { describe, expect, it } from "vitest";
import { useKeyboardHeight } from "./use-keyboard-height.web";

describe("useKeyboardHeight (browser build)", () => {
  it("is 0 without touching react-native's Keyboard (D2)", () => {
    expect(useKeyboardHeight()).toBe(0);
  });
});
