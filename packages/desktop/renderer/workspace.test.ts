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
      <button id="workspace-open-editor"></button>
      <button id="workspace-open-database"></button>
      <span id="workspace-tool-status"></span>
      <button id="workspace-new-tab"></button>
      <div id="workspace-browser">
        <div id="workspace-bookmarks">
          <div id="workspace-bookmark-list"></div>
        </div>
        <div id="workspace-tabs"></div>
        <div id="workspace-bar">
          <button id="workspace-back"></button>
          <button id="workspace-forward"></button>
          <button id="workspace-reload"></button>
          <input id="workspace-address" />
          <button id="workspace-bookmark-toggle"></button>
        </div>
        <div id="workspace-error" hidden></div>
        <div id="workspace-page"></div>
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
    hideAllTabs: record("hideAllTabs"),
    openEditor: () => Promise.resolve({ ok: true, value: "http://127.0.0.1:9001/?folder=%2Fp" }),
    openDatabase: () =>
      Promise.resolve({
        ok: true,
        value: { url: "http://127.0.0.1:51234/", login: "jarvis", password: "pw-fixed" },
      }),
    listBookmarks: () => Promise.resolve({ ok: true, value: [] }),
    addBookmark: (...args: unknown[]) => {
      calls.push({ call: "addBookmark", args });
      return Promise.resolve({ ok: true, value: [args[1] as { url: string; title: string }] });
    },
    removeBookmark: (...args: unknown[]) => {
      calls.push({ call: "removeBookmark", args });
      return Promise.resolve({ ok: true, value: [] });
    },
  };
  return calls;
}

