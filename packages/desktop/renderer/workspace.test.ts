// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceState } from "@jarvis/core";
import type { DevToolsDock } from "../src/browser-host.js";
import type { BookmarkView } from "../src/ipc.js";
import { FakeFitAddon, FakeTerminal } from "./terminal-double.js";

// workspace.ts pulls in workspace-terminal.ts, which hosts a real terminal
// emulator; jsdom has neither a canvas nor real character cells, so the
// vendored xterm modules are doubled here the same way session-view.test.ts
// and app.test.ts do it. The terminal's own behaviour is covered by
// workspace-terminal.test.ts.
vi.mock("./vendor/xterm.mjs", () => ({ Terminal: FakeTerminal }));
vi.mock("./vendor/addon-fit.mjs", () => ({ FitAddon: FakeFitAddon }));
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import {
  initWorkspace,
  renderWorkspace,
  reportWorkspaceBounds,
  setBrowserSnapshot,
} from "./workspace.js";

type Recorded = { call: string; args: unknown[] };

function harness(): Recorded[] {
  document.body.innerHTML = `
    <button id="nav-workspace"></button>
    <div id="view-workspace">
      <select id="workspace-project"></select>
      <button id="workspace-open-editor" title="Open the project's files in a full code editor"></button>
      <div id="workspace-editor-menu" hidden></div>
      <button id="workspace-open-database" title="Browse the project's databases"></button>
      <button id="workspace-open-terminal" title="Open a shell in the project's directory"></button>
      <button id="workspace-open-api" title="Send requests from the project's collections"></button>
      <button id="workspace-open-cluster" title="Browse the project's Kubernetes clusters"></button>
      <div id="workspace-cluster-menu" hidden></div>
      <button id="workspace-open-chat" title="Open the project's chat"></button>
      <div id="workspace-chat-menu" hidden></div>
      <button id="workspace-open-docker" title="Manage the project's containers"></button>
      <div id="workspace-docker" hidden></div>
      <button id="workspace-toggle-bookmarks"></button>
      <span id="workspace-tool-status"></span>
      <div id="workspace-browser">
        <div id="workspace-tabs">
          <button id="workspace-new-tab"></button>
        </div>
        <div id="workspace-bar">
          <button id="workspace-back"></button>
          <button id="workspace-forward"></button>
          <button id="workspace-reload"></button>
          <input id="workspace-address" />
          <button id="workspace-toggle-devtools"></button>
          <button id="workspace-bookmark-toggle"></button>
          <button id="workspace-pip" hidden></button>
        </div>
        <div id="workspace-loading" hidden></div>
        <div id="workspace-error" hidden></div>
        <div id="workspace-stage">
          <div id="workspace-body">
            <div id="workspace-bookmarks">
              <div id="workspace-essentials"></div>
              <div id="workspace-ask" hidden></div>
              <div id="workspace-bookmark-list"></div>
            </div>
            <div id="workspace-page"></div>
          </div>
          <div id="workspace-devtools-handle" hidden></div>
          <div id="workspace-devtools" hidden>
            <button id="workspace-devtools-dock-undocked"></button>
            <button id="workspace-devtools-dock-left"></button>
            <button id="workspace-devtools-dock-bottom"></button>
            <button id="workspace-devtools-dock-right"></button>
            <button id="workspace-devtools-close"></button>
            <div id="workspace-devtools-slot"></div>
          </div>
        </div>
        <div id="workspace-terminal" hidden></div>
        <div id="workspace-api" hidden>
          <select id="api-collection"></select>
          <button id="api-new"></button>
          <div id="api-new-menu" hidden></div>
          <button id="api-new-request"></button>
          <button id="api-new-folder"></button>
          <button id="api-new-collection"></button>
          <button id="api-import"></button>
          <div id="api-tree"></div>
          <select id="api-method"></select>
          <input id="api-url" />
          <select id="api-environment"></select>
          <button id="api-env-edit"></button>
          <div id="api-env-panel" hidden>
            <input id="api-env-name" />
            <button id="api-env-add"></button>
            <button id="api-env-save"></button>
            <button id="api-env-close"></button>
            <div id="api-env-vars"></div>
          </div>
          <button id="api-send"></button>
          <button id="api-save"><span id="api-dirty" hidden></span></button>
          <button id="api-curl"></button>
          <div id="api-ask" hidden>
            <span id="api-ask-label"></span>
            <input id="api-ask-input" />
            <button id="api-ask-ok"></button>
            <button id="api-ask-cancel"></button>
          </div>
          <button id="api-history-toggle"></button>
          <button id="api-cookies-toggle"></button>
          <button id="api-settings-toggle"></button>
          <div id="api-side-panel" hidden>
            <div id="api-side-tabs"></div>
            <div id="api-side-body"></div>
          </div>
          <span id="api-status"></span>
          <div id="api-tabs"></div>
          <div id="api-panel"></div>
          <div id="api-response-tabs"></div>
          <div id="api-response-head"></div>
          <div id="api-response"></div>
        </div>
      </div>
    </div>`;

  const calls: Recorded[] = [];
  const record =
    (call: string) =>
    (...args: unknown[]) => {
      calls.push({ call, args });
      return Promise.resolve();
    };
  // For the handlers whose result the code under test actually reads
  // (`if (!result.ok)`). A double resolving `undefined` there threw an
  // unhandled rejection out of a floating promise, which Vitest attributes
  // to whatever test happened to be running — the whole file went red at
  // random.
  const recordOk =
    (call: string) =>
    (...args: unknown[]) => {
      calls.push({ call, args });
      return Promise.resolve({ ok: true as const, value: undefined });
    };
  (window as unknown as { jarvis: unknown }).jarvis = {
    openTab: record("openTab"),
    closeTab: record("closeTab"),
    activateTab: record("activateTab"),
    navigateTab: record("navigateTab"),
    tabBack: record("tabBack"),
    tabForward: record("tabForward"),
    tabReload: record("tabReload"),
    renameTab: record("renameTab"),
    moveTab: record("moveTab"),
    setWorkspaceBounds: record("setWorkspaceBounds"),
    setDevTools: record("setDevTools"),
    setDevToolsBounds: record("setDevToolsBounds"),
    setDevToolsDock: record("setDevToolsDock"),
    showDevToolsDockMenu: record("showDevToolsDockMenu"),
    onDevToolsDockChosen: (cb: (dock: DevToolsDock) => void) => {
      devToolsHooks.dockChosen = cb;
    },
    onDevToolsClosed: (cb: (tabId: string) => void) => {
      devToolsHooks.closed = cb;
    },
    setWorkspaceVisible: record("setWorkspaceVisible"),
    hideAllTabs: record("hideAllTabs"),
    requestPictureInPicture: record("requestPictureInPicture"),
    openEditor: () => Promise.resolve({ ok: true, value: "http://127.0.0.1:9001/?folder=%2Fp" }),
    editorRoots: () => Promise.resolve([]),
    clusterNames: () => Promise.resolve([]),
    chatNames: () => Promise.resolve([]),
    openChat: (...args: unknown[]) => {
      calls.push({ call: "openChat", args });
      return Promise.resolve({ ok: true, value: "https://acme.slack.com/" });
    },
    openCluster: (...args: unknown[]) => {
      calls.push({ call: "openCluster", args });
      return Promise.resolve({ ok: true, value: "http://127.0.0.1:5000/c/ctx-a" });
    },
    openDatabase: () =>
      Promise.resolve({
        ok: true,
        value: { url: "http://127.0.0.1:51234/" },
      }),
    openTerminal: recordOk("openTerminal"),
    openApiTab: recordOk("openApiTab"),
    openDockerTab: recordOk("openDockerTab"),
    dockerNames: () => Promise.resolve({ ok: true, value: ["app"] }),
    dockerView: () =>
      Promise.resolve({
        ok: true,
        value: { rows: [], composeProject: undefined, composeWorkingDir: undefined },
      }),
    dockerUnfollow: record("dockerUnfollow"),
    onDockerLog: () => {},
    listApiCollections: () => Promise.resolve({ ok: true, value: [] }),
    readApiTree: () => Promise.resolve({ ok: false, text: "none", language: "en" }),
    readApiRequest: () => Promise.resolve({ ok: false, text: "none", language: "en" }),
    saveApiRequest: () => Promise.resolve({ ok: true, value: undefined }),
    sendApiRequest: () =>
      Promise.resolve({ ok: true, value: { response: undefined, assertions: [] } }),
    apiCurl: () => Promise.resolve({ ok: true, value: "curl" }),
    createApiRequest: () => Promise.resolve({ ok: true, value: "" }),
    createApiFolder: () => Promise.resolve({ ok: true, value: "" }),
    renameApiEntry: () => Promise.resolve({ ok: true, value: "" }),
    deleteApiEntry: () => Promise.resolve({ ok: true, value: undefined }),
    createApiCollection: () => Promise.resolve({ ok: true, value: "" }),
    saveApiEnvironment: () => Promise.resolve({ ok: true, value: "" }),
    importPostmanCollection: () => Promise.resolve({ ok: true, value: "" }),
    apiHistory: () => Promise.resolve({ ok: true, value: [] }),
    clearApiHistory: () => Promise.resolve({ ok: true, value: undefined }),
    apiCookies: () => Promise.resolve({ ok: true, value: [] }),
    clearApiCookies: () => Promise.resolve({ ok: true, value: [] }),
    removeApiCookie: () => Promise.resolve({ ok: true, value: [] }),
    apiSettings: () =>
      Promise.resolve({ ok: true, value: { proxyUrl: "", verifyCertificate: true, timeoutMs: 1 } }),
    saveApiSettings: () =>
      Promise.resolve({ ok: true, value: { proxyUrl: "", verifyCertificate: true, timeoutMs: 1 } }),
    pickFiles: () => Promise.resolve([]),
    readJsonFile: () => Promise.resolve({ ok: true, value: {} }),
    attachTerminal: () => Promise.resolve(""),
    sendTerminalInput: record("sendTerminalInput"),
    resizeTerminal: record("resizeTerminal"),
    onTerminalData: () => {},
    onTerminalExit: () => {},
    listBookmarks: () => Promise.resolve({ ok: true, value: [] }),
    addBookmark: (...args: unknown[]) => {
      calls.push({ call: "addBookmark", args });
      return Promise.resolve({ ok: true, value: [args[1] as { url: string; title: string }] });
    },
    removeBookmark: (...args: unknown[]) => {
      calls.push({ call: "removeBookmark", args });
      return Promise.resolve({ ok: true, value: [] });
    },
    setBookmarkPinned: (...args: unknown[]) => {
      calls.push({ call: "setBookmarkPinned", args });
      return Promise.resolve({ ok: true, value: [] });
    },
    reorderBookmarks: (...args: unknown[]) => {
      calls.push({ call: "reorderBookmarks", args });
      return Promise.resolve({ ok: true, value: [] });
    },
    renameBookmark: (...args: unknown[]) => {
      calls.push({ call: "renameBookmark", args });
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
    hasPlayingVideo: false,
    pageFullscreen: false,
    suspended: false,
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stubBookmarks(bookmarks: BookmarkView[]): void {
  (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
    ...(window as unknown as { jarvis: Record<string, unknown> }).jarvis,
    listBookmarks: async () => ({ ok: true, value: bookmarks }),
  };
}

/** jsdom has no DataTransfer, and the drag protocol here only ever moves a
 *  url — so a stub carrying one is the whole contract under test. */
function dropEvent(url: string): Event {
  const event = new Event("drop", { bubbles: true }) as Event & { dataTransfer: unknown };
  event.dataTransfer = { getData: () => url, setData: () => undefined };
  return event;
}

describe("workspace chrome", () => {
  let calls: Recorded[];

  beforeEach(() => {
    calls = harness();
    initWorkspace(["acme", "storefront"]);
  });

  it("fills the project selector from the configured projects, then the personal browser", () => {
    const options = [...document.querySelectorAll("#workspace-project option")].map(
      (option) => option.textContent,
    );
    expect(options).toEqual(["acme", "storefront", "Personal"]);
  });

  it("draws one element per tab", () => {
    renderWorkspace({ tabs: [tab(), tab({ id: "tab-2", title: "Docs" })], activeTabId: "tab-1" });

    expect(document.querySelectorAll("#workspace-tabs .workspace-tab")).toHaveLength(2);
  });

  // Round 3: the strip used to rebuild every chip from scratch on every
  // render (strip.replaceChildren(newTabButton) + recreate), which flashed
  // the strip and — worse — tore an in-progress inline rename's <input> out
  // from under a keystroke the instant an unrelated push (a loading flag, a
  // title from the page) arrived. These four cover the keyed reconcile that
  // replaced it.
  describe("the tab strip's keyed reconcile (round 3)", () => {
    it("keeps the same chip elements across two renders of the same tabs", () => {
      renderWorkspace({ tabs: [tab(), tab({ id: "tab-2" })], activeTabId: "tab-1" });
      const before = [...document.querySelectorAll("#workspace-tabs .workspace-tab")];

      renderWorkspace({ tabs: [tab(), tab({ id: "tab-2" })], activeTabId: "tab-1" });
      const after = [...document.querySelectorAll("#workspace-tabs .workspace-tab")];

      expect(after).toEqual(before);
    });

    it("keeps a chip's title span node across renders, not just its text", () => {
      renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
      const titleBefore = document.querySelector(".workspace-tab-title");

      renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });

      expect(document.querySelector(".workspace-tab-title")).toBe(titleBefore);
    });

    it("survives an intervening render while the rename input is open, and Enter still renames", () => {
      renderWorkspace({ tabs: [tab({ title: "Page" })], activeTabId: "tab-1" });
      const chip = document.querySelector<HTMLElement>(".workspace-tab");
      chip?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const input = chip?.querySelector<HTMLInputElement>(".workspace-tab-rename");
      expect(input).not.toBeNull();
      if (input) input.value = "Renamed mid-typing";

      // An unrelated push — the loading flag flipping — must not rebuild
      // this chip, or the input above would be destroyed along with it.
      renderWorkspace({ tabs: [tab({ title: "Page", loading: true })], activeTabId: "tab-1" });

      const stillOpen = document.querySelector<HTMLInputElement>(".workspace-tab-rename");
      expect(stillOpen).toBe(input);
      expect(stillOpen?.value).toBe("Renamed mid-typing");
      // The title span is detached while the input stands in for it — still
      // true after the intervening render, which is the point.
      expect(document.querySelector(".workspace-tab-title")).toBeNull();

      stillOpen?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(calls).toContainEqual({ call: "renameTab", args: ["tab-1", "Renamed mid-typing"] });
      // The span comes back, caught up to what update() withheld from it.
      expect(document.querySelector(".workspace-tab-title")?.textContent).toBe("Page");
    });

    it("removes a closed tab's chip and reorders the rest to match", () => {
      renderWorkspace({
        tabs: [tab(), tab({ id: "tab-2" }), tab({ id: "tab-3" })],
        activeTabId: "tab-1",
      });
      const chip2 = document.querySelectorAll<HTMLElement>(".workspace-tab")[1];
      const chip3 = document.querySelectorAll<HTMLElement>(".workspace-tab")[2];

      // tab-1 closes, and tab-3 moves ahead of tab-2 — both a removal and a
      // reorder in the same render.
      renderWorkspace({ tabs: [tab({ id: "tab-3" }), tab({ id: "tab-2" })], activeTabId: "tab-3" });

      const chips = [...document.querySelectorAll<HTMLElement>(".workspace-tab")];
      expect(chips).toEqual([chip3, chip2]);
      // The "+" button stays the strip's last child throughout.
      expect(document.getElementById("workspace-tabs")?.lastElementChild?.id).toBe(
        "workspace-new-tab",
      );
    });

    it("toggles the loading indicator in place, without recreating the chip", () => {
      renderWorkspace({ tabs: [tab({ loading: false })], activeTabId: "tab-1" });
      const chip = document.querySelector(".workspace-tab");
      expect(chip?.classList.contains("workspace-tab--loading")).toBe(false);

      renderWorkspace({ tabs: [tab({ loading: true })], activeTabId: "tab-1" });
      expect(document.querySelector(".workspace-tab")).toBe(chip);
      expect(chip?.classList.contains("workspace-tab--loading")).toBe(true);

      renderWorkspace({ tabs: [tab({ loading: false })], activeTabId: "tab-1" });
      expect(document.querySelector(".workspace-tab")).toBe(chip);
      expect(chip?.classList.contains("workspace-tab--loading")).toBe(false);
    });
  });

  it("shows loading below the address only for the active web page", () => {
    const loading = document.getElementById("workspace-loading");
    renderWorkspace({ tabs: [tab({ loading: true })], activeTabId: "tab-1" });
    expect(loading?.hidden).toBe(false);
    renderWorkspace({ tabs: [tab({ loading: false })], activeTabId: "tab-1" });
    expect(loading?.hidden).toBe(true);
    renderWorkspace({ tabs: [tab({ loading: true, error: "failed" })], activeTabId: "tab-1" });
    expect(loading?.hidden).toBe(true);
    renderWorkspace({ tabs: [tab({ loading: true, kind: "terminal" })], activeTabId: "tab-1" });
    expect(loading?.hidden).toBe(true);
  });

  it("routes Ctrl+R from browser chrome to the active page", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    const event = new KeyboardEvent("keydown", {
      key: "r",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.getElementById("workspace-address")?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(calls).toContainEqual({ call: "tabReload", args: ["tab-1"] });
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

  it("moves the project switcher to the active tab's project when a tab of another project is activated from outside (a Dashboard card's shortcut) [bite-proof: leave the <select> alone and this stays on acme]", () => {
    renderWorkspace({
      tabs: [tab({ project: "acme" }), tab({ id: "tab-2", project: "storefront" })],
      activeTabId: "tab-2",
    });

    const select = document.getElementById("workspace-project") as HTMLSelectElement;
    expect(select.value).toBe("storefront");
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

  it("colours the project switcher's own edge with the selected project's colour", () => {
    renderWorkspace({ tabs: [tab({ project: "acme" })], activeTabId: "tab-1" });

    const select = document.getElementById("workspace-project") as HTMLElement;
    const chip = document.querySelector(".workspace-tab") as HTMLElement;
    expect(select.style.getPropertyValue("--tab-color")).not.toBe("");
    expect(select.style.getPropertyValue("--tab-color")).toBe(
      chip.style.getPropertyValue("--tab-color"),
    );
  });

  it("gives the same project the same color across renders", () => {
    renderWorkspace({
      tabs: [tab({ project: "acme" }), tab({ id: "tab-2", project: "storefront" })],
      activeTabId: "tab-1",
    });
    const first = (
      document.querySelector(".workspace-tab-group") as HTMLElement
    ).style.getPropertyValue("--tab-color");

    renderWorkspace({
      tabs: [tab({ project: "acme" }), tab({ id: "tab-2", project: "storefront" })],
      activeTabId: "tab-1",
    });
    const second = (
      document.querySelector(".workspace-tab-group") as HTMLElement
    ).style.getPropertyValue("--tab-color");

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

    expect((document.getElementById("workspace-project") as HTMLSelectElement).value).toBe(
      "storefront",
    );
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
    renderWorkspace({
      tabs: [tab({ title: "<img src=x onerror=alert(1)>" })],
      activeTabId: "tab-1",
    });

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

  // "+" has a fixed spot at the end of the tab strip (re-review 2, item 1)
  // — it is never relocated by renderWorkspace, regardless of how many tabs
  // are open or what kind the active one is.
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

  // The strip itself is never hidden any more (re-review 2, item 1): with
  // no tabs open it still shows the lone "+", which is what keeps it
  // reachable without a second home for it back in the workspace head.
  it("keeps the strip showing the lone + when no tabs are open anywhere", () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    expect(document.getElementById("workspace-tabs")?.hasAttribute("hidden")).toBe(false);
    expect(
      document
        .getElementById("workspace-tabs")
        ?.contains(document.getElementById("workspace-new-tab") ?? null),
    ).toBe(true);
  });

  it("puts + immediately after the last chip once a tab exists", () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });

    const strip = document.getElementById("workspace-tabs");
    expect(strip?.hasAttribute("hidden")).toBe(false);
    expect(strip?.lastElementChild?.id).toBe("workspace-new-tab");
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

  // Re-review 2, item 3: a configured browser.homePage takes over from
  // NEW_TAB_URL, through the same openTab call "+" always used — no new
  // channel, just a different string.
  it("opens the configured home page instead of the built-in one, once set", () => {
    setBrowserSnapshot({ allowPopups: true, homePage: "https://intranet.example.com/" });
    renderWorkspace({ tabs: [], activeTabId: undefined });

    document.getElementById("workspace-new-tab")?.click();

    expect(calls).toContainEqual({
      call: "openTab",
      args: ["acme", "https://intranet.example.com/"],
    });
  });

  it("falls back to the built-in new-tab page with no home page configured", () => {
    setBrowserSnapshot({ allowPopups: true });
    renderWorkspace({ tabs: [], activeTabId: undefined });

    document.getElementById("workspace-new-tab")?.click();

    const call = calls.find((entry) => entry.call === "openTab");
    expect(call?.args[1]).not.toBe("https://intranet.example.com/");
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

  it("renames a tab on double click and displays its custom label", () => {
    renderWorkspace({ tabs: [tab({ title: "Page" })], activeTabId: "tab-1" });
    const chip = document.querySelector<HTMLElement>(".workspace-tab");
    chip?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = chip?.querySelector<HTMLInputElement>(".workspace-tab-rename");
    expect(input?.getAttribute("aria-label")).toBe(MESSAGES.renameTab(PRIMARY_LANGUAGE));
    expect(chip?.draggable).toBe(false);
    expect(input?.value).toBe("Page");
    if (input) input.value = "Mine";
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(chip?.draggable).toBe(true);
    expect(calls).toContainEqual({ call: "renameTab", args: ["tab-1", "Mine"] });
    renderWorkspace({ tabs: [tab({ title: "Page", customTitle: "Mine" })], activeTabId: "tab-1" });
    expect(document.querySelector(".workspace-tab-title")?.textContent).toBe("Mine");
  });

  it("names double-click as the way to rename in the chip's own tooltip", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    const chip = document.querySelector<HTMLElement>(".workspace-tab");
    expect(chip?.title).toBe(MESSAGES.tabRenameHint(PRIMARY_LANGUAGE));
  });

  it("opens a Rename/Reload/Close menu on right-click", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    const chip = document.querySelector<HTMLElement>(".workspace-tab");
    const menu = chip?.querySelector<HTMLElement>(".workspace-tab-menu");
    expect(menu?.hidden).toBe(true);

    chip?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));

    expect(menu?.hidden).toBe(false);
    const labels = [...(menu?.querySelectorAll(".workspace-tab-menu-item") ?? [])].map(
      (item) => item.textContent,
    );
    expect(labels).toEqual([
      MESSAGES.tabMenuRename(PRIMARY_LANGUAGE),
      MESSAGES.tabMenuReload(PRIMARY_LANGUAGE),
      MESSAGES.tabMenuClose(PRIMARY_LANGUAGE),
    ]);
  });

  it("opens the inline rename input from the context menu's Rename item", () => {
    renderWorkspace({ tabs: [tab({ title: "Page" })], activeTabId: "tab-1" });
    const chip = document.querySelector<HTMLElement>(".workspace-tab");
    chip?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const menu = chip?.querySelector<HTMLElement>(".workspace-tab-menu");
    const rename = [
      ...(menu?.querySelectorAll<HTMLButtonElement>(".workspace-tab-menu-item") ?? []),
    ].find((item) => item.textContent === MESSAGES.tabMenuRename(PRIMARY_LANGUAGE));

    rename?.click();

    expect(menu?.hidden).toBe(true);
    expect(chip?.querySelector(".workspace-tab-rename")).not.toBeNull();
  });

  it("reloads and closes a tab from its context menu", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    const chip = document.querySelector<HTMLElement>(".workspace-tab");
    chip?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const items = [
      ...(chip?.querySelectorAll<HTMLButtonElement>(".workspace-tab-menu-item") ?? []),
    ];

    items.find((item) => item.textContent === MESSAGES.tabMenuReload(PRIMARY_LANGUAGE))?.click();
    expect(calls).toContainEqual({ call: "tabReload", args: ["tab-1"] });

    chip?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    items.find((item) => item.textContent === MESSAGES.tabMenuClose(PRIMARY_LANGUAGE))?.click();
    expect(calls).toContainEqual({ call: "closeTab", args: ["tab-1"] });
  });

  it("moves a dropped tab after the target tab", () => {
    renderWorkspace({ tabs: [tab(), tab({ id: "tab-2" })], activeTabId: "tab-1" });
    const chips = document.querySelectorAll<HTMLElement>(".workspace-tab");
    const target = chips[1];
    expect(target?.draggable).toBe(true);
    if (!target) return;
    Object.defineProperty(target, "clientWidth", { value: 100 });
    target.getBoundingClientRect = () => ({ left: 0 }) as DOMRect;
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { getData: () => "tab-1" },
    });
    Object.defineProperty(event, "clientX", { value: 75 });
    target.dispatchEvent(event);
    expect(calls).toContainEqual({ call: "moveTab", args: ["tab-1", "tab-2", true] });
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
    page.getBoundingClientRect = () => ({ x: 12, y: 140, width: 900, height: 600 }) as DOMRect;

    reportWorkspaceBounds();

    expect(calls).toContainEqual({
      call: "setWorkspaceBounds",
      args: [{ x: 12, y: 140, width: 900, height: 600, devicePixelRatio: window.devicePixelRatio }],
    });
  });

  it("rounds a fractional rectangle to whole pixels", () => {
    const page = document.getElementById("workspace-page") as HTMLElement;
    page.getBoundingClientRect = () =>
      ({ x: 12.4, y: 140.6, width: 900.5, height: 600.2 }) as DOMRect;

    reportWorkspaceBounds();

    expect(calls).toContainEqual({
      call: "setWorkspaceBounds",
      args: [{ x: 12, y: 141, width: 901, height: 600, devicePixelRatio: window.devicePixelRatio }],
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

  // The rail had two lines per bookmark, title over host. One horizontal
  // row has space for the title alone, so the address moves into the
  // tooltip — where it is also more use, since the host was never the part
  // you needed to see.
  it("shows the title alone, with the full URL as its tooltip", async () => {
    jarvis["listBookmarks"] = () =>
      Promise.resolve({ ok: true, value: [{ url: "https://github.com/a/b", title: "GitHub" }] });

    initWorkspace(["acme"]);
    await flush();

    const chip = document.querySelector(".workspace-bookmark");
    expect(chip?.textContent).toContain("GitHub");
    expect(chip?.textContent).not.toContain("github.com/a/b");
    expect(chip?.getAttribute("title")).toBe("https://github.com/a/b");
  });

  // Arabic is the user's primary language, and a strip of chips is exactly
  // where a mixed-direction title goes wrong: an Arabic title left at the
  // document's LTR direction renders its trailing punctuation on the wrong
  // side. Same per-element treatment app.ts and changes.ts already give
  // every other piece of user text.
  it("renders an Arabic bookmark title right-to-left", async () => {
    jarvis["listBookmarks"] = () =>
      Promise.resolve({ ok: true, value: [{ url: "https://example.com", title: "لوحة التحكم" }] });

    initWorkspace(["acme"]);
    await flush();

    expect(document.querySelector<HTMLElement>(".workspace-bookmark-title")?.dir).toBe("rtl");
  });

  it("leaves an English bookmark title left-to-right", async () => {
    jarvis["listBookmarks"] = () =>
      Promise.resolve({ ok: true, value: [{ url: "https://example.com", title: "Dashboard" }] });

    initWorkspace(["acme"]);
    await flush();

    expect(document.querySelector<HTMLElement>(".workspace-bookmark-title")?.dir).toBe("ltr");
  });

  // An empty strip under the address bar reads as a rendering glitch, and
  // the star that fills it is two elements away.
  it("explains itself when the project has no bookmarks", async () => {
    jarvis["listBookmarks"] = () => Promise.resolve({ ok: true, value: [] });

    initWorkspace(["acme"]);
    await flush();

    expect(document.querySelector(".workspace-bookmarks-empty")?.textContent).toMatch(/\S/);
    expect(document.querySelector(".workspace-bookmark")).toBeNull();
  });

  // A row of chips and the empty note are not the same height, so the bar
  // — and with it the page slot's top edge — moves the moment the first
  // bookmark lands. Nothing else re-measures for a DOM change the renderer
  // made itself, so the hosted view would stay pinned to the old rectangle
  // and overlap the bar.
  it("re-measures the page slot when the bookmarks change", async () => {
    jarvis["listBookmarks"] = () => Promise.resolve({ ok: true, value: [] });
    initWorkspace(["acme"]);
    await flush();
    renderWorkspace({
      tabs: [tab({ url: "https://github.com", title: "GitHub" })],
      activeTabId: "tab-1",
    });

    const page = document.getElementById("workspace-page") as HTMLElement;
    page.getBoundingClientRect = () => ({ x: 0, y: 240, width: 800, height: 500 }) as DOMRect;
    jarvis["addBookmark"] = () =>
      Promise.resolve({ ok: true, value: [{ url: "https://github.com", title: "GitHub" }] });
    calls.length = 0;

    document.getElementById("workspace-bookmark-toggle")?.click();
    await flush();

    expect(calls).toContainEqual({
      call: "setWorkspaceBounds",
      args: [{ x: 0, y: 240, width: 800, height: 500, devicePixelRatio: window.devicePixelRatio }],
    });
  });

  it("drops the empty note once a bookmark exists", async () => {
    jarvis["listBookmarks"] = () =>
      Promise.resolve({ ok: true, value: [{ url: "https://github.com", title: "GitHub" }] });

    initWorkspace(["acme"]);
    await flush();

    expect(document.querySelector(".workspace-bookmarks-empty")).toBeNull();
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
    renderWorkspace({
      tabs: [tab({ id: "tab-7", url: "https://github.com" })],
      activeTabId: "tab-7",
    });

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

describe("the bookmarks sidebar", () => {
  it("puts pinned bookmarks in the grid and the rest in the list", async () => {
    harness();
    stubBookmarks([
      { url: "https://a.test/", title: "A", pinned: true },
      { url: "https://b.test/", title: "B" },
    ]);

    initWorkspace(["acme"]);
    await flush();

    expect(document.querySelectorAll("#workspace-essentials .workspace-essential")).toHaveLength(1);
    expect(document.querySelectorAll("#workspace-bookmark-list .workspace-bookmark")).toHaveLength(
      1,
    );
  });

  it("draws the cached icon when there is one", async () => {
    harness();
    stubBookmarks([
      { url: "https://a.test/", title: "A", pinned: true, icon: "data:image/png;base64,AQ==" },
    ]);

    initWorkspace(["acme"]);
    await flush();

    const img = document.querySelector("#workspace-essentials img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AQ==");
  });

  it("falls back to a monogram of the title when there is no icon", async () => {
    harness();
    stubBookmarks([{ url: "https://a.test/", title: "Alpha", pinned: true }]);

    initWorkspace(["acme"]);
    await flush();

    expect(document.querySelector("#workspace-essentials img")).toBeNull();
    expect(
      document.querySelector("#workspace-essentials .workspace-essential-monogram")?.textContent,
    ).toBe("A");
  });

  it("gives one origin the same monogram colour every time", async () => {
    harness();
    stubBookmarks([
      { url: "https://a.test/one", title: "One", pinned: true },
      { url: "https://a.test/two", title: "Two", pinned: true },
    ]);

    initWorkspace(["acme"]);
    await flush();

    const tiles = [...document.querySelectorAll(".workspace-essential-monogram")] as HTMLElement[];
    expect(tiles[0]?.style.backgroundColor).toBe(tiles[1]?.style.backgroundColor);
  });

  it("shows at most twelve tiles even if the file holds more", async () => {
    harness();
    stubBookmarks(
      Array.from({ length: 15 }, (_, i) => ({
        url: `https://s${i}.test/`,
        title: `S${i}`,
        pinned: true,
      })),
    );

    initWorkspace(["acme"]);
    await flush();

    expect(document.querySelectorAll("#workspace-essentials .workspace-essential")).toHaveLength(
      12,
    );
  });

  it("shows the cached icon on a listed (unpinned) row too", async () => {
    harness();
    stubBookmarks([{ url: "https://a.test/", title: "A", icon: "data:image/png;base64,AQ==" }]);

    initWorkspace(["acme"]);
    await flush();

    const img = document.querySelector("#workspace-bookmark-list img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AQ==");
  });

  it("falls back to a monogram on a listed row with no icon", async () => {
    harness();
    stubBookmarks([{ url: "https://a.test/", title: "Alpha" }]);

    initWorkspace(["acme"]);
    await flush();

    expect(document.querySelector("#workspace-bookmark-list img")).toBeNull();
    expect(
      document.querySelector("#workspace-bookmark-list .workspace-essential-monogram")?.textContent,
    ).toBe("A");
  });
});

// Fix 1 and 2: the spec (design :240) gives every list row a pin control
// and every grid tile an unpin action. Drag alone left the feature
// unreachable from the state every existing install upgrades into — nothing
// pinned, so an empty grid with no tile to drop on — and offered a keyboard
// user no path at all.
// Renaming a bookmark. Editing is in place — the chip's label becomes the
// field — so these drive the real input rather than a prompt. Note that
// jsdom *does* have window.prompt while Electron throws on it, so a test
// that mocked a prompt would have passed against code the app cannot run.
describe("renaming a bookmark", () => {
  function field(): HTMLInputElement | null {
    return document.querySelector<HTMLInputElement>(".workspace-rename-input");
  }

  function type(value: string): void {
    const input = field();
    if (input === null) return;
    input.value = value;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }

  it("sends the new title, and does not open the bookmark it renamed", async () => {
    const calls = harness();
    stubBookmarks([{ url: "https://b.test/", title: "B" }]);
    initWorkspace(["acme"]);
    await flush();

    document.querySelector<HTMLElement>(".workspace-bookmark-rename")?.click();
    await flush();
    type("Netflix");
    await flush();

    expect(calls).toContainEqual({
      call: "renameBookmark",
      args: ["acme", "https://b.test/", "Netflix"],
    });
    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
  });

  // The point of editing in place: the list must not move, and the field
  // must arrive holding what it is replacing.
  it("replaces the label in place, carrying the current title", async () => {
    harness();
    stubBookmarks([{ url: "https://b.test/", title: "B" }]);
    initWorkspace(["acme"]);
    await flush();

    document.querySelector<HTMLElement>(".workspace-bookmark-rename")?.click();
    await flush();

    expect(field()?.value).toBe("B");
    expect(document.querySelector(".workspace-bookmark-title")).toBeNull();
    expect(document.querySelector("#workspace-ask")?.hasAttribute("hidden")).toBe(true);
  });

  it("Escape restores the label without calling the store", async () => {
    const calls = harness();
    stubBookmarks([{ url: "https://b.test/", title: "B" }]);
    initWorkspace(["acme"]);
    await flush();

    document.querySelector<HTMLElement>(".workspace-bookmark-rename")?.click();
    await flush();
    field()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();

    expect(calls.some((entry) => entry.call === "renameBookmark")).toBe(false);
    expect(document.querySelector(".workspace-bookmark-title")?.textContent).toBe("B");
    expect(field()).toBeNull();
  });

  // Enter moves focus, which fires blur, which commits again — the bug this
  // guards is a second rename call for one edit.
  it("commits once when Enter is followed by the blur it causes", async () => {
    const calls = harness();
    stubBookmarks([{ url: "https://b.test/", title: "B" }]);
    initWorkspace(["acme"]);
    await flush();

    document.querySelector<HTMLElement>(".workspace-bookmark-rename")?.click();
    await flush();
    const input = field();
    if (input !== null) input.value = "Netflix";
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input?.dispatchEvent(new FocusEvent("blur"));
    await flush();

    expect(calls.filter((entry) => entry.call === "renameBookmark")).toHaveLength(1);
  });

  it("leaves the title alone when the field is emptied rather than naming it nothing", async () => {
    const calls = harness();
    stubBookmarks([{ url: "https://b.test/", title: "B" }]);
    initWorkspace(["acme"]);
    await flush();

    document.querySelector<HTMLElement>(".workspace-bookmark-rename")?.click();
    await flush();
    type("   ");
    await flush();

    expect(calls.some((entry) => entry.call === "renameBookmark")).toBe(false);
  });

  // The essentials grid is the one place the name is all there is: the tile
  // draws a monogram from it. A pinned bookmark is absent from the chip
  // list, so without its own control it could not be renamed at all.
  it("renames from an essential tile, on a line of its own under the grid", async () => {
    const calls = harness();
    stubBookmarks([{ url: "https://a.test/", title: "A", pinned: true }]);
    initWorkspace(["acme"]);
    await flush();

    document.querySelector<HTMLElement>(".workspace-essential-rename")?.click();
    await flush();
    expect(document.querySelector("#workspace-ask")?.hasAttribute("hidden")).toBe(false);
    type("Prime Video");
    await flush();

    expect(calls).toContainEqual({
      call: "renameBookmark",
      args: ["acme", "https://a.test/", "Prime Video"],
    });
    expect(document.querySelector("#workspace-ask")?.hasAttribute("hidden")).toBe(true);
  });

  it("redraws the label from the store's answer, not from what was typed", async () => {
    harness();
    stubBookmarks([{ url: "https://b.test/", title: "B" }]);
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis.renameBookmark =
      async () => ({
        ok: true as const,
        value: [{ url: "https://b.test/", title: "Netflix" }],
      });
    initWorkspace(["acme"]);
    await flush();

    document.querySelector<HTMLElement>(".workspace-bookmark-rename")?.click();
    await flush();
    type("  Netflix  ");
    await flush();

    expect(document.querySelector(".workspace-bookmark-title")?.textContent).toBe("Netflix");
  });

  it("surfaces the store's refusal in the tool status", async () => {
    harness();
    stubBookmarks([{ url: "https://b.test/", title: "B" }]);
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis.renameBookmark =
      async () => ({
        ok: false as const,
        text: "A bookmark needs a name.",
        language: "en" as const,
      });
    initWorkspace(["acme"]);
    await flush();

    document.querySelector<HTMLElement>(".workspace-bookmark-rename")?.click();
    await flush();
    type("anything");
    await flush();

    expect(document.querySelector("#workspace-tool-status")?.textContent).toBe(
      "A bookmark needs a name.",
    );
  });
});

describe("the pin and unpin controls", () => {
  it("pins a listed bookmark from its own pin control, without opening it", async () => {
    const calls = harness();
    stubBookmarks([{ url: "https://b.test/", title: "B" }]);
    initWorkspace(["acme"]);
    await flush();

    document.querySelector<HTMLElement>(".workspace-bookmark-pin")?.click();
    await flush();

    expect(calls).toContainEqual({
      call: "setBookmarkPinned",
      args: ["acme", "https://b.test/", true],
    });
    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
  });

  it("surfaces the store's refusal when the pin control hits the limit", async () => {
    harness();
    stubBookmarks([{ url: "https://b.test/", title: "B" }]);
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis.setBookmarkPinned =
      async () => ({
        ok: false as const,
        text: "The grid holds 12 bookmarks; unpin one first.",
        language: "en" as const,
      });
    initWorkspace(["acme"]);
    await flush();

    document.querySelector<HTMLElement>(".workspace-bookmark-pin")?.click();
    await flush();

    expect(document.querySelector("#workspace-tool-status")?.textContent).toBe(
      "The grid holds 12 bookmarks; unpin one first.",
    );
  });

  it("unpins a tile from its own unpin action, and the bookmark lands in the list", async () => {
    const calls = harness();
    stubBookmarks([{ url: "https://a.test/", title: "A", pinned: true }]);
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis.setBookmarkPinned =
      async () => ({
        ok: true as const,
        value: [{ url: "https://a.test/", title: "A", pinned: false }],
      });
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis.reorderBookmarks =
      async () => ({
        ok: true as const,
        value: [{ url: "https://a.test/", title: "A", pinned: false }],
      });
    initWorkspace(["acme"]);
    await flush();

    document.querySelector<HTMLElement>(".workspace-essential-unpin")?.click();
    await flush();

    expect(document.querySelectorAll("#workspace-essentials .workspace-essential")).toHaveLength(0);
    expect(document.querySelectorAll("#workspace-bookmark-list .workspace-bookmark")).toHaveLength(
      1,
    );
    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
  });

  // The mirror of the empty grid: with every bookmark pinned the list is
  // empty, so there is no row to drop onto. The tile's own action is the
  // way out, and it must work in exactly that state.
  it("unpins from an all-pinned project, where the list has no row to drop on", async () => {
    const calls = harness();
    stubBookmarks([
      { url: "https://a.test/", title: "A", pinned: true },
      { url: "https://b.test/", title: "B", pinned: true },
    ]);
    initWorkspace(["acme"]);
    await flush();

    expect(document.querySelectorAll("#workspace-bookmark-list .workspace-bookmark")).toHaveLength(
      0,
    );
    document
      .querySelector<HTMLElement>(
        '.workspace-essential[data-url="https://a.test/"] .workspace-essential-unpin',
      )
      ?.click();
    await flush();

    expect(calls).toContainEqual({
      call: "setBookmarkPinned",
      args: ["acme", "https://a.test/", false],
    });
  });

  // A button inside a button is invalid markup that browsers reparent, so
  // the tile stopped being a button when it gained the unpin action. What
  // it must not stop doing is opening the bookmark.
  it("still opens the bookmark when the tile itself is clicked", async () => {
    const calls = harness();
    stubBookmarks([{ url: "https://a.test/", title: "A", pinned: true }]);
    initWorkspace(["acme"]);
    await flush();

    document.querySelector<HTMLElement>(".workspace-essential-open")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "openTab", args: ["acme", "https://a.test/"] });
  });

  it("nests no button inside another on a tile", async () => {
    harness();
    stubBookmarks([{ url: "https://a.test/", title: "A", pinned: true }]);
    initWorkspace(["acme"]);
    await flush();

    expect(document.querySelector("#workspace-essentials button button")).toBeNull();
  });

  it("names both controls for a screen reader as well as a pointer", async () => {
    harness();
    stubBookmarks([
      { url: "https://a.test/", title: "A", pinned: true },
      { url: "https://b.test/", title: "B" },
    ]);
    initWorkspace(["acme"]);
    await flush();

    for (const selector of [".workspace-bookmark-pin", ".workspace-essential-unpin"]) {
      const control = document.querySelector<HTMLElement>(selector);
      expect(control?.getAttribute("aria-label")).toMatch(/\S/);
      expect(control?.title).toBe(control?.getAttribute("aria-label"));
      expect(control?.querySelector('[aria-hidden="true"]')?.textContent).toMatch(/\S/);
    }
  });

  // The grid keeps its height with nothing in it (styles.css min-height, see
  // workspace-markup.test.ts) so it stays a drop target; a blank band with
  // no words in it would read as a rendering glitch.
  it("explains the empty grid instead of leaving a blank band", async () => {
    harness();
    stubBookmarks([{ url: "https://b.test/", title: "B" }]);
    initWorkspace(["acme"]);
    await flush();

    expect(
      document.querySelector("#workspace-essentials .workspace-essentials-empty")?.textContent,
    ).toMatch(/\S/);
  });

  it("drops the grid's note once something is pinned", async () => {
    harness();
    stubBookmarks([{ url: "https://a.test/", title: "A", pinned: true }]);
    initWorkspace(["acme"]);
    await flush();

    expect(document.querySelector(".workspace-essentials-empty")).toBeNull();
  });

  // Important 3: the tooltip was hard-coded English in index.html, and
  // still said "bar" long after the bar became a sidebar.
  it("labels the sidebar toggle from MESSAGES rather than from the markup", () => {
    harness();
    initWorkspace(["acme"]);

    expect(document.getElementById("workspace-toggle-bookmarks")?.getAttribute("title")).toBe(
      MESSAGES.toggleBookmarksSidebar(PRIMARY_LANGUAGE),
    );
  });
});

describe("reordering bookmarks", () => {
  it("pins a listed bookmark dropped on the grid", async () => {
    harness();
    const setPinned = vi.fn(async () => ({ ok: true, value: [] }));
    stubBookmarks([{ url: "https://b.test/", title: "B" }]);
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis.setBookmarkPinned = setPinned;
    initWorkspace(["acme"]);
    await flush();

    const grid = document.querySelector("#workspace-essentials") as HTMLElement;
    grid.dispatchEvent(dropEvent("https://b.test/"));
    await flush();

    expect(setPinned).toHaveBeenCalledWith(expect.any(String), "https://b.test/", true);
  });

  it("sends the whole new order when a tile is dropped on another", async () => {
    harness();
    const reorder = vi.fn(async () => ({ ok: true, value: [] }));
    stubBookmarks([
      { url: "https://a.test/", title: "A", pinned: true },
      { url: "https://b.test/", title: "B", pinned: true },
    ]);
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis.reorderBookmarks = reorder;
    initWorkspace(["acme"]);
    await flush();

    const first = document.querySelector(
      '.workspace-essential[data-url="https://a.test/"]',
    ) as HTMLElement;
    first.dispatchEvent(dropEvent("https://b.test/"));
    await flush();

    expect(reorder).toHaveBeenCalledWith(expect.any(String), [
      "https://b.test/",
      "https://a.test/",
    ]);
  });

  it("stops the reorder when a cross-group pin change is refused", async () => {
    harness();
    const setPinned = vi.fn(async () => ({
      ok: false as const,
      text: "The grid holds 12 bookmarks; unpin one first.",
      language: "en" as const,
    }));
    const reorder = vi.fn(async () => ({ ok: true, value: [] }));
    stubBookmarks([
      { url: "https://a.test/", title: "A", pinned: true },
      { url: "https://b.test/", title: "B" },
    ]);
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis.setBookmarkPinned = setPinned;
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis.reorderBookmarks = reorder;
    initWorkspace(["acme"]);
    await flush();

    // "B" is listed, dropped onto the pinned tile "A" — a cross-group drop,
    // which is a pin change first. The store refuses it.
    const target = document.querySelector(
      '.workspace-essential[data-url="https://a.test/"]',
    ) as HTMLElement;
    target.dispatchEvent(dropEvent("https://b.test/"));
    await flush();

    expect(setPinned).toHaveBeenCalledWith(expect.any(String), "https://b.test/", true);
    // The important assertion: a refused pin must stop the reorder rather
    // than proceed with the renderer and the store disagreeing about what
    // is pinned.
    expect(reorder).not.toHaveBeenCalled();
    expect(document.querySelector("#workspace-tool-status")?.textContent).toBe(
      "The grid holds 12 bookmarks; unpin one first.",
    );
  });

  // Minor 6: a pin change leaves `order` alone, so a listed bookmark
  // carrying order 2 would otherwise be inserted in the middle of the grid
  // rather than where the drop implied. Empty space means "at the end".
  it("appends a bookmark dropped on the grid's empty space to the end of the grid", async () => {
    harness();
    const reorder = vi.fn(async () => ({ ok: true, value: [] }));
    stubBookmarks([
      { url: "https://p1.test/", title: "P1", pinned: true, order: 0 },
      { url: "https://p2.test/", title: "P2", pinned: true, order: 1 },
      { url: "https://b.test/", title: "B", order: 2 },
    ]);
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    // What the store returns after the pin: `order: 2` is untouched, which
    // is exactly the value that used to place B between P1 and P2.
    jarvis["setBookmarkPinned"] = async () => ({
      ok: true as const,
      value: [
        { url: "https://p1.test/", title: "P1", pinned: true, order: 0 },
        { url: "https://p2.test/", title: "P2", pinned: true, order: 1 },
        { url: "https://b.test/", title: "B", pinned: true, order: 2 },
      ],
    });
    jarvis["reorderBookmarks"] = reorder;
    initWorkspace(["acme"]);
    await flush();

    (document.querySelector("#workspace-essentials") as HTMLElement).dispatchEvent(
      dropEvent("https://b.test/"),
    );
    await flush();

    expect(reorder).toHaveBeenCalledWith(expect.any(String), [
      "https://p1.test/",
      "https://p2.test/",
      "https://b.test/",
    ]);
  });

  // Dropping a tile back on empty grid space asks for nothing: it is
  // already pinned, and the call would still rewrite bookmarks.json.
  it("does not re-pin a tile dropped on the grid's own empty space", async () => {
    const calls = harness();
    stubBookmarks([{ url: "https://a.test/", title: "A", pinned: true }]);
    initWorkspace(["acme"]);
    await flush();

    (document.querySelector("#workspace-essentials") as HTMLElement).dispatchEvent(
      dropEvent("https://a.test/"),
    );
    await flush();

    expect(calls.some((entry) => entry.call === "setBookmarkPinned")).toBe(false);
    expect(calls.some((entry) => entry.call === "reorderBookmarks")).toBe(false);
  });

  // The mirror of the grid's container drop: with everything pinned the
  // list holds no row to drop onto, so without this the drag path could
  // never take anything back out.
  it("unpins a tile dropped on the list's empty space, and appends it there", async () => {
    harness();
    const reorder = vi.fn(async () => ({ ok: true, value: [] }));
    const setPinned = vi.fn(async () => ({
      ok: true as const,
      value: [{ url: "https://a.test/", title: "A", pinned: false }],
    }));
    stubBookmarks([{ url: "https://a.test/", title: "A", pinned: true }]);
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    jarvis["setBookmarkPinned"] = setPinned;
    jarvis["reorderBookmarks"] = reorder;
    initWorkspace(["acme"]);
    await flush();

    (document.querySelector("#workspace-bookmark-list") as HTMLElement).dispatchEvent(
      dropEvent("https://a.test/"),
    );
    await flush();

    expect(setPinned).toHaveBeenCalledWith(expect.any(String), "https://a.test/", false);
    expect(reorder).toHaveBeenCalledWith(expect.any(String), ["https://a.test/"]);
  });

  it("sends the whole new order when a listed row is dropped on another listed row", async () => {
    harness();
    const reorder = vi.fn(async () => ({ ok: true, value: [] }));
    stubBookmarks([
      { url: "https://p.test/", title: "P", pinned: true },
      { url: "https://a.test/", title: "A" },
      { url: "https://b.test/", title: "B" },
    ]);
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis.reorderBookmarks = reorder;
    initWorkspace(["acme"]);
    await flush();

    const first = document.querySelector(
      '.workspace-bookmark[title="https://a.test/"]',
    ) as HTMLElement;
    first.dispatchEvent(dropEvent("https://b.test/"));
    await flush();

    // The listed group's new order, with the pinned group left untouched.
    expect(reorder).toHaveBeenCalledWith(expect.any(String), [
      "https://b.test/",
      "https://a.test/",
    ]);
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
      args: ["acme", "http://127.0.0.1:9001/?folder=acme", "editor", undefined],
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
          hasPlayingVideo: false,
          pageFullscreen: false,
          suspended: false,
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
          hasPlayingVideo: false,
          pageFullscreen: false,
          suspended: false,
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
      args: ["storefront", "http://127.0.0.1:9002/?folder=storefront", "editor", undefined],
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

// A project that declares `editors:` roots opens straight into one when it
// has a single root, and offers a choice when it has more than one.
describe("open in editor, with configured roots", () => {
  let calls: Recorded[];
  let jarvis: Record<string, unknown>;

  beforeEach(() => {
    calls = harness();
    initWorkspace(["acme"]);
    jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    renderWorkspace({ tabs: [], activeTabId: undefined });
    jarvis["openEditor"] = (project: string, root: string | undefined) =>
      Promise.resolve({
        ok: true,
        value: `http://127.0.0.1:9001/?folder=${project}/${root ?? ""}`,
      });
  });

  function menuItems(): HTMLElement[] {
    return [...document.querySelectorAll("#workspace-editor-menu button")] as HTMLElement[];
  }

  it("opens the only configured root directly, without a menu", async () => {
    jarvis["editorRoots"] = () => Promise.resolve(["portal-vue"]);

    document.getElementById("workspace-open-editor")?.click();
    await flush();

    expect(calls).toContainEqual({
      call: "openTab",
      args: ["acme", "http://127.0.0.1:9001/?folder=acme/portal-vue", "editor", "portal-vue"],
    });
    expect(document.getElementById("workspace-editor-menu")?.hidden).toBe(true);
  });

  it("offers a menu of the roots when there is more than one", async () => {
    jarvis["editorRoots"] = () => Promise.resolve(["portal-vue", "api"]);

    document.getElementById("workspace-open-editor")?.click();
    await flush();

    expect(menuItems().map((item) => item.textContent)).toEqual(["portal-vue", "api"]);
    expect(document.getElementById("workspace-editor-menu")?.hidden).toBe(false);
    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
  });

  it("opens the root the user picks and closes the menu", async () => {
    jarvis["editorRoots"] = () => Promise.resolve(["portal-vue", "api"]);
    document.getElementById("workspace-open-editor")?.click();
    await flush();

    menuItems()[1]?.click();
    await flush();

    expect(calls).toContainEqual({
      call: "openTab",
      args: ["acme", "http://127.0.0.1:9001/?folder=acme/api", "editor", "api"],
    });
    expect(document.getElementById("workspace-editor-menu")?.hidden).toBe(true);
  });

  it("closes an open menu when the Editor button is clicked again", async () => {
    jarvis["editorRoots"] = () => Promise.resolve(["portal-vue", "api"]);
    document.getElementById("workspace-open-editor")?.click();
    await flush();

    document.getElementById("workspace-open-editor")?.click();
    await flush();

    expect(document.getElementById("workspace-editor-menu")?.hidden).toBe(true);
  });

  // Two roots of one project are two editors; only the tab for the root
  // being asked for is a duplicate.
  it("activates the existing tab for that root rather than opening a second", async () => {
    jarvis["editorRoots"] = () => Promise.resolve(["portal-vue"]);
    renderWorkspace({
      tabs: [
        {
          id: "tab-7",
          project: "acme",
          url: "http://127.0.0.1:9001/?folder=acme/portal-vue",
          kind: "editor",
          title: "acme — Editor · portal-vue",
          detail: "portal-vue",
          loading: false,
          hasPlayingVideo: false,
          pageFullscreen: false,
          suspended: false,
          canGoBack: false,
          canGoForward: false,
          error: undefined,
        },
      ],
      activeTabId: "tab-7",
    });

    document.getElementById("workspace-open-editor")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "activateTab", args: ["tab-7"] });
    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
  });

  it("opens a second editor tab for a different root of the same project", async () => {
    jarvis["editorRoots"] = () => Promise.resolve(["portal-vue", "api"]);
    renderWorkspace({
      tabs: [
        {
          id: "tab-7",
          project: "acme",
          url: "http://127.0.0.1:9001/?folder=acme/portal-vue",
          kind: "editor",
          title: "acme — Editor · portal-vue",
          detail: "portal-vue",
          loading: false,
          hasPlayingVideo: false,
          pageFullscreen: false,
          suspended: false,
          canGoBack: false,
          canGoForward: false,
          error: undefined,
        },
      ],
      activeTabId: "tab-7",
    });

    document.getElementById("workspace-open-editor")?.click();
    await flush();
    menuItems()[1]?.click();
    await flush();

    expect(calls).toContainEqual({
      call: "openTab",
      args: ["acme", "http://127.0.0.1:9001/?folder=acme/api", "editor", "api"],
    });
  });

  // The whole-project editor and a root editor are different tabs, so an
  // open whole-project one must not swallow a request for a root.
  it("does not mistake the whole-project editor for a rooted one", async () => {
    jarvis["editorRoots"] = () => Promise.resolve(["portal-vue"]);
    renderWorkspace({
      tabs: [
        {
          id: "tab-8",
          project: "acme",
          url: "http://127.0.0.1:9001/?folder=acme",
          kind: "editor",
          title: "acme — Editor",
          loading: false,
          hasPlayingVideo: false,
          pageFullscreen: false,
          suspended: false,
          canGoBack: false,
          canGoForward: false,
          error: undefined,
        },
      ],
      activeTabId: "tab-8",
    });

    document.getElementById("workspace-open-editor")?.click();
    await flush();

    expect(calls.some((entry) => entry.call === "openTab")).toBe(true);
  });

  it("shows a localised error and opens nothing when a picked root fails", async () => {
    jarvis["editorRoots"] = () => Promise.resolve(["portal-vue"]);
    jarvis["openEditor"] = () =>
      Promise.resolve({ ok: false, text: "Could not open the editor.", language: "en" });

    document.getElementById("workspace-open-editor")?.click();
    await flush();

    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
    expect(document.getElementById("workspace-tool-status")?.textContent).toBe(
      "Could not open the editor.",
    );
  });

  // A root name is config text rendered into the menu — a node with its
  // textContent set, never markup.
  it("renders a root name as text, not as markup", async () => {
    jarvis["editorRoots"] = () => Promise.resolve(["<img src=x onerror=alert(1)>", "api"]);

    document.getElementById("workspace-open-editor")?.click();
    await flush();

    expect(document.querySelector("#workspace-editor-menu img")).toBeNull();
    expect(menuItems()[0]?.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

// The Cluster button mirrors the Editor's: no clusters disables it, one
// opens it straight away, two or more offer a menu.
describe("the Cluster button", () => {
  let calls: Recorded[];
  let jarvis: Record<string, unknown>;

  beforeEach(() => {
    calls = harness();
    jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
  });

  function menuItems(): HTMLElement[] {
    return [...document.querySelectorAll("#workspace-cluster-menu button")] as HTMLElement[];
  }

  it("opens straight away when the project has one cluster", async () => {
    jarvis["clusterNames"] = () => Promise.resolve(["dev"]);
    initWorkspace(["acme"]);
    await flush();

    document.getElementById("workspace-open-cluster")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "openCluster", args: ["acme", "dev"] });
  });

  it("offers a menu when the project has two or more", async () => {
    jarvis["clusterNames"] = () => Promise.resolve(["dev", "chaos"]);
    initWorkspace(["acme"]);
    await flush();

    document.getElementById("workspace-open-cluster")?.click();
    await flush();

    expect(document.getElementById("workspace-cluster-menu")?.hidden).toBe(false);
    expect(menuItems().map((item) => item.textContent)).toEqual(["dev", "chaos"]);
    expect(calls.some((entry) => entry.call === "openCluster")).toBe(false);
  });

  it("closes the menu on a second press instead of reopening it", async () => {
    jarvis["clusterNames"] = () => Promise.resolve(["dev", "chaos"]);
    initWorkspace(["acme"]);
    await flush();
    const button = document.getElementById("workspace-open-cluster");

    button?.click();
    await flush();
    button?.click();
    await flush();

    expect(document.getElementById("workspace-cluster-menu")?.hidden).toBe(true);
  });

  it("activates an open tab rather than opening a second", async () => {
    jarvis["clusterNames"] = () => Promise.resolve(["dev"]);
    initWorkspace(["acme"]);
    await flush();
    renderWorkspace({
      tabs: [tab({ id: "t1", project: "acme", kind: "cluster", detail: "dev" })],
      activeTabId: "t1",
    });

    document.getElementById("workspace-open-cluster")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "activateTab", args: ["t1"] });
    expect(calls.some((entry) => entry.call === "openCluster")).toBe(false);
  });

  // Two clusters of one project are two tabs against one server, so the
  // tab's own `detail` — not the project — decides which is already open.
  it("tells two clusters of one project apart by detail", async () => {
    jarvis["clusterNames"] = () => Promise.resolve(["dev", "chaos"]);
    initWorkspace(["acme"]);
    await flush();
    renderWorkspace({
      tabs: [tab({ id: "t1", project: "acme", kind: "cluster", detail: "dev" })],
      activeTabId: "t1",
    });

    document.getElementById("workspace-open-cluster")?.click();
    await flush();
    menuItems()[1]?.click();
    await flush();

    expect(calls).toContainEqual({ call: "openCluster", args: ["acme", "chaos"] });
  });

  it("shows the failure text and re-enables the button", async () => {
    jarvis["clusterNames"] = () => Promise.resolve(["dev"]);
    jarvis["openCluster"] = () =>
      Promise.resolve({ ok: false, text: "Could not open the cluster browser.", language: "en" });
    initWorkspace(["acme"]);
    await flush();
    // No cluster tab open yet — renderWorkspace's own module state does not
    // reset between tests, and a leftover tab from an earlier test in this
    // block would make this a tab switch instead of a fresh open.
    renderWorkspace({ tabs: [], activeTabId: undefined });

    document.getElementById("workspace-open-cluster")?.click();
    await flush();

    expect(document.getElementById("workspace-tool-status")?.textContent).toBe(
      "Could not open the cluster browser.",
    );
    expect((document.getElementById("workspace-open-cluster") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  // A cluster name is config text rendered into the menu — a node with its
  // textContent set, never markup, same discipline as the editor's roots.
  it("renders a cluster name as text, not as markup", async () => {
    jarvis["clusterNames"] = () => Promise.resolve(["<img src=x onerror=alert(1)>", "chaos"]);
    initWorkspace(["acme"]);
    await flush();

    document.getElementById("workspace-open-cluster")?.click();
    await flush();

    expect(document.querySelector("#workspace-cluster-menu img")).toBeNull();
    expect(menuItems()[0]?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("disables the button for a project with no clusters, with the reason shown", async () => {
    jarvis["clusterNames"] = () => Promise.resolve([]);
    initWorkspace(["acme"]);
    await flush();

    const button = document.getElementById("workspace-open-cluster") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("No clusters configured for this project.");
  });

  it("enables the button for a project with clusters configured", async () => {
    jarvis["clusterNames"] = () => Promise.resolve(["dev"]);
    initWorkspace(["acme"]);
    await flush();

    const button = document.getElementById("workspace-open-cluster") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("Browse the project's Kubernetes clusters");
  });

  // The Chat button follows the Cluster button's rule exactly, minus the
  // waiting: there is no server to start, so no "starting…" state and no
  // hover pre-warm.
  describe("the Chat button", () => {
    function chatMenuItems(): HTMLElement[] {
      return [...document.querySelectorAll("#workspace-chat-menu button")] as HTMLElement[];
    }

    it("opens straight away when the project has one chat", async () => {
      jarvis["chatNames"] = () => Promise.resolve(["Acme"]);
      initWorkspace(["acme"]);
      await flush();
      renderWorkspace({ tabs: [], activeTabId: undefined });

      document.getElementById("workspace-open-chat")?.click();
      await flush();

      expect(calls).toContainEqual({ call: "openChat", args: ["acme", "Acme"] });
    });

    it("opens the tab main resolved, as a chat tab named after the entry", async () => {
      jarvis["chatNames"] = () => Promise.resolve(["Acme"]);
      initWorkspace(["acme"]);
      await flush();
      renderWorkspace({ tabs: [], activeTabId: undefined });

      document.getElementById("workspace-open-chat")?.click();
      await flush();

      expect(calls).toContainEqual({
        call: "openTab",
        args: ["acme", "https://acme.slack.com/", "chat", "Acme"],
      });
    });

    it("offers a menu when the project has two or more", async () => {
      jarvis["chatNames"] = () => Promise.resolve(["Acme", "Vendors"]);
      initWorkspace(["acme"]);
      await flush();

      document.getElementById("workspace-open-chat")?.click();
      await flush();

      expect(document.getElementById("workspace-chat-menu")?.hidden).toBe(false);
      expect(chatMenuItems().map((item) => item.textContent)).toEqual(["Acme", "Vendors"]);
      expect(calls.some((entry) => entry.call === "openChat")).toBe(false);
    });

    it("closes the menu on a second press instead of reopening it", async () => {
      jarvis["chatNames"] = () => Promise.resolve(["Acme", "Vendors"]);
      initWorkspace(["acme"]);
      await flush();
      const button = document.getElementById("workspace-open-chat");

      button?.click();
      await flush();
      button?.click();
      await flush();

      expect(document.getElementById("workspace-chat-menu")?.hidden).toBe(true);
    });

    it("activates an open tab rather than opening a second", async () => {
      jarvis["chatNames"] = () => Promise.resolve(["Acme"]);
      initWorkspace(["acme"]);
      await flush();
      renderWorkspace({
        tabs: [tab({ id: "t1", project: "acme", kind: "chat", detail: "Acme" })],
        activeTabId: "t1",
      });

      document.getElementById("workspace-open-chat")?.click();
      await flush();

      expect(calls).toContainEqual({ call: "activateTab", args: ["t1"] });
      expect(calls.some((entry) => entry.call === "openChat")).toBe(false);
    });

    // A project may have both a Teams tenant and a Slack workspace, so the
    // tab's own `detail` decides which is already open, not the project.
    it("tells two chats of one project apart by detail", async () => {
      jarvis["chatNames"] = () => Promise.resolve(["Acme", "Vendors"]);
      initWorkspace(["acme"]);
      await flush();
      renderWorkspace({
        tabs: [tab({ id: "t1", project: "acme", kind: "chat", detail: "Acme" })],
        activeTabId: "t1",
      });

      document.getElementById("workspace-open-chat")?.click();
      await flush();
      chatMenuItems()[1]?.click();
      await flush();

      expect(calls).toContainEqual({ call: "openChat", args: ["acme", "Vendors"] });
    });

    // A chat name is config text rendered into the menu — a node with its
    // textContent set, never markup, same discipline as the cluster's.
    it("renders a chat name as text, not as markup", async () => {
      jarvis["chatNames"] = () => Promise.resolve(["<img src=x onerror=alert(1)>", "Vendors"]);
      initWorkspace(["acme"]);
      await flush();

      document.getElementById("workspace-open-chat")?.click();
      await flush();

      expect(document.querySelector("#workspace-chat-menu img")).toBeNull();
      expect(chatMenuItems()[0]?.textContent).toBe("<img src=x onerror=alert(1)>");
    });

    it("shows the failure text when main refuses", async () => {
      jarvis["chatNames"] = () => Promise.resolve(["Acme"]);
      jarvis["openChat"] = () =>
        Promise.resolve({ ok: false, text: "Could not open that chat.", language: "en" });
      initWorkspace(["acme"]);
      await flush();
      renderWorkspace({ tabs: [], activeTabId: undefined });

      document.getElementById("workspace-open-chat")?.click();
      await flush();

      expect(document.getElementById("workspace-tool-status")?.textContent).toBe(
        "Could not open that chat.",
      );
    });

    it("disables the button for a project with no chat, with the reason shown", async () => {
      jarvis["chatNames"] = () => Promise.resolve([]);
      initWorkspace(["acme"]);
      await flush();

      const button = document.getElementById("workspace-open-chat") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("No chat configured for this project.");
    });

    it("enables the button for a project with chat configured", async () => {
      jarvis["chatNames"] = () => Promise.resolve(["Acme"]);
      initWorkspace(["acme"]);
      await flush();

      const button = document.getElementById("workspace-open-chat") as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.title).toBe("Open the project's chat");
    });
  });

  // The personal browser declares no clusters, so it falls out of the same
  // per-project check rather than needing a rule of its own.
  it("disables the button for the personal browser", async () => {
    jarvis["clusterNames"] = () => Promise.resolve([]);
    initWorkspace(["acme"]);
    await flush();
    const select = document.getElementById("workspace-project") as HTMLSelectElement;

    select.value = "__personal__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect((document.getElementById("workspace-open-cluster") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  // A menu left open over a project switch closes over the OLD project: its
  // items' click handlers still carry the project they were built for, so a
  // stale menu would open or activate the wrong project's cluster tab. Same
  // bug class closeEditorMenu already guards against in switchToProject.
  it("closes the menu when switching to a different project", async () => {
    jarvis["clusterNames"] = () => Promise.resolve(["dev", "chaos"]);
    initWorkspace(["acme", "storefront"]);
    await flush();

    document.getElementById("workspace-open-cluster")?.click();
    await flush();
    expect(document.getElementById("workspace-cluster-menu")?.hidden).toBe(false);

    const select = document.getElementById("workspace-project") as HTMLSelectElement;
    select.value = "storefront";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect(document.getElementById("workspace-cluster-menu")?.hidden).toBe(true);
  });
});

// Measured on this machine: click to a painted Editor tab is 1.9-2.3s with
// the binaries warm and 9-13s cold, and every millisecond of it used to be
// spent with an empty toolbar and a live-looking button — the app read as
// frozen. The wait is code-server's own boot and cannot be removed, so it
// has to be visible.
describe("starting a hosted app says so", () => {
  let jarvis: Record<string, unknown>;

  beforeEach(() => {
    harness();
    jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    initWorkspace(["acme"]);
    renderWorkspace({ tabs: [], activeTabId: undefined });
  });

  it("announces the editor start and disables the button until it answers", async () => {
    let release = (): void => undefined;
    jarvis["openEditor"] = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, value: "http://127.0.0.1:9001/?folder=%2Fp" });
      });
    const button = document.getElementById("workspace-open-editor") as HTMLButtonElement;

    button.click();
    await flush();

    expect(document.getElementById("workspace-tool-status")?.textContent).toBe(
      "Starting the editor…",
    );
    expect(button.disabled).toBe(true);

    release();
    await flush();

    expect(button.disabled).toBe(false);
    expect(document.getElementById("workspace-tool-status")?.textContent).toBe("");
  });

  it("announces the database start and disables the button until it answers", async () => {
    let release = (): void => undefined;
    jarvis["openDatabase"] = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            ok: true,
            value: { url: "http://127.0.0.1:51234/" },
          });
      });
    const button = document.getElementById("workspace-open-database") as HTMLButtonElement;

    button.click();
    await flush();

    expect(document.getElementById("workspace-tool-status")?.textContent).toBe(
      "Starting the database browser…",
    );
    expect(button.disabled).toBe(true);

    release();
    await flush();

    expect(button.disabled).toBe(false);
  });

  it("re-enables the button and shows the error when the start fails", async () => {
    jarvis["openEditor"] = () =>
      Promise.resolve({ ok: false, text: "Could not open the editor.", language: "en" });
    const button = document.getElementById("workspace-open-editor") as HTMLButtonElement;

    button.click();
    await flush();

    expect(button.disabled).toBe(false);
    expect(document.getElementById("workspace-tool-status")?.textContent).toBe(
      "Could not open the editor.",
    );
  });
});

// The click is not the first thing that says "this user wants the editor" —
// the pointer arriving on the button is, and it arrives a few hundred
// milliseconds earlier. The managers share one spawn per project, so a
// pre-warm the user goes on to click costs nothing extra, and one they do
// not click costs exactly what clicking it later would have.
describe("pre-warming a hosted app on hover", () => {
  let calls: Recorded[];
  let jarvis: Record<string, unknown>;
  let warmed: string[];
  let clusterArgs: unknown[][];

  beforeEach(() => {
    calls = harness();
    jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    warmed = [];
    clusterArgs = [];
    jarvis["openEditor"] = (project: string) => {
      warmed.push(`editor:${project}`);
      return Promise.resolve({ ok: true, value: "http://127.0.0.1:9001/?folder=%2Fp" });
    };
    jarvis["openDatabase"] = (project: string) => {
      warmed.push(`database:${project}`);
      return Promise.resolve({
        ok: true,
        value: { url: "http://127.0.0.1:51234/" },
      });
    };
    jarvis["openCluster"] = (project: string, name: string, background?: boolean) => {
      warmed.push(`cluster:${project}:${name}`);
      clusterArgs.push([project, name, background]);
      return Promise.resolve({ ok: true, value: "http://127.0.0.1:5000/c/ctx-a" });
    };
    initWorkspace(["acme"]);
    renderWorkspace({ tabs: [], activeTabId: undefined });
  });

  it("starts code-server when the pointer reaches the Editor button, without opening a tab", async () => {
    document.getElementById("workspace-open-editor")?.dispatchEvent(new Event("pointerenter"));
    await flush();

    expect(warmed).toEqual(["editor:acme"]);
    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
    // Nothing is being asked for yet, so nothing is announced.
    expect(document.getElementById("workspace-tool-status")?.textContent).toBe("");
  });

  it("starts DbGate when the pointer reaches the Database button", async () => {
    document.getElementById("workspace-open-database")?.dispatchEvent(new Event("pointerenter"));
    await flush();

    expect(warmed).toEqual(["database:acme"]);
    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
  });

  // A pointer wandering back and forth over a toolbar is not new intent.
  it("asks only once per project, however often the pointer crosses the button", async () => {
    const button = document.getElementById("workspace-open-editor");
    button?.dispatchEvent(new Event("pointerenter"));
    button?.dispatchEvent(new Event("pointerenter"));
    button?.dispatchEvent(new Event("pointerenter"));
    await flush();

    expect(warmed).toEqual(["editor:acme"]);
  });

  it("does not pre-warm a project whose tab is already open", async () => {
    renderWorkspace({
      tabs: [tab({ id: "tab-9", kind: "editor", url: "http://127.0.0.1:9001/" })],
      activeTabId: "tab-9",
    });

    document.getElementById("workspace-open-editor")?.dispatchEvent(new Event("pointerenter"));
    await flush();

    expect(warmed).toEqual([]);
  });

  // Keyboard users never generate a pointerenter; tabbing to the button is
  // the same signal.
  it("pre-warms when the button takes keyboard focus", async () => {
    document.getElementById("workspace-open-editor")?.dispatchEvent(new Event("focus"));
    await flush();

    expect(warmed).toEqual(["editor:acme"]);
  });

  // Pre-warming has to warm the thing the click would actually open. A
  // project with a configured root does not want an editor at its own
  // directory, so warming one there spawns a code-server nobody asked for
  // and leaves the click to spawn a second at the right place.
  it("warms the configured root, not the project directory", async () => {
    jarvis["editorRoots"] = () => Promise.resolve(["portal-vue"]);
    jarvis["openEditor"] = (project: string, root: string | undefined) => {
      warmed.push(`editor:${project}:${root ?? "-"}`);
      return Promise.resolve({ ok: true, value: "http://127.0.0.1:9001/?folder=%2Fp" });
    };

    document.getElementById("workspace-open-editor")?.dispatchEvent(new Event("pointerenter"));
    await flush();

    expect(warmed).toEqual(["editor:acme:portal-vue"]);
  });

  // With two roots the click opens a menu and nothing is started, so there
  // is no single answer to warm — guessing one would spawn a server for a
  // root the user may never pick.
  it("warms nothing when the button would offer a menu", async () => {
    jarvis["editorRoots"] = () => Promise.resolve(["portal-vue", "api"]);

    document.getElementById("workspace-open-editor")?.dispatchEvent(new Event("pointerenter"));
    await flush();

    expect(warmed).toEqual([]);
  });

  it("does not let a failed pre-warm reach the status line", async () => {
    jarvis["openEditor"] = () =>
      Promise.resolve({ ok: false, text: "Could not open the editor.", language: "en" });

    document.getElementById("workspace-open-editor")?.dispatchEvent(new Event("pointerenter"));
    await flush();

    expect(document.getElementById("workspace-tool-status")?.textContent).toBe("");
  });

  it("starts headlamp-server when the pointer reaches the Cluster button", async () => {
    jarvis["clusterNames"] = () => Promise.resolve(["dev"]);

    document.getElementById("workspace-open-cluster")?.dispatchEvent(new Event("pointerenter"));
    await flush();

    expect(warmed).toEqual(["cluster:acme:dev"]);
    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
  });

  // Unlike the editor, every cluster of a project shares one server, so
  // warming any one of them — even with a menu pending — warms them all.
  it("warms the first cluster even when the click would offer a menu", async () => {
    jarvis["clusterNames"] = () => Promise.resolve(["dev", "chaos"]);

    document.getElementById("workspace-open-cluster")?.dispatchEvent(new Event("pointerenter"));
    await flush();

    expect(warmed).toEqual(["cluster:acme:dev"]);
  });

  it("does not pre-warm the cluster browser for a project with none configured", async () => {
    jarvis["clusterNames"] = () => Promise.resolve([]);

    document.getElementById("workspace-open-cluster")?.dispatchEvent(new Event("pointerenter"));
    await flush();

    expect(warmed).toEqual([]);
  });

  // Warming a cluster is a headlamp-server spawn; logging in to AWS for one
  // is a terminal tab and an MFA push on the user's phone. The flag is what
  // tells main which of those a hover is allowed to become — without it, a
  // pointer crossing the toolbar starts a real login.
  it("marks a warmed cluster open as a background call so it cannot start a login", async () => {
    jarvis["clusterNames"] = () => Promise.resolve(["dev"]);

    document.getElementById("workspace-open-cluster")?.dispatchEvent(new Event("pointerenter"));
    await flush();

    expect(clusterArgs).toEqual([["acme", "dev", true]]);
  });

  it("does not mark a clicked cluster open as background", async () => {
    jarvis["clusterNames"] = () => Promise.resolve(["dev"]);

    document.getElementById("workspace-open-cluster")?.dispatchEvent(new Event("click"));
    await flush();

    expect(clusterArgs).toEqual([["acme", "dev", undefined]]);
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

  // The desktop answers DbGate's login itself (Electron's `login` event),
  // so the tab opens already authenticated and nothing is left to show.
  it("clears the status line on success instead of showing the credential", async () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    document.getElementById("workspace-open-database")?.click();
    await flush();

    expect(document.getElementById("workspace-tool-status")?.textContent).toBe("");
    expect(calls).toContainEqual({
      call: "openTab",
      args: ["acme", "http://127.0.0.1:51234/", "database"],
    });
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

describe("open a terminal", () => {
  let calls: Recorded[];
  let jarvis: Record<string, unknown>;

  beforeEach(() => {
    calls = harness();
    jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    initWorkspace(["acme", "storefront"]);
  });

  it("opens a terminal for the selected project", async () => {
    document.getElementById("workspace-open-terminal")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "openTerminal", args: ["acme"] });
  });

  // Unlike the editor and the database there is no instance to reuse: two
  // terminals in one project is an ordinary thing to want.
  it("opens a second terminal for a project that already has one", async () => {
    renderWorkspace({ tabs: [tab({ kind: "terminal", url: "" })], activeTabId: "tab-1" });

    document.getElementById("workspace-open-terminal")?.click();
    await flush();

    expect(calls.filter((entry) => entry.call === "openTerminal")).toHaveLength(1);
  });

  it("shows a localised error when the shell cannot start", async () => {
    jarvis["openTerminal"] = () =>
      Promise.resolve({ ok: false, text: "I don't know a project by that name.", language: "en" });

    document.getElementById("workspace-open-terminal")?.click();
    await flush();

    expect(document.getElementById("workspace-tool-status")?.textContent).toBe(
      "I don't know a project by that name.",
    );
  });

  // The page slot and the terminal are flex siblings that both grow; with
  // both showing they would split the height and the terminal would get
  // half a screen.
  it("gives the terminal the whole slot by hiding the page while it is active", () => {
    renderWorkspace({ tabs: [tab({ kind: "terminal", url: "" })], activeTabId: "tab-1" });

    expect(document.getElementById("workspace-page")?.hasAttribute("hidden")).toBe(true);
  });

  it("gives an api tab the whole slot too", () => {
    renderWorkspace({ tabs: [tab({ kind: "api", url: "" })], activeTabId: "tab-1" });

    expect(document.getElementById("workspace-page")?.hasAttribute("hidden")).toBe(true);
  });

  // The sidebar and the page slot share a wrapping row now (#workspace-body)
  // instead of the page being a direct flex sibling of the terminal — so
  // hiding the page alone is not enough. Left visible, the empty row would
  // still claim its own flex share and squeeze the terminal into half the
  // screen, exactly the bug the page's own hiding exists to avoid.
  it("hides the body row too, so it does not compete with the terminal for height", () => {
    renderWorkspace({ tabs: [tab({ kind: "terminal", url: "" })], activeTabId: "tab-1" });

    expect(document.getElementById("workspace-body")?.hasAttribute("hidden")).toBe(true);
  });

  it("shows the body row again when a hosted tab is reactivated", () => {
    renderWorkspace({ tabs: [tab({ kind: "terminal", url: "" })], activeTabId: "tab-1" });
    renderWorkspace({ tabs: [tab({ id: "tab-2", kind: "web" })], activeTabId: "tab-2" });

    expect(document.getElementById("workspace-body")?.hasAttribute("hidden")).toBe(false);
  });

  it("shows the page slot again when a hosted tab is reactivated", () => {
    renderWorkspace({ tabs: [tab({ kind: "terminal", url: "" })], activeTabId: "tab-1" });
    renderWorkspace({ tabs: [tab({ id: "tab-2", kind: "web" })], activeTabId: "tab-2" });

    expect(document.getElementById("workspace-page")?.hasAttribute("hidden")).toBe(false);
  });

  it("hides the address bar and bookmarks while a terminal tab is active", () => {
    renderWorkspace({ tabs: [tab({ kind: "terminal", url: "" })], activeTabId: "tab-1" });

    expect(document.getElementById("workspace-bar")?.hasAttribute("hidden")).toBe(true);
    expect(document.getElementById("workspace-bookmarks")?.hasAttribute("hidden")).toBe(true);
  });
});

describe("bookmarks sidebar toggle", () => {
  let calls: Recorded[];

  beforeEach(() => {
    calls = harness();
    initWorkspace(["acme"]);
    void calls;
  });

  const sidebar = () => document.getElementById("workspace-bookmarks") as HTMLElement;

  it("starts visible", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });

    expect(sidebar().hidden).toBe(false);
  });

  it("hides the sidebar when toggled off, and brings it back", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });

    document.getElementById("workspace-toggle-bookmarks")?.click();
    expect(sidebar().hidden).toBe(true);

    document.getElementById("workspace-toggle-bookmarks")?.click();
    expect(sidebar().hidden).toBe(false);
  });

  it("keeps the sidebar hidden across renders once toggled off", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    document.getElementById("workspace-toggle-bookmarks")?.click();

    renderWorkspace({ tabs: [tab({ id: "tab-2" })], activeTabId: "tab-2" });

    expect(sidebar().hidden).toBe(true);
  });

  // The toggle is the user's preference for browser tabs; a hosted app has
  // no bookmarks sidebar at all, and toggling it back on must not put one
  // over an editor.
  it("does not reveal the sidebar over a hosted-app tab", () => {
    renderWorkspace({ tabs: [tab({ kind: "editor" })], activeTabId: "tab-1" });

    document.getElementById("workspace-toggle-bookmarks")?.click();

    expect(sidebar().hidden).toBe(true);
  });

  it("marks the toggle as on while the sidebar is showing", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    const toggle = document.getElementById("workspace-toggle-bookmarks") as HTMLElement;

    expect(toggle.classList.contains("workspace-nav--on")).toBe(true);

    toggle.click();

    expect(toggle.classList.contains("workspace-nav--on")).toBe(false);

    // Module state outlives a test; leave the preference as it was found.
    toggle.click();
  });

  // The bar sits above the page slot now, so showing or hiding it moves the
  // hosted view's top edge. Nothing else re-measures: the window fires no
  // reflow event for a DOM change the renderer made itself.
  it("re-measures the page slot when the bar is toggled", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    const page = document.getElementById("workspace-page") as HTMLElement;
    page.getBoundingClientRect = () => ({ x: 0, y: 200, width: 800, height: 500 }) as DOMRect;
    calls.length = 0;

    document.getElementById("workspace-toggle-bookmarks")?.click();

    expect(calls).toContainEqual({
      call: "setWorkspaceBounds",
      args: [{ x: 0, y: 200, width: 800, height: 500, devicePixelRatio: window.devicePixelRatio }],
    });
  });
});

/** What main pushes at the renderer about DevTools, captured by the harness
 *  so a test can play main's part. */
const devToolsHooks: {
  dockChosen?: (dock: DevToolsDock) => void;
  closed?: (tabId: string) => void;
} = {};

describe("devtools panel", () => {
  let calls: Recorded[];

  beforeEach(() => {
    calls = harness();
    initWorkspace(["acme"]);
    // Which tabs have DevTools open is module state that does not reset
    // between tests; a render with no tabs prunes every id, which is the
    // same path a closed tab takes.
    renderWorkspace({ tabs: [], activeTabId: undefined });
    // So is the dock side, and it is remembered besides.
    document.getElementById("workspace-devtools-dock-bottom")?.click();
  });

  const panel = () => document.getElementById("workspace-devtools") as HTMLElement;
  const handle = () => document.getElementById("workspace-devtools-handle") as HTMLElement;
  const stage = () => document.getElementById("workspace-stage") as HTMLElement;
  const toggle = () => document.getElementById("workspace-toggle-devtools") as HTMLElement;
  const click = (id: string) => document.getElementById(id)?.click();

  it("docks to the right as a row, sized by width", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    toggle().click();

    click("workspace-devtools-dock-right");

    expect(stage().classList.contains("workspace-stage--right")).toBe(true);
    expect(stage().classList.contains("workspace-stage--bottom")).toBe(false);
    expect(panel().style.width).not.toBe("");
    expect(panel().style.height).toBe("");
    expect(calls).toContainEqual({ call: "setDevToolsDock", args: ["right"] });
  });

  it("docks to the left as the same row reversed", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    toggle().click();

    click("workspace-devtools-dock-left");

    expect(stage().classList.contains("workspace-stage--left")).toBe(true);
    expect(document.getElementById("workspace-devtools-dock-left")?.classList).toContain(
      "workspace-devtools-button--on",
    );
    expect(document.getElementById("workspace-devtools-dock-bottom")?.classList).not.toContain(
      "workspace-devtools-button--on",
    );
  });

  // Undocked they are a window of their own: no room taken here, but they
  // are still open, and the toggle has to say so.
  it("takes no room undocked, but stays open", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    toggle().click();

    click("workspace-devtools-dock-undocked");

    expect(panel().hidden).toBe(true);
    expect(handle().hidden).toBe(true);
    expect(toggle().classList.contains("workspace-nav--on")).toBe(true);
    expect(calls).toContainEqual({ call: "setDevToolsDock", args: ["undocked"] });
    expect(calls).not.toContainEqual({ call: "setDevTools", args: ["tab-1", false] });
  });

  it("remembers the dock side and tells main at the next start", () => {
    click("workspace-devtools-dock-right");

    calls = harness();
    initWorkspace(["acme"]);

    expect(calls).toContainEqual({ call: "setDevToolsDock", args: ["right"] });
  });

  // An undocked window has no dock buttons, so right-click is the way back.
  it("asks main for the dock menu on right-click", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });

    toggle().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(calls).toContainEqual({ call: "showDevToolsDockMenu", args: ["bottom"] });
  });

  it("opens DevTools where a side chosen from that menu puts them", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });

    devToolsHooks.dockChosen?.("right");

    expect(calls).toContainEqual({ call: "setDevTools", args: ["tab-1", true] });
    expect(panel().hidden).toBe(false);
    expect(stage().classList.contains("workspace-stage--right")).toBe(true);
  });

  // Otherwise the toggle stays lit, and the next click "closes" DevTools
  // that are already gone.
  it("forgets DevTools whose window the user closed", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    toggle().click();

    devToolsHooks.closed?.("tab-1");
    expect(toggle().classList.contains("workspace-nav--on")).toBe(false);

    toggle().click();
    expect(calls.filter((entry) => entry.call === "setDevTools").at(-1)?.args).toEqual([
      "tab-1",
      true,
    ]);
  });

  it("closes from the panel's own close button", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    toggle().click();

    click("workspace-devtools-close");

    expect(panel().hidden).toBe(true);
    expect(calls).toContainEqual({ call: "setDevTools", args: ["tab-1", false] });
  });

  it("resizes the panel's width when docked to a side", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    toggle().click();
    click("workspace-devtools-dock-right");
    stage().getBoundingClientRect = () =>
      ({
        x: 0,
        y: 100,
        width: 1000,
        height: 600,
        left: 0,
        right: 1000,
        top: 100,
        bottom: 700,
      }) as DOMRect;

    handle().dispatchEvent(new MouseEvent("mousedown", { clientX: 600, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 300, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(panel().style.width).toBe("700px");
  });

  it("is closed until it is asked for", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });

    expect(panel().hidden).toBe(true);
    expect(handle().hidden).toBe(true);
  });

  it("opens for the active tab and tells main which tab it belongs to", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });

    document.getElementById("workspace-toggle-devtools")?.click();

    expect(panel().hidden).toBe(false);
    expect(handle().hidden).toBe(false);
    expect(calls).toContainEqual({ call: "setDevTools", args: ["tab-1", true] });
  });

  it("closes on a second click", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    document.getElementById("workspace-toggle-devtools")?.click();

    document.getElementById("workspace-toggle-devtools")?.click();

    expect(panel().hidden).toBe(true);
    expect(calls).toContainEqual({ call: "setDevTools", args: ["tab-1", false] });
  });

  // DevTools belong to one page, so the panel follows the tab rather than
  // the window: switching to a tab that never opened them shows nothing.
  it("is remembered per tab", () => {
    const tabs = [tab(), tab({ id: "tab-2" })];
    renderWorkspace({ tabs, activeTabId: "tab-1" });
    document.getElementById("workspace-toggle-devtools")?.click();

    renderWorkspace({ tabs, activeTabId: "tab-2" });
    expect(panel().hidden).toBe(true);

    renderWorkspace({ tabs, activeTabId: "tab-1" });
    expect(panel().hidden).toBe(false);
  });

  it("does nothing without an active tab to inspect", () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    document.getElementById("workspace-toggle-devtools")?.click();

    expect(panel().hidden).toBe(true);
    expect(calls.some((entry) => entry.call === "setDevTools")).toBe(false);
  });

  it("forgets a tab that has been closed", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    document.getElementById("workspace-toggle-devtools")?.click();

    renderWorkspace({ tabs: [], activeTabId: undefined });
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });

    expect(panel().hidden).toBe(true);
  });

  it("marks its toggle as on while the panel is showing", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    const toggle = document.getElementById("workspace-toggle-devtools") as HTMLElement;

    toggle.click();
    expect(toggle.classList.contains("workspace-nav--on")).toBe(true);

    toggle.click();
    expect(toggle.classList.contains("workspace-nav--on")).toBe(false);
  });

  // Both rectangles are measured by the renderer, exactly as the page slot
  // already was — the hosted views know nothing about CSS.
  it("reports the panel's own rectangle to main", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    // The slot under the panel's head, which is where the view goes.
    (document.getElementById("workspace-devtools-slot") as HTMLElement).getBoundingClientRect =
      () => ({ x: 10, y: 400, width: 900, height: 300 }) as DOMRect;

    document.getElementById("workspace-toggle-devtools")?.click();

    expect(calls).toContainEqual({
      call: "setDevToolsBounds",
      args: [{ x: 10, y: 400, width: 900, height: 300, devicePixelRatio: window.devicePixelRatio }],
    });
  });

  it("resizes the panel when its handle is dragged", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });
    document.getElementById("workspace-toggle-devtools")?.click();
    const before = panel().style.height;
    // jsdom lays nothing out, so the column it is a fraction of has to be
    // given a real box for the drag to divide.
    const column = panel().parentElement as HTMLElement;
    column.getBoundingClientRect = () =>
      ({ x: 0, y: 100, width: 1000, height: 600, bottom: 700, top: 100 }) as DOMRect;

    handle().dispatchEvent(new MouseEvent("mousedown", { clientY: 500, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientY: 300, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(panel().style.height).not.toBe(before);
  });
});

