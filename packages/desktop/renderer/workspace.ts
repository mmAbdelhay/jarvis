import type { WorkspaceState, WorkspaceTab } from "@jarvis/core";
import { setWorkspaceMode } from "./views.js";

// The Workspace's chrome. Everything a page can influence — its title, its
// URL, a load error — is attacker-controlled text arriving in the process
// that holds window.jarvis, so this file builds nodes and sets textContent.
// No innerHTML, for the same reason changes.ts has none.

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

let latest: WorkspaceState = { tabs: [], activeTabId: undefined };

function activeTab(): WorkspaceTab | undefined {
  return latest.tabs.find((tab) => tab.id === latest.activeTabId);
}

function selectedProject(): string {
  return ($("workspace-project") as HTMLSelectElement).value;
}

export function initWorkspace(projects: string[]): void {
  const select = $("workspace-project") as HTMLSelectElement;
  select.replaceChildren();
  for (const project of projects) {
    const option = document.createElement("option");
    option.value = project;
    option.textContent = project;
    select.append(option);
  }

  const address = $("workspace-address") as HTMLInputElement;
  address.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const input = address.value.trim();
    if (input === "") return;
    const tab = activeTab();
    // Enter on an open tab is a navigation; with nothing open it is a new
    // tab in whichever project the selector shows.
    if (tab === undefined) void window.jarvis.openTab(selectedProject(), input);
    else void window.jarvis.navigateTab(tab.id, input);
    address.blur();
  });

  $("workspace-new-tab").addEventListener("click", () => {
    void window.jarvis.openTab(selectedProject(), "");
  });
  $("workspace-back").addEventListener("click", () => {
    const tab = activeTab();
    if (tab !== undefined) void window.jarvis.tabBack(tab.id);
  });
  $("workspace-forward").addEventListener("click", () => {
    const tab = activeTab();
    if (tab !== undefined) void window.jarvis.tabForward(tab.id);
  });
  $("workspace-reload").addEventListener("click", () => {
    const tab = activeTab();
    if (tab !== undefined) void window.jarvis.tabReload(tab.id);
  });

  $("workspace-mode-browser").addEventListener("click", () => showMode("browser"));
  $("workspace-mode-docs").addEventListener("click", () => showMode("docs"));

  // The overlay does not move with the layout, so every reflow has to be
  // pushed. A resize is the only one the renderer can observe cheaply.
  window.addEventListener("resize", reportWorkspaceBounds);
}

function showMode(mode: "browser" | "docs"): void {
  const browser = document.getElementById("workspace-browser");
  const docs = document.getElementById("workspace-docs");
  if (browser instanceof HTMLElement) browser.hidden = mode !== "browser";
  if (docs instanceof HTMLElement) docs.hidden = mode !== "docs";
  $("workspace-mode-browser").classList.toggle("diff-mode--on", mode === "browser");
  $("workspace-mode-docs").classList.toggle("diff-mode--on", mode === "docs");
  // setWorkspaceMode is what actually hides the native view; the classes
  // above are only paint.
  setWorkspaceMode(mode);
  if (mode === "browser") reportWorkspaceBounds();
}

export function renderWorkspace(state: WorkspaceState): void {
  latest = state;

  const strip = $("workspace-tabs");
  strip.replaceChildren();
  for (const tab of state.tabs) {
    const element = document.createElement("div");
    element.className = "workspace-tab";
    element.classList.toggle("workspace-tab--on", tab.id === state.activeTabId);
    element.addEventListener("click", () => void window.jarvis.activateTab(tab.id));

    const title = document.createElement("span");
    title.className = "workspace-tab-title";
    // A page picks its own title; it is text here and nothing else.
    title.textContent = tab.title === "" ? tab.url : tab.title;

    const close = document.createElement("span");
    close.className = "workspace-tab-close";
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      // Without this the tab underneath also receives the click and gets
      // activated on its way out.
      event.stopPropagation();
      void window.jarvis.closeTab(tab.id);
    });

    element.append(title, close);
    strip.append(element);
  }

  const tab = activeTab();
  const address = $("workspace-address") as HTMLInputElement;
  // Never overwrite what the user is in the middle of typing.
  if (document.activeElement !== address) address.value = tab?.url ?? "";

  ($("workspace-back") as HTMLButtonElement).disabled = !(tab?.canGoBack ?? false);
  ($("workspace-forward") as HTMLButtonElement).disabled = !(tab?.canGoForward ?? false);

  const error = $("workspace-error");
  if (tab?.error === undefined) {
    error.hidden = true;
    error.textContent = "";
  } else {
    error.hidden = false;
    error.textContent = tab.error;
  }
}

/**
 * Hands the main process the rectangle the layout reserved for the page.
 * A hosted view is positioned in window pixels and knows nothing about CSS,
 * so this is the only thing keeping it aligned with the chrome above it.
 * Rounded because a fractional bound leaves a hairline of dashboard showing
 * along an edge.
 */
export function reportWorkspaceBounds(): void {
  const slot = document.getElementById("workspace-page");
  if (slot === null) return;
  const rect = slot.getBoundingClientRect();
  void window.jarvis.setWorkspaceBounds({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}
