// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { currentView, setWorkspaceMode, showView } from "./views.js";

// Minimal harness, same shape as app.test.ts's: lay down the ids showView
// touches and nothing else.
function layout(): void {
  document.body.innerHTML = `
    <button id="nav-dashboard"></button>
    <button id="nav-changes"></button>
    <button id="nav-session"></button>
    <button id="nav-workspace"></button>
    <div id="view-dashboard"></div>
    <div id="view-changes" hidden></div>
    <div id="view-session" hidden></div>
    <div id="view-workspace" hidden></div>`;
}

type Call = boolean;

function stubBridge(): Call[] {
  const calls: Call[] = [];
  (globalThis as unknown as { window: Window }).window.jarvis = {
    setWorkspaceVisible: (visible: boolean) => {
      calls.push(visible);
      return Promise.resolve();
    },
  } as never;
  return calls;
}

describe("showView", () => {
  beforeEach(() => {
    layout();
    setWorkspaceMode("browser");
  });

  it("shows only the named view", () => {
    stubBridge();

    showView("workspace");

    expect(document.getElementById("view-workspace")?.hasAttribute("hidden")).toBe(false);
    expect(document.getElementById("view-dashboard")?.hasAttribute("hidden")).toBe(true);
    expect(document.getElementById("view-changes")?.hasAttribute("hidden")).toBe(true);
    expect(document.getElementById("view-session")?.hasAttribute("hidden")).toBe(true);
  });

  it("marks the matching nav button as current", () => {
    stubBridge();

    showView("workspace");

    expect(document.getElementById("nav-workspace")?.classList.contains("nav-btn--on")).toBe(true);
    expect(document.getElementById("nav-dashboard")?.classList.contains("nav-btn--on")).toBe(false);
  });

  it("reports the current view", () => {
    stubBridge();
    showView("changes");

    expect(currentView()).toBe("changes");
  });

  // The trap: a hosted view is a native overlay. Hiding #view-workspace does
  // nothing to it, so every route change must say so explicitly.
  it("shows the hosted view when entering the Workspace in browser mode", () => {
    const calls = stubBridge();

    showView("workspace");

    expect(calls.at(-1)).toBe(true);
  });

  it("hides the hosted view when leaving the Workspace", () => {
    const calls = stubBridge();
    showView("workspace");

    showView("dashboard");

    expect(calls.at(-1)).toBe(false);
  });

  it("tells main on every route change, not only the workspace ones", () => {
    const calls = stubBridge();

    showView("changes");
    showView("session");

    expect(calls).toEqual([false, false]);
  });

  // A markdown document is DOM in the renderer; the overlay would cover it.
  it("hides the hosted view in docs mode even inside the Workspace", () => {
    const calls = stubBridge();
    showView("workspace");
    calls.length = 0;

    setWorkspaceMode("docs");

    expect(calls.at(-1)).toBe(false);
  });

  it("shows the hosted view again when browser mode returns", () => {
    const calls = stubBridge();
    showView("workspace");
    setWorkspaceMode("docs");
    calls.length = 0;

    setWorkspaceMode("browser");

    expect(calls.at(-1)).toBe(true);
  });

  it("does not ask for the hosted view while another route is showing", () => {
    const calls = stubBridge();
    showView("dashboard");
    calls.length = 0;

    setWorkspaceMode("browser");

    expect(calls.at(-1)).toBe(false);
  });

  // app.test.ts's harness does not stub the bridge, and a missing view
  // element is normal in the smaller harnesses.
  it("works with no bridge and a partial DOM", () => {
    document.body.innerHTML = `<div id="view-dashboard"></div><div id="view-changes" hidden></div>`;
    (globalThis as unknown as { window: Window }).window.jarvis = undefined as never;

    expect(() => showView("dashboard")).not.toThrow();
  });
});