function tab(overrides: Partial<WorkspaceState["tabs"][number]> = {}) {
  return {
    id: "tab-1",
    project: "acme",
    url: "https://github.com",
    kind: "web" as const,
    title: "GitHub",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: undefined,
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

  // The selected project ("acme", the first <option>, per beforeEach)
  // shows its tabs individually; every other project with an open tab
  // collapses into one pill instead of stacking every tab from every
  // project into the same flat row.
  it("shows only the selected project's tabs individually", () => {
    renderWorkspace({
      tabs: [tab({ project: "acme" }), tab({ id: "tab-2", project: "storefront" })],
      activeTabId: "tab-1",
    });

    expect(document.querySelectorAll("#workspace-tabs .workspace-tab")).toHaveLength(1);
  });

  it("collapses a non-selected project's tabs into one labeled, counted pill", () => {
    renderWorkspace({
      tabs: [
        tab({ project: "acme" }),
        tab({ id: "tab-2", project: "storefront" }),
        tab({ id: "tab-3", project: "storefront" }),
      ],
      activeTabId: "tab-1",
    });

    const pill = document.querySelector(".workspace-tab-group");
    expect(pill?.textContent).toContain("storefront");
    expect(pill?.textContent).toContain("2");
  });

  it("gives each project a distinct color", () => {
    renderWorkspace({
      tabs: [tab({ project: "acme" }), tab({ id: "tab-2", project: "storefront" })],
      activeTabId: "tab-1",
    });

    const active = document.querySelector(".workspace-tab") as HTMLElement;
    const collapsed = document.querySelector(".workspace-tab-group") as HTMLElement;
    expect(active.style.getPropertyValue("--tab-color")).not.toBe("");
    expect(active.style.getPropertyValue("--tab-color")).not.toBe(
      collapsed.style.getPropertyValue("--tab-color"),
    );
  });

  it("gives the same project the same color across renders", () => {
    renderWorkspace({
      tabs: [tab({ project: "acme" }), tab({ id: "tab-2", project: "storefront" })],
      activeTabId: "tab-1",
    });
    const first = (document.querySelector(".workspace-tab-group") as HTMLElement).style.getPropertyValue(
      "--tab-color",
    );

    renderWorkspace({
      tabs: [tab({ project: "acme" }), tab({ id: "tab-2", project: "storefront" })],
      activeTabId: "tab-1",
    });
    const second = (document.querySelector(".workspace-tab-group") as HTMLElement).style.getPropertyValue(
      "--tab-color",
    );

    expect(first).toBe(second);
  });

  it("switches the selected project and activates its remembered tab when a collapsed pill is clicked", async () => {
    renderWorkspace({ tabs: [tab({ project: "acme" })], activeTabId: "tab-1" });
    renderWorkspace({
      tabs: [tab({ project: "acme" }), tab({ id: "tab-2", project: "storefront" })],
      activeTabId: "tab-2",
    });
    renderWorkspace({
      tabs: [tab({ project: "acme" }), tab({ id: "tab-2", project: "storefront" })],
      activeTabId: "tab-1",
    });

    document.querySelector<HTMLElement>(".workspace-tab-group")?.click();
    await flush();

    expect((document.getElementById("workspace-project") as HTMLSelectElement).value).toBe("storefront");
    expect(calls).toContainEqual({ call: "activateTab", args: ["tab-2"] });
  });

  it("hides every view when switching to a project with no open tabs", async () => {
    renderWorkspace({ tabs: [tab({ project: "acme" })], activeTabId: "tab-1" });
    const select = document.getElementById("workspace-project") as HTMLSelectElement;

    select.value = "storefront";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect(calls.some((entry) => entry.call === "hideAllTabs")).toBe(true);
    expect(calls.some((entry) => entry.call === "activateTab")).toBe(false);
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

  // None of back/forward/reload/address means anything for a code editor.
  it("hides the address bar when the active tab is an editor", () => {
    renderWorkspace({ tabs: [tab({ kind: "editor" })], activeTabId: "tab-1" });

    expect(document.getElementById("workspace-bar")?.hasAttribute("hidden")).toBe(true);
  });

  it("shows the address bar when the active tab is an ordinary page", () => {
    renderWorkspace({ tabs: [tab({ kind: "web" })], activeTabId: "tab-1" });

    expect(document.getElementById("workspace-bar")?.hasAttribute("hidden")).toBe(false);
  });

  it("shows the address bar when there is no active tab at all", () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    expect(document.getElementById("workspace-bar")?.hasAttribute("hidden")).toBe(false);
  });

  // Bookmarks are part of the browser, not of the editor.
  it("hides the bookmarks sidebar when the active tab is an editor", () => {
    renderWorkspace({ tabs: [tab({ kind: "editor" })], activeTabId: "tab-1" });

    expect(document.getElementById("workspace-bookmarks")?.hasAttribute("hidden")).toBe(true);
  });

  it("shows the bookmarks sidebar when the active tab is an ordinary page", () => {
    renderWorkspace({ tabs: [tab({ kind: "web" })], activeTabId: "tab-1" });

    expect(document.getElementById("workspace-bookmarks")?.hasAttribute("hidden")).toBe(false);
  });

  // With nothing open the sidebar is the quickest way to open something,
  // so an empty workspace keeps it.
  it("shows the bookmarks sidebar when there is no active tab at all", () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    expect(document.getElementById("workspace-bookmarks")?.hasAttribute("hidden")).toBe(false);
  });

  // A DbGate tab is a hosted app like the editor: neither the address bar
  // nor the bookmarks sidebar means anything over it.
  it("hides the address bar when the active tab is a database", () => {
    renderWorkspace({ tabs: [tab({ kind: "database" })], activeTabId: "tab-1" });

    expect(document.getElementById("workspace-bar")?.hasAttribute("hidden")).toBe(true);
  });

  it("hides the bookmarks sidebar when the active tab is a database", () => {
    renderWorkspace({ tabs: [tab({ kind: "database" })], activeTabId: "tab-1" });

    expect(document.getElementById("workspace-bookmarks")?.hasAttribute("hidden")).toBe(true);
  });

  // "+" has a fixed spot in the workspace head — it is never relocated by
  // renderWorkspace, regardless of how many tabs are open or what kind the
  // active one is.
  it("keeps + visible in its fixed spot with no tabs open", () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    expect(document.getElementById("workspace-new-tab")).not.toBeNull();
    expect(document.getElementById("workspace-new-tab")?.hasAttribute("hidden")).toBe(false);
  });

  it("keeps + visible in its fixed spot while an editor tab is active", () => {
    renderWorkspace({ tabs: [tab({ kind: "editor" })], activeTabId: "tab-1" });

    expect(document.getElementById("workspace-new-tab")).not.toBeNull();
    expect(document.getElementById("workspace-new-tab")?.hasAttribute("hidden")).toBe(false);
  });

  it("hides the tab strip when no tabs are open anywhere", () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    expect(document.getElementById("workspace-tabs")?.hasAttribute("hidden")).toBe(true);
  });

  it("shows the tab strip once a tab exists", () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });

    expect(document.getElementById("workspace-tabs")?.hasAttribute("hidden")).toBe(false);
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

  // Empty string is not a URL — normalizeInput rejects it and BrowserHost.open
  // no-ops, so "+" must send something real, not the blank the address bar
  // shows as a placeholder.
  it("opens a real tab, not an empty one, when + is clicked", () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    document.getElementById("workspace-new-tab")?.click();

    const call = calls.find((entry) => entry.call === "openTab");
    expect(call?.args[0]).toBe("acme");
    expect(call?.args[1]).toEqual(expect.any(String));
    expect(call?.args[1]).not.toBe("");
  });

  it("selects the address bar's text after opening a new tab, ready to be typed over", () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });
    const address = document.getElementById("workspace-address") as HTMLInputElement;
    const selectSpy = vi.spyOn(address, "select");

    document.getElementById("workspace-new-tab")?.click();

    expect(document.activeElement).toBe(address);
    expect(selectSpy).toHaveBeenCalled();
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
});