describe("open the API tab", () => {
  let calls: Recorded[];
  let jarvis: Record<string, unknown>;

  beforeEach(() => {
    calls = harness();
    jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    initWorkspace(["acme", "storefront"]);
  });

  it("opens an api tab for the selected project", async () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    document.getElementById("workspace-open-api")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "openApiTab", args: ["acme"] });
  });

  // One per project: a collection tree is a view of the filesystem, not a
  // session, so a second tab would be a duplicate of the first.
  it("activates the existing api tab instead of opening a second", async () => {
    renderWorkspace({ tabs: [tab({ id: "tab-5", kind: "api", url: "" })], activeTabId: "tab-5" });

    document.getElementById("workspace-open-api")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "activateTab", args: ["tab-5"] });
    expect(calls.some((entry) => entry.call === "openApiTab")).toBe(false);
  });

  it("opens one when the existing api tab belongs to another project", async () => {
    renderWorkspace({
      tabs: [tab({ id: "tab-5", kind: "api", project: "storefront", url: "" })],
      activeTabId: "tab-5",
    });

    document.getElementById("workspace-open-api")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "openApiTab", args: ["acme"] });
  });

  it("shows a localised failure in the shared status line", async () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });
    jarvis["openApiTab"] = () =>
      Promise.resolve({ ok: false, text: "I don't know a project by that name.", language: "en" });

    document.getElementById("workspace-open-api")?.click();
    await flush();

    expect(document.getElementById("workspace-tool-status")?.textContent).toBe(
      "I don't know a project by that name.",
    );
  });

  it("opens a docker tab for the selected project", async () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    document.getElementById("workspace-open-docker")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "openDockerTab", args: ["acme"] });
  });

  // One per project, for the same reason the api tab is one per project:
  // a second would show the same containers as the first.
  it("activates the existing docker tab instead of opening a second", async () => {
    renderWorkspace({
      tabs: [tab({ id: "tab-5", kind: "docker", url: "" })],
      activeTabId: "tab-5",
    });

    document.getElementById("workspace-open-docker")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "activateTab", args: ["tab-5"] });
    expect(calls.some((entry) => entry.call === "openDockerTab")).toBe(false);
  });

  it("opens one when the existing docker tab belongs to another project", async () => {
    renderWorkspace({
      tabs: [tab({ id: "tab-5", kind: "docker", project: "storefront", url: "" })],
      activeTabId: "tab-5",
    });

    document.getElementById("workspace-open-docker")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "openDockerTab", args: ["acme"] });
  });

  it("shows a localised failure in the shared status line", async () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });
    jarvis["openDockerTab"] = () =>
      Promise.resolve({ ok: false, text: "I don't know a project by that name.", language: "en" });

    document.getElementById("workspace-open-docker")?.click();
    await flush();

    expect(document.getElementById("workspace-tool-status")?.textContent).toBe(
      "I don't know a project by that name.",
    );
  });

  it("disables the docker button for a project that declares no containers", async () => {
    jarvis["dockerNames"] = () => Promise.resolve({ ok: true, value: [] });
    renderWorkspace({ tabs: [], activeTabId: undefined });
    await flush();

    const button = document.getElementById("workspace-open-docker") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("No containers configured for this project");
  });
});

