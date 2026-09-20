import { describe, expect, test } from "vitest";
import { keyboardAvoidingBehavior, keyboardBottomPadding } from "./keyboard-offset";

describe("keyboardAvoidingBehavior", () => {
  test("iOS keeps KeyboardAvoidingView's padding behavior", () => {
    expect(keyboardAvoidingBehavior("ios")).toBe("padding");
  });

  test("Android gets no behavior at all — the screen pads itself [bite-proof: give Android any behavior and RN composes its own paddingBottom over the screen's]", () => {
    expect(keyboardAvoidingBehavior("android")).toBeUndefined();
  });
});

describe("keyboardBottomPadding", () => {
  test("Android: RN's reported keyboard height plus the bottom safe-area inset — the Galaxy S23 Ultra measurement (278.4 + 14.9 = the 293.3 dp the IME covered)", () => {
    expect(keyboardBottomPadding("android", 278.4, 14.9)).toBeCloseTo(293.3, 5);
  });

  test("Android: zero while the keyboard is hidden, whatever the inset", () => {
    expect(keyboardBottomPadding("android", 0, 14.9)).toBe(0);
  });

  test("iOS: always zero — the KeyboardAvoidingView does the work there", () => {
    expect(keyboardBottomPadding("ios", 336, 34)).toBe(0);
  });

  test("never negative or NaN: bad inputs count as zero", () => {
    expect(keyboardBottomPadding("android", -5, 14.9)).toBe(0);
    expect(keyboardBottomPadding("android", Number.NaN, 14.9)).toBe(0);
    expect(keyboardBottomPadding("android", 278.4, Number.NaN)).toBeCloseTo(278.4, 5);
    expect(keyboardBottomPadding("android", 278.4, -3)).toBeCloseTo(278.4, 5);
  });
});
