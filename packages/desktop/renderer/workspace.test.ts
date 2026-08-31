// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceState } from "@jarvis/core";
import { initWorkspace, renderWorkspace, reportWorkspaceBounds } from "./workspace.js";

type Recorded = { call: string; args: unknown[] };

function harness(): Recorded[] {
  document.body.innerHTML = `
    <button id="nav-workspace"></button>
    <div id="view-workspace">
      <select id="workspace-project"></select>
      <button id="workspace-mode-browser"></button>
      <button id="workspace-mode-docs"></button>
      <div id="workspace-browser">
        <div id="workspace-tabs"></div>
        <button id="workspace-back"></button>
        <button id="workspace-forward"></button>
        <button id="workspace-reload"></button>
        <input id="workspace-address" />
        <button id="workspace-new-tab"></button>
        <div id="workspace-error" hidden></div>
        <div id="workspace-page"></div>
      </div>
      <div id="workspace-docs" hidden>
        <div id="workspace-doc-list"></div>
        <div id="workspace-doc-title"></div>
        <div id="workspace-doc-body"></div>
      </div>
    </div>`;

  const calls: Recorded[] = [];
  const record =
    (call: string) =>
    (...args: unknown[]) => {
      calls.push({ call, args });
      return Promise.resolve();
    };
  (window as unknown as { jarvis: unknown }).jarvis = {
    openTab: record("openTab"),
    closeTab: record("closeTab"),
    activateTab: record("activateTab"),
    navigateTab: record("navigateTab"),
    tabBack: record("tabBack"),
    tabForward: record("tabForward"),
    tabReload: record("tabReload"),
    setWorkspaceBounds: record("setWorkspaceBounds"),
    setWorkspaceVisible: record("setWorkspaceVisible"),
    listDocs: () => Promise.resolve({ ok: true, value: [] }),
    readDoc: () => Promise.resolve({ ok: true, value: [] }),
  };
  return calls;
}

function tab(overrides: Partial<WorkspaceState["tabs"][number]> = {}) {
  return {
    id: "tab-1",
    project: "acme",
    url: "https://github.com",
    title: "GitHub",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: undefined,
    ...overrides,
  };
}

