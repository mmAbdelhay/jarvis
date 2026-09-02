import type { WorkspaceState, WorkspaceTab } from "@jarvis/core";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { PERSONAL_PROJECT, isPersonalProject } from "../src/personal.js";
import { initApi, renderApi } from "./api.js";
import { initWorkspaceTerminals, renderWorkspaceTerminals } from "./workspace-terminal.js";

// Structurally the same shape the preload bridge and main process pass
// across IPC (packages/desktop/src/ipc.ts's Bookmark, from @jarvis/platform)
// — duplicated here rather than imported, since the renderer may only
// import *types* from @jarvis/core (a bare-specifier value import from any
// other workspace package is runtime-fatal once bundled).
type Bookmark = { url: string; title: string };

// The Workspace's chrome. Everything a page can influence — its title, its
// URL, a load error — is attacker-controlled text arriving in the process
// that holds window.jarvis, so this file builds nodes and sets textContent.
// No innerHTML, for the same reason changes.ts has none.

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

// "+" has no typed input to go on, unlike Enter on the address bar. An
// empty string is not a URL — normalizeInput would reject it and
// BrowserHost.open would silently no-op — so a new tab needs a real
// default to open, with the address bar left selected so typing over it
// is the very next thing the user can do.
const NEW_TAB_URL = "https://duckduckgo.com";

let latest: WorkspaceState = { tabs: [], activeTabId: undefined };

function activeTab(): WorkspaceTab | undefined {
  return latest.tabs.find((tab) => tab.id === latest.activeTabId);
}

function selectedProject(): string {
  return ($("workspace-project") as HTMLSelectElement).value;
}

/** What a project is called on screen. Every project but one is called
 *  what the user named it in jarvis.yaml; the personal browser's key is
 *  internal (a partition name, a bookmark-file key) and never shown. */
function projectLabel(project: string): string {
  return isPersonalProject(project) ? MESSAGES.personalProject(PRIMARY_LANGUAGE) : project;
}

/** The four buttons that open something rooted in the project's directory.
 *  Their own tooltips, captured before the personal browser overwrites
 *  them with its reason, so returning to a project restores each one's. */
const PROJECT_TOOL_BUTTONS = [
  "workspace-open-editor",
  "workspace-open-database",
  "workspace-open-terminal",
  "workspace-open-api",
] as const;
const toolTitles = new Map<string, string>();

/**
 * The personal browser has no directory on disk, so there is no folder to
 * edit, no database to spawn against, no cwd for a shell and no collection
 * tree to read — see src/personal.ts. The main process already refuses all
 * four (each handler resolves the project through `config.projects`, which
 * never contains this key), but a button that silently does nothing is a
 * bug as far as the user is concerned. So they are visibly disabled, and
 * the reason goes where the failure text would have gone.
 */
function renderProjectTools(): void {
  const personal = isPersonalProject(selectedProject());
  const reason = MESSAGES.personalHasNoDirectory(PRIMARY_LANGUAGE);

  for (const id of PROJECT_TOOL_BUTTONS) {
    const button = $(id) as HTMLButtonElement;
    button.disabled = personal;
    button.title = personal ? reason : (toolTitles.get(id) ?? "");
  }

  const status = $("workspace-tool-status");
  if (personal) {
    status.textContent = reason;
    status.classList.remove("workspace-tool-status--error");
  } else if (status.textContent === reason) {
    // Only our own text is cleared: the status line also carries a DbGate
    // login the user still has to type.
    status.textContent = "";
  }
}

// A small fixed palette, none of it reused from the app's semantic colors
// (--good/--bad/--accent/etc). Assigned to a project the first time it is
// seen and never reassigned — the same project keeps the same color for as
// long as the window is open, in initWorkspace's own order (config order),
// not tab-open order.
const TAB_COLOR_PALETTE = ["#7dd3c8", "#c792ea", "#f2b880", "#f28fad", "#82b1ff", "#a3e07a"];
const projectColors = new Map<string, string>();

