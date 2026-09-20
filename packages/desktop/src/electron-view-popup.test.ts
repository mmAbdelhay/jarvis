// A source assertion, because electron-view.ts imports electron and cannot be
// loaded in a Node test. What it guards was found only by running the app.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./electron-view.ts", import.meta.url)), "utf8");

describe("popup windows", () => {
  // Parented to the full-screen main window, a popup made macOS hide that
  // window and never show it again once the popup closed — a black screen
  // after every sign-in popup.
  it("are not children of the main window", () => {
    const start = source.indexOf("const popupPolicy");
    const end = source.indexOf("return (partition, kind)");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).not.toMatch(/\bparent\s*:/);
  });
});
