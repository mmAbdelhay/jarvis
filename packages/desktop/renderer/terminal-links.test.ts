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

  it("asks main to show the main window after the tab opens", async () => {
    const popoutShowMain = vi.fn(async () => {});
    (window.jarvis as unknown as Record<string, unknown>)["popoutShowMain"] = popoutShowMain;
    openTerminalLink("demo", "https://example.com/");
    expect(popoutShowMain).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(popoutShowMain).toHaveBeenCalledTimes(1);
    expect(plansOpenLink).not.toHaveBeenCalled();
  });

  it("goes back to Workspace tabs when switched on again", () => {
    setTerminalLinksInternal(false);
    setTerminalLinksInternal(true);
    openTerminalLink("demo", "https://example.com/");
    expect(openTab).toHaveBeenCalledWith("demo", "https://example.com/");
    expect(plansOpenLink).not.toHaveBeenCalled();
  });
});

describe("openTerminalLink fallbacks", () => {
  const plansOpenLink = vi.fn(async () => {});
  const setJarvis = (openTab: unknown): void => {
    (globalThis as unknown as { window: Window }).window.jarvis = {
      openTab,
      plansOpenLink,
    } as unknown as Window["jarvis"];
  };
  beforeEach(() => plansOpenLink.mockClear());
  afterEach(() => setTerminalLinksInternal(true));

  it("falls back to the system browser when openTab rejects", async () => {
    setJarvis(vi.fn(async () => Promise.reject(new Error("no window"))));
    openTerminalLink("demo", "https://example.com/");
    await new Promise((r) => setTimeout(r, 0));
    expect(plansOpenLink).toHaveBeenCalledWith("https://example.com/");
  });

  it("falls back when openTab throws synchronously", () => {
    setJarvis(
      vi.fn(() => {
        throw new Error("boom");
      }),
    );
    openTerminalLink("demo", "https://example.com/");
    expect(plansOpenLink).toHaveBeenCalledWith("https://example.com/");
  });

  it("falls back when there is no project", () => {
    const openTab = vi.fn(async () => {});
    setJarvis(openTab);
    openTerminalLink(undefined, "https://example.com/");
    openTerminalLink("", "https://example.com/");
    expect(openTab).not.toHaveBeenCalled();
    expect(plansOpenLink).toHaveBeenCalledTimes(2);
  });
});