function colorFor(project: string): string {
  const existing = projectColors.get(project);
  if (existing !== undefined) return existing;
  const color = TAB_COLOR_PALETTE[projectColors.size % TAB_COLOR_PALETTE.length] ?? "#7dd3c8";
  projectColors.set(project, color);
  return color;
}

/** Remembers, per project, the tab that was active the last time it was
 *  selected — so switching back to a project restores what you were on
 *  instead of picking arbitrarily. */
const lastActiveTabByProject = new Map<string, string>();

/** Selects `project` and shows whatever it was last on: its remembered
 *  tab if that tab still exists, any other of its open tabs otherwise, or
 *  nothing (hideAll) if it has none open at all. Shared by the project
 *  <select> and by clicking a collapsed project pill in the tab strip. */
async function switchToProject(project: string): Promise<void> {
  ($("workspace-project") as HTMLSelectElement).value = project;

  const remembered = lastActiveTabByProject.get(project);
  const target =
    latest.tabs.find((tab) => tab.id === remembered && tab.project === project) ??
    latest.tabs.find((tab) => tab.project === project);
  if (target !== undefined) void window.jarvis.activateTab(target.id);
  else void window.jarvis.hideAllTabs();

  renderProjectTools();
  await refreshBookmarks();
}

let bookmarks: Bookmark[] = [];

/** Whether the user wants the bookmarks sidebar at all. Their preference for
 *  browser tabs only — a hosted app has no sidebar to show either way, so
 *  this is ANDed with the chrome rule rather than replacing it. Session-local
 *  on purpose: it is a glance-level choice, not a setting. */
let bookmarksVisible = true;

/** Which tabs have DevTools open. DevTools belong to one page, so this
 *  follows the tab rather than the window: switching to a tab that never
 *  opened them shows nothing, and closing a tab forgets it. */
const devToolsByTab = new Set<string>();

/** Tab kinds whose surface the renderer draws itself, over the region a
 *  hosted page would occupy. The page slot and these panes are flex
 *  siblings that both grow, so exactly one may be in the layout at a time. */
const RENDERER_DRAWN: ReadonlySet<WorkspaceTab["kind"]> = new Set(["terminal", "api"]);

/** The panel's share of the browser column's height. Dragged by the handle
 *  above it, clamped so neither the page nor the panel is squeezed away. */
let devToolsFraction = 0.4;
const MIN_DEVTOOLS_FRACTION = 0.15;
const MAX_DEVTOOLS_FRACTION = 0.85;

/** Refetches the *selected* project's bookmarks and redraws the sidebar —
 *  called on init and every project switch, never kept in sync with tabs
 *  (a different project's tabs collapsing into a pill does not touch it). */
async function refreshBookmarks(): Promise<void> {
  const project = selectedProject();
  const result = project === "" ? { ok: true as const, value: [] } : await window.jarvis.listBookmarks(project);
  bookmarks = result.ok ? result.value : [];
  renderBookmarks();
}