// The project-independent browser. It is a project as far as every other
// part of the Workspace is concerned — the tab store, the partition, the
// bookmark file, the tab strip's grouping — and the only thing that makes
// it different is that it has no directory behind it. See src/personal.ts.
describe("the personal browser", () => {
  let calls: Recorded[];
  const select = (): HTMLSelectElement =>
    document.getElementById("workspace-project") as HTMLSelectElement;

  const chooseProject = (value: string): void => {
    select().value = value;
    select().dispatchEvent(new Event("change"));
  };

  beforeEach(() => {
    calls = harness();
    initWorkspace(["acme", "storefront"]);
  });

  it("offers it under a name, never under its key", () => {
    const personal = [...select().options].at(-1);

    expect(personal?.value).toBe("__personal__");
    expect(personal?.textContent).toBe("Personal");
  });

  // The whole point: a tab opened here is not a project's tab, so changing
  // project must not disturb it.
  it("keeps its tabs when the project selection changes and comes back", async () => {
    chooseProject("__personal__");
    await flush();
    const tabs = [tab({ id: "tab-p", project: "__personal__", title: "YouTube" })];
    renderWorkspace({ tabs, activeTabId: "tab-p" });

    expect(document.querySelectorAll("#workspace-tabs .workspace-tab")).toHaveLength(1);

    chooseProject("acme");
    await flush();
    renderWorkspace({ tabs, activeTabId: "tab-p" });
    // Another project's tabs collapse into a pill; they are not closed.
    expect(document.querySelectorAll("#workspace-tabs .workspace-tab-group")).toHaveLength(1);

    chooseProject("__personal__");
    await flush();
    renderWorkspace({ tabs, activeTabId: "tab-p" });

    expect(document.querySelectorAll("#workspace-tabs .workspace-tab")).toHaveLength(1);
    expect(calls.filter((c) => c.call === "closeTab")).toEqual([]);
  });

  // A collapsed pill is the one place a project's name is drawn in the tab
  // strip, so the key must not surface there either.
  it("labels its collapsed pill with the name, not the key", () => {
    renderWorkspace({
      tabs: [tab({ id: "tab-p", project: "__personal__" })],
      activeTabId: "tab-p",
    });

    expect(
      document.querySelector("#workspace-tab-group, .workspace-tab-group")?.textContent,
    ).toContain("Personal");
  });

  it.each(["editor", "database", "terminal", "api"])(
    "disables the %s button, which needs a directory it does not have",
    async (tool) => {
      chooseProject("__personal__");
      await flush();

      const button = document.getElementById(`workspace-open-${tool}`) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toContain("no folder on disk");
    },
  );

  it("says why they are disabled, rather than leaving four dead controls", async () => {
    chooseProject("__personal__");
    await flush();

    expect(document.getElementById("workspace-tool-status")?.textContent).toContain(
      "no folder on disk",
    );
  });

  it("gives the buttons back, and their own tooltips, on returning to a project", async () => {
    chooseProject("__personal__");
    await flush();
    chooseProject("acme");
    await flush();

    const button = document.getElementById("workspace-open-editor") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("Open the project's files in a full code editor");
    expect(document.getElementById("workspace-tool-status")?.textContent).toBe("");
  });

  // Bookmarks are keyed by project string in one file, so the personal
  // browser gets its own list for free — but only if the key is what goes
  // over the wire.
  it("reads and writes its bookmarks under its own key", async () => {
    chooseProject("__personal__");
    await flush();
    renderWorkspace({
      tabs: [tab({ id: "tab-p", project: "__personal__", url: "https://news.example" })],
      activeTabId: "tab-p",
    });
    (document.getElementById("workspace-bookmark-toggle") as HTMLButtonElement).click();
    await flush();

    expect(calls.find((c) => c.call === "addBookmark")?.args[0]).toBe("__personal__");
  });
});

