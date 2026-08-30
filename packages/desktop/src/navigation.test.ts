import { describe, expect, it } from "vitest";
import { isAllowedNavigation } from "./navigation.js";

describe("isAllowedNavigation", () => {
  const local = "file:///Users/you/jarvis/renderer/index.html";

  it("allows navigation to the loaded local file", () => {
    expect(isAllowedNavigation(local, local)).toBe(true);
  });

  it("blocks navigation to a remote URL injected via rendered agent output", () => {
    expect(isAllowedNavigation("https://evil.example/", local)).toBe(false);
  });

  it("blocks navigation to a different local file", () => {
    expect(isAllowedNavigation("file:///etc/passwd", local)).toBe(false);
  });
});