function domainFor(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Clicking a bookmark the selected project already has open is a tab
 *  switch, not a second copy of the same page — the same rule openEditor
 *  applies to its own tab. */
function openBookmark(url: string): void {
  const project = selectedProject();
  const existing = latest.tabs.find((tab) => tab.project === project && tab.url === url);
  if (existing !== undefined) void window.jarvis.activateTab(existing.id);
  else void window.jarvis.openTab(project, url);
}

function renderBookmarkRow(bookmark: Bookmark): HTMLElement {
  const row = document.createElement("div");
  row.className = "workspace-bookmark";
  row.addEventListener("click", () => openBookmark(bookmark.url));

  const text = document.createElement("div");
  text.className = "workspace-bookmark-text";
  const title = document.createElement("div");
  title.className = "workspace-bookmark-title";
  // A saved page title is text here, same discipline as a tab's title.
  title.textContent = bookmark.title === "" ? bookmark.url : bookmark.title;
  const domain = document.createElement("div");
  domain.className = "workspace-bookmark-domain";
  domain.textContent = domainFor(bookmark.url);
  text.append(title, domain);

  const remove = document.createElement("span");
  remove.className = "workspace-bookmark-remove";
  remove.textContent = "×";
  remove.addEventListener("click", (event) => {
    // Without this the row underneath also receives the click and opens
    // the bookmark it was just removed from.
    event.stopPropagation();
    void removeBookmark(bookmark.url);
  });

  row.append(text, remove);
  return row;
}

function renderBookmarks(): void {
  const list = $("workspace-bookmark-list");
  list.replaceChildren();
  for (const bookmark of bookmarks) list.append(renderBookmarkRow(bookmark));
  updateBookmarkToggle();
}

async function removeBookmark(url: string): Promise<void> {
  const result = await window.jarvis.removeBookmark(selectedProject(), url);
  if (result.ok) bookmarks = result.value;
  renderBookmarks();
}

/** Star button next to the address bar: bookmarks/unbookmarks the active
 *  tab's current URL for the selected project. */
async function toggleBookmark(): Promise<void> {
  const tab = activeTab();
  if (tab === undefined) return;
  const project = selectedProject();
  const alreadyBookmarked = bookmarks.some((b) => b.url === tab.url);
  const result = alreadyBookmarked
    ? await window.jarvis.removeBookmark(project, tab.url)
    : await window.jarvis.addBookmark(project, {
        url: tab.url,
        title: tab.title === "" ? tab.url : tab.title,
      });
  if (result.ok) bookmarks = result.value;
  renderBookmarks();
}

/** The sidebar shows only when both the chrome rule and the user's own
 *  toggle allow it. Kept in one function because those two reasons to be
 *  hidden are decided in different places and must not drift. */
function renderBookmarksVisibility(hostedApp = activeTab() !== undefined && activeTab()?.kind !== "web"): void {
  ($("workspace-bookmarks") as HTMLElement).hidden = hostedApp || !bookmarksVisible;
  $("workspace-toggle-bookmarks").classList.toggle("workspace-nav--on", bookmarksVisible);
}

function toggleBookmarksSidebar(): void {
  bookmarksVisible = !bookmarksVisible;
  renderBookmarksVisibility();
  // The sidebar is 200px of the page slot's width; a hosted view pinned to
  // the old rectangle would be left overlapping or short.
  reportWorkspaceBounds();
}

/** Shows or hides the DevTools panel for whatever tab is active, sizes it,
 *  and reports both rectangles — the panel's, and the page slot's, which
 *  just changed with it. */
function renderDevTools(): void {
  const tab = activeTab();
  const open = tab !== undefined && devToolsByTab.has(tab.id);
  const panel = $("workspace-devtools") as HTMLElement;

  panel.hidden = !open;
  ($("workspace-devtools-handle") as HTMLElement).hidden = !open;
  $("workspace-toggle-devtools").classList.toggle("workspace-nav--on", open);

  if (!open) return;

  const available = panel.parentElement?.clientHeight ?? 0;
  // A column with no layout yet measures zero; a percentage still lands
  // correctly once it does, where a computed pixel height would not.
  panel.style.height =
    available === 0
      ? `${Math.round(devToolsFraction * 100)}%`
      : `${Math.round(available * devToolsFraction)}px`;
  reportDevToolsBounds();
}

function reportDevToolsBounds(): void {
  const rect = $("workspace-devtools").getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  void window.jarvis.setDevToolsBounds({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}

function toggleDevTools(): void {
  const tab = activeTab();
  // Nothing to inspect: DevTools attach to a page, and with no tab open
  // there is no page.
  if (tab === undefined) return;

  const open = !devToolsByTab.has(tab.id);
  if (open) devToolsByTab.add(tab.id);
  else devToolsByTab.delete(tab.id);

  void window.jarvis.setDevTools(tab.id, open);
  renderDevTools();
  // The page slot just gave up (or got back) the panel's share of the
  // column, and the hosted view is pinned to the old rectangle until told.
  reportWorkspaceBounds();
}

/** Drags the split between the page and the DevTools panel. The pointer is
 *  tracked on the window rather than the handle, so a fast drag that leaves
 *  the 6px strip does not silently stop resizing. */
function wireDevToolsHandle(): void {
  $("workspace-devtools-handle").addEventListener("mousedown", (event) => {
    event.preventDefault();
    const panel = $("workspace-devtools") as HTMLElement;
    const column = panel.parentElement;
    if (column === null) return;

    const onMove = (move: MouseEvent): void => {
      const box = column.getBoundingClientRect();
      if (box.height === 0) return;
      devToolsFraction = Math.min(
        MAX_DEVTOOLS_FRACTION,
        Math.max(MIN_DEVTOOLS_FRACTION, (box.bottom - move.clientY) / box.height),
      );
      panel.style.height = `${Math.round(box.height * devToolsFraction)}px`;
      reportDevToolsBounds();
      reportWorkspaceBounds();
    };

    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function updateBookmarkToggle(): void {
  const toggle = $("workspace-bookmark-toggle") as HTMLButtonElement;
  const tab = activeTab();
  toggle.disabled = tab === undefined;
  toggle.classList.toggle(
    "workspace-bookmark-toggle--on",
    tab !== undefined && bookmarks.some((b) => b.url === tab.url),
  );
}

export function initWorkspace(projects: string[]): void {
  const select = $("workspace-project") as HTMLSelectElement;
  select.replaceChildren();
  // The personal browser sits last, after the projects the user configured
  // — it belongs to the same selector because it is the same kind of
  // choice ("whose tabs am I looking at"), but it is not one of their
  // projects and must not be the one selected by default.
  for (const project of [...projects, PERSONAL_PROJECT]) {
    colorFor(project);
    const option = document.createElement("option");
    option.value = project;
    option.textContent = projectLabel(project);
    select.append(option);
  }
  select.addEventListener("change", () => void switchToProject(select.value));

  for (const id of PROJECT_TOOL_BUTTONS) toolTitles.set(id, ($(id) as HTMLButtonElement).title);

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
    void window.jarvis.openTab(selectedProject(), NEW_TAB_URL);
    address.focus();
    address.select();
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

  // The overlay does not move with the layout, so every reflow has to be
  // pushed. A resize is the only one the renderer can observe cheaply.
  window.addEventListener("resize", reportWorkspaceBounds);

  $("workspace-open-editor").addEventListener("click", () => void openEditor());
  $("workspace-open-database").addEventListener("click", () => void openDatabase());
  $("workspace-open-terminal").addEventListener("click", () => void openTerminal());
  $("workspace-open-api").addEventListener("click", () => void openApi());
  initApi();
  initWorkspaceTerminals();

  $("workspace-pip").addEventListener("click", () => {
    const tab = activeTab();
    if (tab !== undefined) void window.jarvis.requestPictureInPicture(tab.id);
  });
  ($("workspace-pip") as HTMLButtonElement).title = MESSAGES.pictureInPicture(PRIMARY_LANGUAGE);

  $("workspace-bookmark-toggle").addEventListener("click", () => void toggleBookmark());
  $("workspace-toggle-bookmarks").addEventListener("click", () => toggleBookmarksSidebar());
  $("workspace-toggle-devtools").addEventListener("click", () => toggleDevTools());
  wireDevToolsHandle();
  renderBookmarksVisibility(false);
  renderProjectTools();
  void refreshBookmarks();
}

/** Ensures a code-server instance is running for the selected project and
 *  opens it as an ordinary browser tab — the editor is not a separate
 *  surface, just a page like any other, reusing openTab exactly as the
 *  address bar or a "+" click would. */
async function openEditor(): Promise<void> {
  const project = selectedProject();

  // code-server is already running and the tab already exists for this
  // project — this is a tab switch, not a reason to spin up a second
  // instance or open a duplicate tab.
  const existing = latest.tabs.find((tab) => tab.kind === "editor" && tab.project === project);
  if (existing !== undefined) {
    void window.jarvis.activateTab(existing.id);
    return;
  }

  const status = $("workspace-tool-status");
  status.textContent = "";
  status.classList.remove("workspace-tool-status--error");

  const result = await window.jarvis.openEditor(project);
  if (!result.ok) {
    status.textContent = result.text;
    status.classList.add("workspace-tool-status--error");
    return;
  }
  void window.jarvis.openTab(project, result.value, "editor");
}

/** Ensures a DbGate instance is running for the selected project and opens
 *  it as an ordinary browser tab, exactly as openEditor does — the database
 *  browser is not a separate surface, just a hosted page like the editor.
 *
 *  DbGate has no bind-address option and always listens on 0.0.0.0, so its
 *  instances are guarded by a login generated at spawn; the credential goes
 *  into the status line, since the user has to type it once per instance. */
async function openDatabase(): Promise<void> {
  const project = selectedProject();

  // Already open for this project — a tab switch, not a second instance.
  const existing = latest.tabs.find((tab) => tab.kind === "database" && tab.project === project);
  if (existing !== undefined) {
    void window.jarvis.activateTab(existing.id);
    return;
  }

  const status = $("workspace-tool-status");
  status.textContent = "";
  status.classList.remove("workspace-tool-status--error");

  const result = await window.jarvis.openDatabase(project);
  if (!result.ok) {
    status.textContent = result.text;
    status.classList.add("workspace-tool-status--error");
    return;
  }

  status.textContent = MESSAGES.databaseLogin(result.value.login, result.value.password, PRIMARY_LANGUAGE);
  void window.jarvis.openTab(project, result.value.url, "database");
}

/** Opens a shell in the selected project's directory as a new tab.
 *
 *  Unlike the editor and the database this always opens a *new* one: two
 *  terminals in the same project is an ordinary thing to want, and there is
 *  no instance to reuse — the tab and its pty are created together by main,
 *  and the tab arrives here through the ordinary workspace update. */
async function openTerminal(): Promise<void> {
  const status = $("workspace-tool-status");
  status.textContent = "";
  status.classList.remove("workspace-tool-status--error");

  const result = await window.jarvis.openTerminal(selectedProject());
  if (!result.ok) {
    status.textContent = result.text;
    status.classList.add("workspace-tool-status--error");
  }
}

/** Opens the project's API tab, or activates the one it already has.
 *
 *  Unlike a terminal there is exactly one per project: a collection tree is
 *  a view of the filesystem rather than a session, so a second tab would be
 *  a duplicate of the first, not a second workspace. */
async function openApi(): Promise<void> {
  const project = selectedProject();

  const existing = latest.tabs.find((tab) => tab.kind === "api" && tab.project === project);
  if (existing !== undefined) {
    void window.jarvis.activateTab(existing.id);
    return;
  }

  const status = $("workspace-tool-status");
  status.textContent = "";
  status.classList.remove("workspace-tool-status--error");

  const result = await window.jarvis.openApiTab(project);
  if (!result.ok) {
    status.textContent = result.text;
    status.classList.add("workspace-tool-status--error");
  }
}

function renderTabChip(tab: WorkspaceTab, activeTabId: string | undefined): HTMLElement {
  const element = document.createElement("div");
  element.className = "workspace-tab";
  element.style.setProperty("--tab-color", colorFor(tab.project));
  element.classList.toggle("workspace-tab--on", tab.id === activeTabId);
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
  return element;
}

function renderCollapsedGroup(project: string, count: number): HTMLElement {
  const element = document.createElement("div");
  element.className = "workspace-tab-group";
  element.style.setProperty("--tab-color", colorFor(project));
  element.addEventListener("click", () => void switchToProject(project));

  const dot = document.createElement("span");
  dot.className = "workspace-tab-group-dot";

  const label = document.createElement("span");
  // A project name comes from config, but it is still text, same
  // discipline as everything else this file builds.
  label.textContent = `${projectLabel(project)} (${count})`;

  element.append(dot, label);
  return element;
}

export function renderWorkspace(state: WorkspaceState): void {
  latest = state;

  const activeTabForState = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (activeTabForState !== undefined) {
    lastActiveTabByProject.set(activeTabForState.project, activeTabForState.id);
  }

  const selected = selectedProject();
  const strip = $("workspace-tabs");
  strip.replaceChildren();

  // Every project with at least one open tab gets a slot: the selected
  // one expands into its individual tabs, every other one collapses into a
  // single colored, counted pill rather than stacking every project's tabs
  // into one flat, unreadable row.
  const byProject = new Map<string, WorkspaceTab[]>();
  for (const tab of state.tabs) {
    const group = byProject.get(tab.project) ?? [];
    group.push(tab);
    byProject.set(tab.project, group);
  }

  for (const [project, tabs] of byProject) {
    if (project === selected) {
      for (const tab of tabs) strip.append(renderTabChip(tab, state.activeTabId));
    } else {
      strip.append(renderCollapsedGroup(project, tabs.length));
    }
  }

  // "+" lives permanently in the workspace head, not in this strip — so
  // there is nothing to relocate here. The strip itself just hides when it
  // would otherwise be an empty padded band with no tabs in it.
  strip.hidden = state.tabs.length === 0;

  const tab = activeTab();

  // Back/forward/reload/address mean nothing for a hosted app — nobody
  // navigates a code editor or a SQL client like a webpage — and neither do
  // bookmarks: the sidebar belongs to the browser, so it goes away with the
  // rest of the browser chrome. Stated as "not a web tab" rather than as a
  // list of kinds, so a fourth hosted app inherits the rule for free. With
  // no tab open at all the chrome stays: that is the state where the
  // sidebar is the quickest way to open something.
  const hostedApp = tab !== undefined && tab.kind !== "web";
  ($("workspace-bar") as HTMLElement).hidden = hostedApp;
  renderBookmarksVisibility(hostedApp);

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

  updateBookmarkToggle();

  // Picture-in-Picture is offered only where there is something to float:
  // an ordinary page that has told us it has a video actually playing. A
  // button on every page would be a control that does nothing almost all
  // of the time, which is the thing this deliberately avoids.
  ($("workspace-pip") as HTMLElement).hidden = !(tab?.hasPlayingVideo ?? false) || tab?.kind !== "web";

  // The page slot and the terminal host are flex siblings that both grow, so
  // exactly one of them may be in the layout at a time — with both showing
  // they would split the height and the terminal would get half a screen.
  // Hiding the slot also makes its rectangle zero, which is why
  // reportWorkspaceBounds below refuses to report a zero rect: a hosted view
  // must not be moved to nowhere just because a terminal is on top.
  ($("workspace-page") as HTMLElement).hidden =
    tab !== undefined && RENDERER_DRAWN.has(tab.kind) && tab.project === selected;
  renderWorkspaceTerminals(state.tabs, state.activeTabId, selected);
  renderApi(state.tabs, state.activeTabId, selected);

  // A closed tab takes its DevTools with it: main destroys the panel's view
  // along with the page's, so an id left here would resurrect a panel for a
  // later tab that happened to reuse it.
  const liveTabs = new Set(state.tabs.map((openTab) => openTab.id));
  for (const id of devToolsByTab) if (!liveTabs.has(id)) devToolsByTab.delete(id);
  renderDevTools();

  // Hiding the bar and the sidebar resizes the page slot the hosted view
  // is pinned to, and nothing else re-measures it — a resize is the only
  // reflow the window itself reports.
  reportWorkspaceBounds();
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
  // renderWorkspace runs whether or not the Workspace route is on screen,
  // and an off-screen slot measures zero. Moving the view to nowhere is
  // never what that means.
  if (rect.width === 0 || rect.height === 0) return;
  void window.jarvis.setWorkspaceBounds({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}