describe("workspace bookmarks", () => {
  let calls: Recorded[];
  let jarvis: Record<string, unknown>;

  beforeEach(() => {
    calls = harness();
    jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
  });

  it("renders the selected project's bookmarks after init", async () => {
    jarvis["listBookmarks"] = (project: string) =>
      Promise.resolve({
        ok: true,
        value: project === "acme" ? [{ url: "https://github.com", title: "GitHub" }] : [],
      });

    initWorkspace(["acme"]);
    await flush();

    expect(document.querySelector(".workspace-bookmark")?.textContent).toContain("GitHub");
  });

  it("shows the bookmark's bare domain under its title", async () => {
    jarvis["listBookmarks"] = () =>
      Promise.resolve({ ok: true, value: [{ url: "https://github.com/a/b", title: "GitHub" }] });

    initWorkspace(["acme"]);
    await flush();

    expect(document.querySelector(".workspace-bookmark-domain")?.textContent).toBe("github.com");
  });

  it("opens a bookmark as a tab in the current project when clicked", async () => {
    jarvis["listBookmarks"] = () =>
      Promise.resolve({ ok: true, value: [{ url: "https://github.com", title: "GitHub" }] });
    initWorkspace(["acme"]);
    await flush();
    // Nothing open on that URL yet — module state does not reset between
    // tests, and a leftover tab would make this a tab switch instead.
    renderWorkspace({ tabs: [], activeTabId: undefined });

    document.querySelector<HTMLElement>(".workspace-bookmark")?.click();

    expect(calls).toContainEqual({ call: "openTab", args: ["acme", "https://github.com"] });
  });

  it("activates the existing tab instead of opening the bookmark twice", async () => {
    jarvis["listBookmarks"] = () =>
      Promise.resolve({ ok: true, value: [{ url: "https://github.com", title: "GitHub" }] });
    initWorkspace(["acme"]);
    await flush();
    renderWorkspace({ tabs: [tab({ id: "tab-7", url: "https://github.com" })], activeTabId: "tab-7" });

    document.querySelector<HTMLElement>(".workspace-bookmark")?.click();

    expect(calls).toContainEqual({ call: "activateTab", args: ["tab-7"] });
    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
  });

  // Same URL, different project: that is not the tab this bookmark opens.
  it("opens the bookmark when the only tab on that URL belongs to another project", async () => {
    jarvis["listBookmarks"] = () =>
      Promise.resolve({ ok: true, value: [{ url: "https://github.com", title: "GitHub" }] });
    initWorkspace(["acme"]);
    await flush();
    renderWorkspace({
      tabs: [tab({ id: "tab-7", project: "storefront", url: "https://github.com" })],
      activeTabId: "tab-7",
    });

    document.querySelector<HTMLElement>(".workspace-bookmark")?.click();

    expect(calls).toContainEqual({ call: "openTab", args: ["acme", "https://github.com"] });
  });

  it("removes a bookmark from its own remove control without opening it", async () => {
    jarvis["listBookmarks"] = () =>
      Promise.resolve({ ok: true, value: [{ url: "https://github.com", title: "GitHub" }] });
    initWorkspace(["acme"]);
    await flush();

    document.querySelector<HTMLElement>(".workspace-bookmark-remove")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "removeBookmark", args: ["acme", "https://github.com"] });
    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
  });

  it("refetches bookmarks when the project changes", async () => {
    const listed: string[] = [];
    jarvis["listBookmarks"] = (project: string) => {
      listed.push(project);
      return Promise.resolve({ ok: true, value: [] });
    };
    initWorkspace(["acme", "storefront"]);
    await flush();
    listed.length = 0;

    const select = document.getElementById("workspace-project") as HTMLSelectElement;
    select.value = "storefront";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect(listed).toEqual(["storefront"]);
  });

  it("marks the star toggle on when the active tab's URL is already bookmarked", async () => {
    jarvis["listBookmarks"] = () =>
      Promise.resolve({ ok: true, value: [{ url: "https://github.com", title: "GitHub" }] });
    initWorkspace(["acme"]);
    await flush();

    renderWorkspace({ tabs: [tab({ url: "https://github.com" })], activeTabId: "tab-1" });

    expect(
      document
        .getElementById("workspace-bookmark-toggle")
        ?.classList.contains("workspace-bookmark-toggle--on"),
    ).toBe(true);
  });

  it("leaves the star toggle off when the active tab's URL is not bookmarked", async () => {
    jarvis["listBookmarks"] = () => Promise.resolve({ ok: true, value: [] });
    initWorkspace(["acme"]);
    await flush();

    renderWorkspace({ tabs: [tab({ url: "https://example.com" })], activeTabId: "tab-1" });

    expect(
      document
        .getElementById("workspace-bookmark-toggle")
        ?.classList.contains("workspace-bookmark-toggle--on"),
    ).toBe(false);
  });

  it("adds the active tab's URL as a bookmark when the star is clicked", async () => {
    jarvis["listBookmarks"] = () => Promise.resolve({ ok: true, value: [] });
    initWorkspace(["acme"]);
    await flush();
    renderWorkspace({
      tabs: [tab({ url: "https://example.com", title: "Example" })],
      activeTabId: "tab-1",
    });

    document.getElementById("workspace-bookmark-toggle")?.click();
    await flush();

    expect(calls).toContainEqual({
      call: "addBookmark",
      args: ["acme", { url: "https://example.com", title: "Example" }],
    });
  });

  it("removes the active tab's bookmark when the star is clicked again", async () => {
    jarvis["listBookmarks"] = () =>
      Promise.resolve({ ok: true, value: [{ url: "https://example.com", title: "Example" }] });
    initWorkspace(["acme"]);
    await flush();
    renderWorkspace({
      tabs: [tab({ url: "https://example.com", title: "Example" })],
      activeTabId: "tab-1",
    });

    document.getElementById("workspace-bookmark-toggle")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "removeBookmark", args: ["acme", "https://example.com"] });
  });

  it("does nothing when the star is clicked with no active tab", async () => {
    jarvis["listBookmarks"] = () => Promise.resolve({ ok: true, value: [] });
    initWorkspace(["acme"]);
    await flush();
    renderWorkspace({ tabs: [], activeTabId: undefined });

    document.getElementById("workspace-bookmark-toggle")?.click();
    await flush();

    expect(
      calls.some((entry) => entry.call === "addBookmark" || entry.call === "removeBookmark"),
    ).toBe(false);
  });
});

