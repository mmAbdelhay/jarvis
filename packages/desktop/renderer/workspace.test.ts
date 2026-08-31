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
        <button id="workspace-new-tab"></button>
        <div id="workspace-bar">
          <button id="workspace-back"></button>
          <button id="workspace-forward"></button>
          <button id="workspace-reload"></button>
          <input id="workspace-address" />
        </div>
        <div id="workspace-error" hidden></div>
        <div id="workspace-page"></div>
      </div>
      <button id="workspace-open-editor"></button>
      <span id="workspace-editor-status"></span>
      <div id="workspace-docs" hidden>
        <div id="workspace-doc-list"></div>
        <div id="workspace-doc-title"></div>
        <button id="workspace-doc-mode-writing"></button>
        <button id="workspace-doc-mode-dev"></button>
        <div id="workspace-doc-toolbar" hidden>
          <button id="workspace-doc-h1"></button>
          <button id="workspace-doc-h2"></button>
          <button id="workspace-doc-h3"></button>
          <button id="workspace-doc-bold"></button>
          <button id="workspace-doc-italic"></button>
          <button id="workspace-doc-strike"></button>
          <button id="workspace-doc-code"></button>
          <button id="workspace-doc-codeblock"></button>
          <button id="workspace-doc-ul"></button>
          <button id="workspace-doc-ol"></button>
          <button id="workspace-doc-quote"></button>
          <button id="workspace-doc-link"></button>
          <button id="workspace-doc-hr"></button>
          <span id="workspace-doc-save-status"></span>
          <button id="workspace-doc-save"></button>
        </div>
        <div id="workspace-doc-body"></div>
        <textarea id="workspace-doc-editor" hidden></textarea>
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
    listDocs: () => Promise.resolve({ ok: true, value: [] }),
    readDoc: () => Promise.resolve({ ok: true, value: [] }),
    readDocRaw: () => Promise.resolve({ ok: true, value: "" }),
    writeDoc: (...args: unknown[]) => {
      calls.push({ call: "writeDoc", args });
      return Promise.resolve({ ok: true, value: null });
    },
    parseDoc: () => Promise.resolve([]),
    taskOffsets: () => Promise.resolve([]),
    openEditor: () => Promise.resolve({ ok: true, value: "http://127.0.0.1:9001/?folder=%2Fp" }),
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

  // "+" lives in the tab strip now, not the address-bar row — none of
  // back/forward/reload/address means anything for a code editor, but the
  // whole row can hide safely, since "+" is no longer inside it.
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

  // "+" moves to the end of the tab strip's own row on every render — the
  // right side of the tabs, always reachable regardless of the active
  // tab's kind, never inside the row that hides for an editor tab.
  it("keeps + at the end of the tab strip, after every tab", () => {
    renderWorkspace({ tabs: [tab(), tab({ id: "tab-2" })], activeTabId: "tab-1" });

    const children = [...document.getElementById("workspace-tabs")!.children];
    expect(children.at(-1)?.id).toBe("workspace-new-tab");
  });

  it("keeps + reachable at the end of the strip even while an editor tab is active", () => {
    renderWorkspace({ tabs: [tab({ kind: "editor" })], activeTabId: "tab-1" });

    const children = [...document.getElementById("workspace-tabs")!.children];
    expect(children.at(-1)?.id).toBe("workspace-new-tab");
    expect(document.getElementById("workspace-new-tab")?.hasAttribute("hidden")).toBe(false);
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

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function openADoc(
  jarvis: Record<string, unknown>,
  overrides: { readDoc?: unknown; readDocRaw?: unknown; taskOffsets?: unknown } = {},
): Promise<void> {
  jarvis["listDocs"] = () =>
    Promise.resolve({ ok: true, value: [{ path: "notes.md", name: "notes.md" }] });
  jarvis["readDoc"] =
    overrides.readDoc ??
    (() =>
      Promise.resolve({
        ok: true,
        value: [{ kind: "paragraph", children: [{ kind: "text", text: "hello" }] }],
      }));
  jarvis["readDocRaw"] = overrides.readDocRaw ?? (() => Promise.resolve({ ok: true, value: "hello" }));
  // openDoc() itself calls taskOffsets while opening, so this override has
  // to be in place before the click below — setting it afterwards is too
  // late to affect the value openDoc() already cached.
  if (overrides.taskOffsets !== undefined) jarvis["taskOffsets"] = overrides.taskOffsets;

  document.getElementById("workspace-mode-docs")?.click();
  await flush();
  document.querySelector<HTMLElement>(".workspace-doc-item")?.click();
  await flush();
}

describe("workspace doc editing", () => {
  let calls: Recorded[];
  let jarvis: Record<string, unknown>;

  beforeEach(() => {
    calls = harness();
    initWorkspace(["acme"]);
    jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
  });

  it("populates the raw-text editor when a document opens", async () => {
    await openADoc(jarvis, { readDocRaw: () => Promise.resolve({ ok: true, value: "- [ ] a" }) });

    expect((document.getElementById("workspace-doc-editor") as HTMLTextAreaElement).value).toBe(
      "- [ ] a",
    );
  });

  it("shows the editor and toolbar, and hides the rendered body, in Dev mode", async () => {
    await openADoc(jarvis);

    document.getElementById("workspace-doc-mode-dev")?.click();

    expect((document.getElementById("workspace-doc-editor") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("workspace-doc-toolbar") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("workspace-doc-body") as HTMLElement).hidden).toBe(true);
  });

  it("re-renders the body from the editor's current text when switching back to Writing", async () => {
    await openADoc(jarvis);
    jarvis["parseDoc"] = (text: string) =>
      Promise.resolve([{ kind: "paragraph", children: [{ kind: "text", text: `parsed:${text}` }] }]);
    document.getElementById("workspace-doc-mode-dev")?.click();
    const editor = document.getElementById("workspace-doc-editor") as HTMLTextAreaElement;
    editor.value = "edited text";

    document.getElementById("workspace-doc-mode-writing")?.click();
    await flush();

    expect(document.getElementById("workspace-doc-body")?.textContent).toBe("parsed:edited text");
    expect((document.getElementById("workspace-doc-editor") as HTMLElement).hidden).toBe(true);
  });

  it("flips the matching raw-text offset and saves when a checkbox is clicked", async () => {
    await openADoc(jarvis, {
      readDoc: () =>
        Promise.resolve({
          ok: true,
          value: [
            {
              kind: "list",
              ordered: false,
              items: [[{ kind: "paragraph", children: [{ kind: "text", text: "a" }] }]],
              checked: [false],
            },
          ],
        }),
      readDocRaw: () => Promise.resolve({ ok: true, value: "- [ ] a" }),
      taskOffsets: () => Promise.resolve([3]),
    });

    const box = document.querySelector<HTMLInputElement>("input[type=checkbox]");
    expect(box).not.toBeNull();
    box!.checked = true;
    box!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect(calls).toContainEqual({ call: "writeDoc", args: ["acme", "notes.md", "- [x] a"] });
  });

  it("reverts the checkbox if the write fails", async () => {
    await openADoc(jarvis, {
      readDocRaw: () => Promise.resolve({ ok: true, value: "- [ ] a" }),
      taskOffsets: () => Promise.resolve([3]),
    });
    jarvis["writeDoc"] = () =>
      Promise.resolve({ ok: false, text: "Could not open that document.", language: "en" });

    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset["taskIndex"] = "0";
    document.getElementById("workspace-doc-body")?.append(box);
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect(box.checked).toBe(false);
  });

  it("clears the save status when the editor is typed into", async () => {
    await openADoc(jarvis);
    const status = document.getElementById("workspace-doc-save-status") as HTMLElement;
    status.textContent = "Saved.";
    const editor = document.getElementById("workspace-doc-editor") as HTMLTextAreaElement;

    editor.dispatchEvent(new Event("input", { bubbles: true }));

    expect(status.textContent).toBe("");
  });

  it("saves the editor's current text and shows a success status", async () => {
    await openADoc(jarvis);
    const editor = document.getElementById("workspace-doc-editor") as HTMLTextAreaElement;
    editor.value = "new content";

    document.getElementById("workspace-doc-save")?.click();
    await flush();

    expect(calls).toContainEqual({ call: "writeDoc", args: ["acme", "notes.md", "new content"] });
    expect(document.getElementById("workspace-doc-save-status")?.textContent).not.toBe("");
  });

  it("shows the localised error text when a save fails", async () => {
    await openADoc(jarvis);
    jarvis["writeDoc"] = () =>
      Promise.resolve({ ok: false, text: "Could not open that document.", language: "en" });

    document.getElementById("workspace-doc-save")?.click();
    await flush();

    expect(document.getElementById("workspace-doc-save-status")?.textContent).toBe(
      "Could not open that document.",
    );
  });

  it("wraps the selection in ** ** when Bold is clicked", async () => {
    await openADoc(jarvis, { readDocRaw: () => Promise.resolve({ ok: true, value: "hello world" }) });
    const editor = document.getElementById("workspace-doc-editor") as HTMLTextAreaElement;
    editor.setSelectionRange(0, 5);

    document.getElementById("workspace-doc-bold")?.click();

    expect(editor.value).toBe("**hello** world");
  });

  it("places the cursor between empty markers when nothing is selected", async () => {
    await openADoc(jarvis, { readDocRaw: () => Promise.resolve({ ok: true, value: "" }) });
    const editor = document.getElementById("workspace-doc-editor") as HTMLTextAreaElement;
    editor.setSelectionRange(0, 0);

    document.getElementById("workspace-doc-bold")?.click();

    expect(editor.value).toBe("****");
    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(2);
  });

  it("prefixes the current line with # # when H1 is clicked", async () => {
    await openADoc(jarvis, { readDocRaw: () => Promise.resolve({ ok: true, value: "a line" }) });
    const editor = document.getElementById("workspace-doc-editor") as HTMLTextAreaElement;
    editor.setSelectionRange(2, 2);

    document.getElementById("workspace-doc-h1")?.click();

    expect(editor.value).toBe("# a line");
  });

  it("prefixes every selected line with - when the bullet-list button is clicked", async () => {
    await openADoc(jarvis, { readDocRaw: () => Promise.resolve({ ok: true, value: "a\nb" }) });
    const editor = document.getElementById("workspace-doc-editor") as HTMLTextAreaElement;
    editor.setSelectionRange(0, 3);

    document.getElementById("workspace-doc-ul")?.click();

    expect(editor.value).toBe("- a\n- b");
  });

  it("wraps the selection as a link when Link is clicked", async () => {
    await openADoc(jarvis, { readDocRaw: () => Promise.resolve({ ok: true, value: "docs" }) });
    const editor = document.getElementById("workspace-doc-editor") as HTMLTextAreaElement;
    editor.setSelectionRange(0, 4);

    document.getElementById("workspace-doc-link")?.click();

    expect(editor.value).toBe("[docs](url)");
  });

  it("inserts a rule at the cursor when HR is clicked", async () => {
    await openADoc(jarvis, { readDocRaw: () => Promise.resolve({ ok: true, value: "ab" }) });
    const editor = document.getElementById("workspace-doc-editor") as HTMLTextAreaElement;
    editor.setSelectionRange(1, 1);

    document.getElementById("workspace-doc-hr")?.click();

    expect(editor.value).toBe("a\n---\nb");
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

  it("opens the editor URL as a tab for the selected project and switches to Browser", async () => {
    jarvis["openEditor"] = (project: string) =>
      Promise.resolve({ ok: true, value: `http://127.0.0.1:9001/?folder=${project}` });
    document.getElementById("workspace-mode-docs")?.click();

    document.getElementById("workspace-open-editor")?.click();
    await flush();

    expect(calls).toContainEqual({
      call: "openTab",
      args: ["acme", "http://127.0.0.1:9001/?folder=acme", "editor"],
    });
    expect(
      document.getElementById("workspace-browser")?.hasAttribute("hidden"),
    ).toBe(false);
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
      Promise.resolve({ ok: false, text: "Could not open that document.", language: "en" });

    document.getElementById("workspace-open-editor")?.click();
    await flush();

    expect(calls.some((entry) => entry.call === "openTab")).toBe(false);
    expect(document.getElementById("workspace-editor-status")?.textContent).toBe(
      "Could not open that document.",
    );
  });
});
