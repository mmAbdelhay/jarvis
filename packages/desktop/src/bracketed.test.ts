import { describe, expect, it } from "vitest";
import { bracketedSubmit } from "./bracketed.js";

describe("bracketedSubmit", () => {
  it("wraps a single-line comment in bracketed paste, unlike submitBytes", () => {
    expect(bracketedSubmit("looks good")).toBe("\u001b[200~looks good\u001b[201~\r");
  });

  it("wraps multi-line feedback the same way", () => {
    expect(bracketedSubmit('Comments on plan.md:\n\n1. On "x": fix it')).toBe(
      '\u001b[200~Comments on plan.md:\n\n1. On "x": fix it\u001b[201~\r',
    );
  });

  it("wraps empty text too — always exactly one Enter", () => {
    expect(bracketedSubmit("")).toBe("\u001b[200~\u001b[201~\r");
  });
});
