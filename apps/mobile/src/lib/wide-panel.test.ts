import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { theme } from "./theme";
import { authCardContentTop, authCardFrame, panelTitle, widePanelFrame } from "./wide-panel";

describe("widePanelFrame", () => {
  it("clamps a wide page to the desktop's 1180 measure, framed as a panel", () => {
    expect(widePanelFrame("wide")).toEqual({ maxWidth: 1180, framed: true });
  });

  it("leaves a phone page full width and unframed", () => {
    expect(widePanelFrame("phone")).toEqual({ maxWidth: undefined, framed: false });
  });
});

describe("authCardFrame", () => {
  it("draws unlock/pair as a 480-wide card on a wide screen that scrolls when taller than the window", () => {
    expect(authCardFrame("wide")).toEqual({ maxWidth: 480, framed: true, scrolls: true });
  });

  it("leaves unlock/pair full screen and unscrolled (as before) on a phone", () => {
    expect(authCardFrame("phone")).toEqual({ maxWidth: undefined, framed: false, scrolls: false });
  });
});

describe("authCardContentTop", () => {
  it("keeps the phone's safe-area top padding on a phone", () => {
    expect(authCardContentTop("phone", 47 + 48)).toBe(95);
  });

  it("uses one theme step inside the card on a wide screen (no status bar above a card)", () => {
    expect(authCardContentTop("wide", 47 + 48)).toBe(theme.spacing.xl);
  });
});

describe("panelTitle", () => {
  it("prefers the title the page sets (a transcript's session summary)", () => {
    expect(panelTitle("Transcript", "Fix the login bug")).toBe("Fix the login bug");
  });

  it("falls back to the route's title until the page sets one", () => {
    expect(panelTitle("Transcript", undefined)).toBe("Transcript");
  });
});

describe("WidePanel.tsx styles", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../components/WidePanel.tsx"),
    "utf8",
  );
  const styles = source.slice(source.indexOf("StyleSheet.create("));
  it("size everything from theme tokens (only hairline 1s and flex 0/1 are literal)", () => {
    const literals = [...styles.matchAll(/(\w+):\s*(\d+)\b/g)]
      .filter(([, key, value]) => !(/^(flex|flexGrow|flexShrink)$/.test(key) && Number(value) <= 1))
      .filter(([, key, value]) => !(/(Width)$/.test(key) && value === "1"))
      .map(([match]) => match);
    expect(literals).toEqual([]);
  });
});
