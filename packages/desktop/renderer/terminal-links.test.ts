// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTerminalLink, setTerminalLinksInternal } from "./terminal-links.js";

describe("openTerminalLink", () => {
  const openTab = vi.fn(async () => {});
  const plansOpenLink = vi.fn(async () => {});

  beforeEach(() => {
    openTab.mockClear();
    plansOpenLink.mockClear();
    (globalThis as unknown as { window: Window }).window.jarvis = {
      openTab,
      plansOpenLink,
    } as unknown as Window["jarvis"];
  });

  afterEach(() => {
    setTerminalLinksInternal(true);
  });

  it("opens a Workspace tab in the terminal's project by default", () => {
    openTerminalLink("demo", "https://www.google.com");
    expect(openTab).toHaveBeenCalledWith("demo", "https://www.google.com");
    expect(plansOpenLink).not.toHaveBeenCalled();
  });

  it("hands the link to the system browser when switched off", () => {
    setTerminalLinksInternal(false);
    openTerminalLink("demo", "https://www.google.com");
    expect(plansOpenLink).toHaveBeenCalledWith("https://www.google.com");
    expect(openTab).not.toHaveBeenCalled();
  });

  it("goes back to Workspace tabs when switched on again", () => {
    setTerminalLinksInternal(false);
    setTerminalLinksInternal(true);
    openTerminalLink("demo", "https://example.com/");
    expect(openTab).toHaveBeenCalledWith("demo", "https://example.com/");
    expect(plansOpenLink).not.toHaveBeenCalled();
  });
});