// The "play popup": Chromium's Picture-in-Picture window, offered only
// where there is something to float.
describe("the picture-in-picture button", () => {
  let calls: Recorded[];
  const pip = (): HTMLButtonElement =>
    document.getElementById("workspace-pip") as HTMLButtonElement;

  beforeEach(() => {
    calls = harness();
    initWorkspace(["acme", "storefront"]);
  });

  it("stays hidden on a page with no video playing", () => {
    renderWorkspace({ tabs: [tab()], activeTabId: "tab-1" });

    expect(pip().hidden).toBe(true);
  });

  it("stays hidden with no tab open at all", () => {
    renderWorkspace({ tabs: [], activeTabId: undefined });

    expect(pip().hidden).toBe(true);
  });

  it("appears once the page reports a video playing", () => {
    renderWorkspace({ tabs: [tab({ hasPlayingVideo: true })], activeTabId: "tab-1" });

    expect(pip().hidden).toBe(false);
    expect(pip().title).toContain("Float this video");
  });

  it("asks the main process to float the active tab's video", () => {
    renderWorkspace({ tabs: [tab({ hasPlayingVideo: true })], activeTabId: "tab-1" });
    pip().click();

    expect(calls.filter((c) => c.call === "requestPictureInPicture")).toEqual([
      { call: "requestPictureInPicture", args: ["tab-1"] },
    ]);
  });

  it("goes away again when the video stops", () => {
    renderWorkspace({ tabs: [tab({ hasPlayingVideo: true })], activeTabId: "tab-1" });
    renderWorkspace({ tabs: [tab({ hasPlayingVideo: false })], activeTabId: "tab-1" });

    expect(pip().hidden).toBe(true);
  });
});