describe("open in editor", () => {
  let calls: Recorded[];
  let jarvis: Record<string, unknown>;

  beforeEach(() => {
    calls = harness();
    initWorkspace(["acme"]);
    jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
  });

  it("opens the editor URL as a tab for the selected project", async () => {
    jarvis["openEditor"] = (project: string) =>
      Promise.resolve({ ok: true, value: `http://127.0.0.1:9001/?folder=${project}` });

    document.getElementById("workspace-open-editor")?.click();
    await flush();

    expect(calls).toContainEqual({
      call: "openTab",
      args: ["acme", "http://127.0.0.1:9001/?folder=acme", "editor"],
    });
  });

  // Reopening a project that already has an editor tab must not spin up a
  // second one — code-server is already running and the tab is already
  // there, so this is a plain tab switch, not a new-tab-plus-IPC round trip.
  it("activates the existing editor tab instead of opening a duplicate", async () => {
    renderWorkspace({
      tabs: [
        {
          id: "tab-9",
          project: "acme",
          url: "http://127.0.0.1:9001/?folder=acme",
          kind: "editor",
          title: "acme — Editor",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          error: undefined,
        },
      ],
      activeTabId: "tab-9",
    });

    document.getElementById("workspace-open-editor")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "activateTab", args: ["tab-9"] });
    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
  });

  it("opens a new editor tab when the existing one belongs to a different project", async () => {
    initWorkspace(["acme", "storefront"]);
    const select = document.getElementById("workspace-project") as HTMLSelectElement;
    select.value = "storefront";
    renderWorkspace({
      tabs: [
        {
          id: "tab-9",
          project: "acme",
          url: "http://127.0.0.1:9001/?folder=acme",
          kind: "editor",
          title: "acme — Editor",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          error: undefined,
        },
      ],
      activeTabId: "tab-9",
    });
    jarvis["openEditor"] = (project: string) =>
      Promise.resolve({ ok: true, value: `http://127.0.0.1:9002/?folder=${project}` });

    document.getElementById("workspace-open-editor")?.click();
    await flush();

    expect(calls).toContainEqual({
      call: "openTab",
      args: ["storefront", "http://127.0.0.1:9002/?folder=storefront", "editor"],
    });
  });

  it("shows a localised error and does not open a tab when the editor cannot start", async () => {
    // No editor tab open yet — renderWorkspace's own module state does not
    // reset between tests, so this is stated explicitly rather than
    // assumed, the same as every other test in this suite that depends on
    // the current tab list.
    renderWorkspace({ tabs: [], activeTabId: undefined });
    jarvis["openEditor"] = () =>
      Promise.resolve({ ok: false, text: "Could not open the editor.", language: "en" });

    document.getElementById("workspace-open-editor")?.click();
    await flush();

    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
    expect(document.getElementById("workspace-tool-status")?.textContent).toBe(
      "Could not open the editor.",
    );
  });
});