describe("workspace chrome", () => {
  let calls: Recorded[];

  beforeEach(() => {
    calls = harness();
    initWorkspace(["acme", "storefront"]);
  });

  it("fills the project selector from the configured projects", () => {
    const options = [...document.querySelectorAll("#workspace-project option")].map(
      (option) => option.textContent,
    );
    expect(options).toEqual(["acme", "storefront"]);
  });

  it("draws one element per tab", () => {
    renderWorkspace({ tabs: [tab(), tab({ id: "tab-2", title: "Docs" })], activeTabId: "tab-1" });

    expect(document.querySelectorAll("#workspace-tabs .workspace-tab")).toHaveLength(2);
  });

  it("shows the page title, falling back to the URL before one arrives", () => {
    renderWorkspace({ tabs: [tab({ title: "" })], activeTabId: "tab-1" });

    expect(document.querySelector(".workspace-tab-title")?.textContent).toBe("https://github.com");
  });

  // A page title is attacker-controlled text in the privileged renderer.
  it("renders a title as text, never as markup", () => {
    renderWorkspace({ tabs: [tab({ title: "<img src=x onerror=alert(1)>" })], activeTabId: "tab-1" });

    expect(document.querySelector("#workspace-tabs img")).toBeNull();
    expect(document.querySelector(".workspace-tab-title")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });

  it("marks the active tab", () => {
    renderWorkspace({ tabs: [tab(), tab({ id: "tab-2" })], activeTabId: "tab-2" });

    const marked = [...document.querySelectorAll(".workspace-tab")].map((element) =>
      element.classList.contains("workspace-tab--on"),
    );
    expect(marked).toEqual([false, true]);
  });

  it("puts the active tab's URL in the address bar", () => {
    renderWorkspace({ tabs: [tab({ url: "https://example.com/a" })], activeTabId: "tab-1" });

    expect((document.getElementById("workspace-address") as HTMLInputElement).value).toBe(
      "https://example.com/a",
    );
  });

  // Retyping the user's half-finished input from under them is the classic
  // address-bar bug.
  it("leaves the address bar alone while it is focused", () => {
    const address = document.getElementById("workspace-address") as HTMLInputElement;
    address.value = "half-typed";
    address.focus();

    renderWorkspace({ tabs: [tab({ url: "https://example.com/a" })], activeTabId: "tab-1" });

    expect(address.value).toBe("half-typed");
  });

  it("disables back and forward when there is no history", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });

    expect((document.getElementById("workspace-back") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("workspace-forward") as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables back when the page has history", () => {
    renderWorkspace({ tabs: [tab({ canGoBack: true })], activeTabId: "tab-1" });

    expect((document.getElementById("workspace-back") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a failed load's detail and hides it once the tab recovers", () => {
    renderWorkspace({ tabs: [tab({ error: "ERR_NAME_NOT_RESOLVED" })], activeTabId: "tab-1" });
    const banner = document.getElementById("workspace-error") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("ERR_NAME_NOT_RESOLVED");

    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });

    expect(banner.hidden).toBe(true);
  });

  it("opens a tab in the selected project when the address bar is submitted", () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });
    const address = document.getElementById("workspace-address") as HTMLInputElement;
    address.value = "github.com";

    address.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(calls).toContainEqual({ call: "openTab", args: ["acme", "github.com"] });
  });

  it("navigates the active tab instead of opening another one", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    const address = document.getElementById("workspace-address") as HTMLInputElement;
    address.value = "example.com";

    address.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(calls).toContainEqual({ call: "navigateTab", args: ["tab-1", "example.com"] });
  });

  it("activates a tab when it is clicked", () => {
    renderWorkspace({ tabs: [tab(), tab({ id: "tab-2" })], activeTabId: "tab-1" });

    document.querySelectorAll<HTMLElement>(".workspace-tab")[1]?.click();

    expect(calls).toContainEqual({ call: "activateTab", args: ["tab-2"] });
  });

  it("closes a tab from its close control without activating it", () => {
    renderWorkspace({ tabs: [tab(), tab({ id: "tab-2" })], activeTabId: "tab-1" });

    document.querySelectorAll<HTMLElement>(".workspace-tab-close")[1]?.click();

    expect(calls).toContainEqual({ call: "closeTab", args: ["tab-2"] });
    expect(calls.some((entry) => entry.call === "activateTab")).toBe(false);
  });

  it("sends back, forward and reload for the active tab", () => {
    renderWorkspace({ tabs: [tab({ canGoBack: true, canGoForward: true })], activeTabId: "tab-1" });

    document.getElementById("workspace-back")?.click();
    document.getElementById("workspace-forward")?.click();
    document.getElementById("workspace-reload")?.click();

    expect(calls).toContainEqual({ call: "tabBack", args: ["tab-1"] });
    expect(calls).toContainEqual({ call: "tabForward", args: ["tab-1"] });
    expect(calls).toContainEqual({ call: "tabReload", args: ["tab-1"] });
  });

  // The overlay is positioned in window pixels; the renderer is the only
  // side that knows where the layout put the slot.
  it("reports the page slot's rectangle to main", () => {
    const page = document.getElementById("workspace-page") as HTMLElement;
    page.getBoundingClientRect = () =>
      ({ x: 12, y: 140, width: 900, height: 600 }) as DOMRect;

    reportWorkspaceBounds();

    expect(calls).toContainEqual({
      call: "setWorkspaceBounds",
      args: [{ x: 12, y: 140, width: 900, height: 600 }],
    });
  });

  it("rounds a fractional rectangle to whole pixels", () => {
    const page = document.getElementById("workspace-page") as HTMLElement;
    page.getBoundingClientRect = () =>
      ({ x: 12.4, y: 140.6, width: 900.5, height: 600.2 }) as DOMRect;

    reportWorkspaceBounds();

    expect(calls).toContainEqual({
      call: "setWorkspaceBounds",
      args: [{ x: 12, y: 141, width: 901, height: 600 }],
    });
  });

  it("lists a project's documents when docs mode opens", async () => {
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis.listDocs = () =>
      Promise.resolve({ ok: true, value: [{ path: "docs/plan.md", name: "plan.md" }] });

    document.getElementById("workspace-mode-docs")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector(".workspace-doc-item")?.textContent).toBe("docs/plan.md");
  });

  it("shows a localised error when the project's docs cannot be listed", async () => {
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis.listDocs = () =>
      Promise.resolve({ ok: false, text: "Could not open that document.", language: "en" });

    document.getElementById("workspace-mode-docs")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById("workspace-doc-body")?.textContent).toContain(
      "Could not open that document.",
    );
  });
});
