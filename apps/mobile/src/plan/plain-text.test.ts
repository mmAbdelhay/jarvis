import { describe, expect, it } from "vitest";
import { planBlockPlainText } from "./plain-text";

describe("planBlockPlainText", () => {
  it("strips common markdown markers, fence lines, and collapses whitespace", () => {
    const source = [
      "# **Heading**",
      "- `first` item",
      "> second _item_",
      "```ts",
      "const value = *important*",
      "```",
    ].join("\n");

    expect(planBlockPlainText(source)).toBe(
      "Heading first item second item const value = important",
    );
  });

  it("slices the normalized plain text to 120 characters", () => {
    expect(planBlockPlainText(`**${"a".repeat(130)}**`)).toBe("a".repeat(120));
  });
});