describe("a page taking full screen", () => {
  beforeEach(() => {
    harness();
    initWorkspace(["acme"]);
  });

  // The bug: a video's full screen button made Jarvis's own window look
  // like it went full screen while the video stayed exactly where it was,
  // inside the tab slot. Chromium owns the page; the only thing left for
  // the renderer to do is get its chrome out of the way so the slot the
  // view is pinned to is the whole window.
  it("marks the document so the chrome can stand down, and remeasures", () => {
    renderWorkspace({
      tabs: [tab({ pageFullscreen: true })],
      activeTabId: "tab-1",
    });

    expect(document.body.classList.contains("page-fullscreen")).toBe(true);
    expect(($("workspace-tabs") as HTMLElement).hidden).toBe(true);
    expect(($("workspace-bar") as HTMLElement).hidden).toBe(true);
  });

  it("puts the chrome back when the page gives full screen up", () => {
    renderWorkspace({ tabs: [tab({ pageFullscreen: true })], activeTabId: "tab-1" });
    renderWorkspace({ tabs: [tab({ pageFullscreen: false })], activeTabId: "tab-1" });

    expect(document.body.classList.contains("page-fullscreen")).toBe(false);
    expect(($("workspace-tabs") as HTMLElement).hidden).toBe(false);
    expect(($("workspace-bar") as HTMLElement).hidden).toBe(false);
  });

  // A background tab's stale flag must not strip the chrome off the tab you
  // are actually looking at.
  it("ignores full screen on a tab that is not the active one", () => {
    renderWorkspace({
      tabs: [tab({ id: "tab-1" }), tab({ id: "tab-2", pageFullscreen: true })],
      activeTabId: "tab-1",
    });

    expect(document.body.classList.contains("page-fullscreen")).toBe(false);
  });
});

function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`no #${id}`);
  return element;
}