describe("open in database", () => {
  let calls: Recorded[];
  let jarvis: Record<string, unknown>;

  beforeEach(() => {
    calls = harness();
    jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    initWorkspace(["acme", "storefront"]);
  });

  it("opens the DbGate URL as a database tab for the selected project", async () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    document.getElementById("workspace-open-database")?.click();
    await flush();

    expect(calls).toContainEqual({
      call: "openTab",
      args: ["acme", "http://127.0.0.1:51234/", "database"],
    });
  });

  it("shows the instance's login in the shared status line", async () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    document.getElementById("workspace-open-database")?.click();
    await flush();

    expect(document.getElementById("workspace-tool-status")?.textContent).toBe(
      "login jarvis · password pw-fixed",
    );
  });

  // Reopening a project that already has a Database tab is a tab switch,
  // not a reason to open a duplicate — same rule the editor follows.
  it("activates the existing database tab instead of opening a duplicate", async () => {
    renderWorkspace({
      tabs: [tab({ id: "tab-9", kind: "database", url: "http://127.0.0.1:51234/" })],
      activeTabId: "tab-9",
    });

    document.getElementById("workspace-open-database")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "activateTab", args: ["tab-9"] });
    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
  });

  it("opens a new database tab when the existing one belongs to another project", async () => {
    renderWorkspace({
      tabs: [tab({ id: "tab-9", kind: "database", project: "storefront" })],
      activeTabId: "tab-9",
    });

    document.getElementById("workspace-open-database")?.click();
    await flush();

    expect(calls).toContainEqual({
      call: "openTab",
      args: ["acme", "http://127.0.0.1:51234/", "database"],
    });
  });

  it("shows a localised error and does not open a tab when DbGate cannot start", async () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });
    jarvis["openDatabase"] = () =>
      Promise.resolve({ ok: false, text: "Could not open the database browser.", language: "en" });

    document.getElementById("workspace-open-database")?.click();
    await flush();

    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
    expect(document.getElementById("workspace-tool-status")?.textContent).toBe(
      "Could not open the database browser.",
    );
  });
});
