import type { WorkspaceState, WorkspaceTab } from "@jarvis/core";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { PERSONAL_PROJECT, isPersonalProject } from "../src/personal.js";
import { detectLanguage } from "./format.js";
import { initApi, renderApi } from "./api.js";
import { attachDockerPane, detachDockerPane } from "./workspace-docker.js";
import { initWorkspaceTerminals, renderWorkspaceTerminals } from "./workspace-terminal.js";

// Structurally the same shape the preload bridge and main process pass
// across IPC (packages/desktop/src/ipc.ts's Bookmark, from @jarvis/platform)
// — duplicated here rather than imported, since the renderer may only
// import *types* from @jarvis/core (a bare-specifier value import from any
// other workspace package is runtime-fatal once bundled).
type Bookmark = { url: string; title: string; pinned?: boolean; order?: number };
// Same shape as ipc.ts's BookmarkView: a Bookmark plus the cached icon a
// listBookmarks resolution may carry. Its absence, not an empty string, is
// what tells renderEssential to draw a monogram instead.
type BookmarkView = Bookmark & { icon?: string };

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

/** The Cluster button's own tooltip, captured before a project with no
 *  `clusters:` overwrites it — same reason toolTitles exists for the four
 *  buttons above, kept separate because the button itself is not one of
 *  them (see renderClusterButton). */
let clusterButtonTitle = "";

/** The Docker button's own tooltip, captured for the same reason
 *  clusterButtonTitle is: a project with no configured containers
 *  overwrites it, and switching to one that has some must restore it. */
let dockerButtonTitle = "";

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

/**
 * The Cluster button is disabled whenever the selected project has nothing
 * for it to open — not just the personal browser, but any ordinary project
 * that declares no `clusters:` entry, which is most of them. It is deliberately
 * left out of PROJECT_TOOL_BUTTONS/renderProjectTools: "no directory on
 * disk" is the true reason the other four are dead for the personal
 * browser, but a false one for this button — a cluster is not rooted in a
 * directory — and that function has no notion of "disabled for this
 * particular project" at all, which is the ordinary case here.
 */
async function renderClusterButton(): Promise<void> {
  const project = selectedProject();
  const names = project === "" ? [] : await window.jarvis.clusterNames(project);
  // The user may have switched projects while that request was in flight;
  // a stale answer must not clobber whatever project is selected now.
  if (selectedProject() !== project) return;

  const button = $("workspace-open-cluster") as HTMLButtonElement;
  const disabled = names.length === 0;
  button.disabled = disabled;
  button.title = disabled ? MESSAGES.noClustersConfigured(PRIMARY_LANGUAGE) : clusterButtonTitle;
}

/** The Docker button follows the Cluster button's rule exactly: disabled
 *  whenever the selected project declares no containers to manage — most
 *  projects, and always the personal browser. A dead daemon is deliberately
 *  NOT checked here: that would cost a `docker` subprocess on every project
 *  switch, and the tab itself says so plainly the moment it opens — only
 *  "nothing configured" is knowable for free. */
async function renderDockerButton(): Promise<void> {
  const project = selectedProject();
  const result = project === "" ? { ok: true as const, value: [] } : await window.jarvis.dockerNames(project);
  // The user may have switched projects while that request was in flight;
  // a stale answer must not clobber whatever project is selected now.
  if (selectedProject() !== project) return;

  const names = result.ok ? result.value : [];
  const button = $("workspace-open-docker") as HTMLButtonElement;
  const disabled = names.length === 0;
  button.disabled = disabled;
  button.title = disabled ? MESSAGES.dockerNoContainers(PRIMARY_LANGUAGE) : dockerButtonTitle;
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
  // The menu lists one project's roots; leaving it up over another project
  // would open a root the selector no longer shows.
  closeEditorMenu();
  // Same reasoning, and the same bug otherwise: the menu's items close over
  // the OLD project, so a stale one left open would open or activate the
  // wrong project's cluster tab.
  closeClusterMenu();

  const remembered = lastActiveTabByProject.get(project);
  const target =
    latest.tabs.find((tab) => tab.id === remembered && tab.project === project) ??
    latest.tabs.find((tab) => tab.project === project);
  if (target !== undefined) void window.jarvis.activateTab(target.id);
  else void window.jarvis.hideAllTabs();

  renderProjectTools();
  void renderClusterButton();
  void renderDockerButton();
  await refreshBookmarks();
}

let bookmarks: BookmarkView[] = [];

/** Whether the user wants the bookmarks bar at all. Their preference for
 *  browser tabs only — a hosted app has no bar to show either way, so
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
const RENDERER_DRAWN: ReadonlySet<WorkspaceTab["kind"]> = new Set(["terminal", "api", "docker"]);

/** The panel's share of the browser column's height. Dragged by the handle
 *  above it, clamped so neither the page nor the panel is squeezed away. */
let devToolsFraction = 0.4;
const MIN_DEVTOOLS_FRACTION = 0.15;
const MAX_DEVTOOLS_FRACTION = 0.85;

/** Refetches the *selected* project's bookmarks and redraws the bar —
 *  called on init and every project switch, never kept in sync with tabs
 *  (a different project's tabs collapsing into a pill does not touch it). */
async function refreshBookmarks(): Promise<void> {
  const project = selectedProject();
  const result = project === "" ? { ok: true as const, value: [] } : await window.jarvis.listBookmarks(project);
  bookmarks = result.ok ? result.value : [];
  renderBookmarks();
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

/** One chip in the bar. The rail stacked the title over the host; a row
 *  one line tall has space for the title alone, so the address moves to the
 *  tooltip — where it is the more useful half anyway. */
function renderBookmarkChip(bookmark: Bookmark): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "workspace-bookmark";
  // Both the title and the URL are page-supplied text; the attribute takes
  // it as text and nothing else, same discipline as the tab strip.
  chip.title = bookmark.url;
  chip.addEventListener("click", () => openBookmark(bookmark.url));

  const title = document.createElement("span");
  title.className = "workspace-bookmark-title";
  const label = bookmark.title === "" ? bookmark.url : bookmark.title;
  title.textContent = label;
  // An Arabic title left at the document's LTR direction puts its
  // punctuation and its ellipsis on the wrong edge — visible immediately in
  // a strip of short chips, which is the whole bar.
  title.dir = detectLanguage(label) === "ar" ? "rtl" : "ltr";

  const remove = document.createElement("span");
  remove.className = "workspace-bookmark-remove";
  remove.textContent = "×";
  remove.addEventListener("click", (event) => {
    // Without this the chip underneath also receives the click and opens
    // the bookmark it was just removed from.
    event.stopPropagation();
    void removeBookmark(bookmark.url);
  });

  chip.append(title, remove);
  return chip;
}

const MAX_ESSENTIALS = 12;

/** A deterministic hue from the origin, so one site is always the same
 *  colour and two bookmarks of the same host match. */
function monogramColour(url: string): string {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = url;
  }
  let hash = 0;
  for (const ch of origin) hash = (hash * 31 + ch.codePointAt(0)!) % 360;
  return `hsl(${hash}, 45%, 32%)`;
}

/** The tile for a bookmark with no cached icon: its first letter on that
 *  colour. Without this the grid is a row of empty squares for everything
 *  never opened in Jarvis. */
function monogramTile(bookmark: BookmarkView): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "workspace-essential-monogram";
  mark.style.backgroundColor = monogramColour(bookmark.url);
  const label = bookmark.title === "" ? bookmark.url : bookmark.title;
  mark.textContent = [...label][0]?.toUpperCase() ?? "?";
  return mark;
}

function renderEssential(bookmark: BookmarkView): HTMLElement {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "workspace-essential";
  tile.title = bookmark.title === "" ? bookmark.url : bookmark.title;
  tile.dataset["url"] = bookmark.url;
  if (bookmark.icon === undefined) {
    tile.append(monogramTile(bookmark));
  } else {
    const img = document.createElement("img");
    img.src = bookmark.icon;
    img.alt = "";
    tile.append(img);
  }
  tile.addEventListener("click", () => openBookmark(bookmark.url));
  return tile;
}

function renderBookmarks(): void {
  const grid = $("workspace-essentials");
  const list = $("workspace-bookmark-list");
  // The store already sorts pinned-first and by order, so the split is a
  // filter rather than a sort. Capped again here: a file holding more than
  // twelve pins must not spill a fourth row into the list's space.
  const pinned = bookmarks.filter((b) => b.pinned === true).slice(0, MAX_ESSENTIALS);
  const listed = bookmarks.filter((b) => b.pinned !== true);

  grid.replaceChildren(...pinned.map(renderEssential));
  list.replaceChildren(...listed.map(renderBookmarkChip));

  // The existing empty note, moved verbatim — including the dir handling,
  // whose comment explains why the language is read off the text rather
  // than off PRIMARY_LANGUAGE (the constant is a literal type, so comparing
  // it narrows to never and tsc rejects it).
  if (listed.length === 0) {
    const empty = document.createElement("span");
    empty.className = "workspace-bookmarks-empty";
    const note = MESSAGES.noBookmarks(PRIMARY_LANGUAGE);
    empty.textContent = note;
    empty.dir = detectLanguage(note) === "ar" ? "rtl" : "ltr";
    list.append(empty);
  }

  updateBookmarkToggle();
  // The sidebar's width is the page slot's left inset, and a DOM change the
  // renderer made itself fires no reflow event — so the hosted view would
  // stay pinned over the old rectangle.
  reportWorkspaceBounds();
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

/** The bar shows only when both the chrome rule and the user's own
 *  toggle allow it. Kept in one function because those two reasons to be
 *  hidden are decided in different places and must not drift. */
function renderBookmarksVisibility(hostedApp = activeTab() !== undefined && activeTab()?.kind !== "web"): void {
  ($("workspace-bookmarks") as HTMLElement).hidden = hostedApp || !bookmarksVisible;
  $("workspace-toggle-bookmarks").classList.toggle("workspace-nav--on", bookmarksVisible);
}

function toggleBookmarksBar(): void {
  bookmarksVisible = !bookmarksVisible;
  renderBookmarksVisibility();
  // The bar is a row above the page slot; showing or hiding it moves the
  // slot's top edge, and a hosted view pinned to the old rectangle would be
  // left overlapping the bar or short of the bottom.
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
    devicePixelRatio: window.devicePixelRatio,
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
  // The pre-warm record belongs to one run of the Workspace over one
  // project list; a fresh init means fresh main-process managers, so the
  // "already asked" answers from before are no longer true.
  preWarmed.clear();
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
  clusterButtonTitle = ($("workspace-open-cluster") as HTMLButtonElement).title;
  dockerButtonTitle = ($("workspace-open-docker") as HTMLButtonElement).title;

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
  $("workspace-open-cluster").addEventListener("click", () => void openCluster());
  // See preWarm: the pointer arriving is a few hundred milliseconds of a
  // ~2s start that the click no longer has to pay for. "focus" is the same
  // signal for a keyboard user, who never emits a pointerenter.
  for (const [id, kind] of [
    ["workspace-open-editor", "editor"],
    ["workspace-open-database", "database"],
    ["workspace-open-cluster", "cluster"],
  ] as const) {
    $(id).addEventListener("pointerenter", () => preWarm(kind));
    $(id).addEventListener("focus", () => preWarm(kind));
  }
  $("workspace-open-terminal").addEventListener("click", () => void openTerminal());
  $("workspace-open-api").addEventListener("click", () => void openApi());
  $("workspace-open-docker").addEventListener("click", () => void openDocker());
  initApi();
  initWorkspaceTerminals();

  $("workspace-pip").addEventListener("click", () => {
    const tab = activeTab();
    if (tab !== undefined) void window.jarvis.requestPictureInPicture(tab.id);
  });
  ($("workspace-pip") as HTMLButtonElement).title = MESSAGES.pictureInPicture(PRIMARY_LANGUAGE);

  $("workspace-bookmark-toggle").addEventListener("click", () => void toggleBookmark());
  $("workspace-toggle-bookmarks").addEventListener("click", () => toggleBookmarksBar());
  $("workspace-toggle-devtools").addEventListener("click", () => toggleDevTools());
  wireDevToolsHandle();
  renderBookmarksVisibility(false);
  renderProjectTools();
  void renderClusterButton();
  void renderDockerButton();
  void refreshBookmarks();
}

/** The Editor button. A project that configures no `editors:` roots opens
 *  at its own directory, exactly as it always did; one root opens straight
 *  into it; two or more offer a menu, since picking is the whole point of
 *  having configured them. The roots are re-read on every click rather than
 *  cached, so a config change needs no more than the Settings restart. */
async function openEditor(): Promise<void> {
  // A second click on the button is "put that menu away", not "open it
  // again" — the only other way out would be clicking a root.
  if (!editorMenu().hidden) {
    closeEditorMenu();
    return;
  }

  const project = selectedProject();
  const roots = await window.jarvis.editorRoots(project);
  if (roots.length > 1) {
    showEditorMenu(project, roots);
    return;
  }
  await openEditorRoot(project, roots[0]);
}

function editorMenu(): HTMLElement {
  return $("workspace-editor-menu");
}

function closeEditorMenu(): void {
  const menu = editorMenu();
  menu.hidden = true;
  menu.replaceChildren();
}

/** The root picker. A root name is config text like a project name, so it
 *  is a node with its textContent set — no innerHTML here either. */
function showEditorMenu(project: string, roots: string[]): void {
  const menu = editorMenu();
  menu.replaceChildren();
  for (const root of roots) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "workspace-menu-item";
    item.textContent = root;
    item.addEventListener("click", () => {
      closeEditorMenu();
      void openEditorRoot(project, root);
    });
    menu.append(item);
  }
  menu.hidden = false;
}

/**
 * Says out loud that a hosted app is starting, and stops the button being
 * clicked again while it is.
 *
 * The wait is code-server's or DbGate's own boot — measured at 1.9-2.3s
 * with the binaries warm and 9-21s cold — and no amount of work here makes
 * a node process start faster. What was fixable is that the whole wait used
 * to happen behind an empty toolbar and a button that still looked live, so
 * the app read as frozen and invited the second click that (before the
 * managers learned to share an in-flight start) spawned a second server.
 */
function beginStarting(buttonId: string, text: string): () => void {
  const button = $(buttonId) as HTMLButtonElement;
  const status = $("workspace-tool-status");
  status.classList.remove("workspace-tool-status--error");
  status.textContent = text;
  button.disabled = true;
  return () => {
    button.disabled = false;
  };
}

/** Ensures a code-server instance is running for one root of `project` and
 *  opens it as an ordinary browser tab — the editor is not a separate
 *  surface, just a page like any other, reusing openTab exactly as the
 *  address bar or a "+" click would. `root` undefined means the project
 *  directory itself. */
async function openEditorRoot(project: string, root: string | undefined): Promise<void> {
  // code-server is already running and the tab already exists for this
  // project *and this root* — a tab switch, not a reason to spin up a
  // second instance. Two roots of one project are two editors, which is
  // why the tab's own `detail` decides this and the project alone cannot.
  const existing = latest.tabs.find(
    (tab) => tab.kind === "editor" && tab.project === project && tab.detail === root,
  );
  if (existing !== undefined) {
    void window.jarvis.activateTab(existing.id);
    return;
  }

  const status = $("workspace-tool-status");
  const done = beginStarting("workspace-open-editor", MESSAGES.editorStarting(PRIMARY_LANGUAGE));

  const result = await window.jarvis.openEditor(project, root);
  done();
  if (!result.ok) {
    status.textContent = result.text;
    status.classList.add("workspace-tool-status--error");
    return;
  }
  // The tab is about to carry the news itself; the "starting…" line has
  // said all it had to say.
  status.textContent = "";
  void window.jarvis.openTab(project, result.value, "editor", root);
}

/** The Cluster button. Mirrors the Editor's, because both pick from a
 *  configured list: no clusters disables the button (see
 *  renderClusterButton), one opens it, two or more offer a menu. Names are
 *  re-read on every click rather than cached, so a config change needs no
 *  more than the Settings restart. */
async function openCluster(): Promise<void> {
  // A second click on the button is "put that menu away", not "open it
  // again" — the only other way out would be clicking a name.
  if (!clusterMenu().hidden) {
    closeClusterMenu();
    return;
  }

  const project = selectedProject();
  const names = await window.jarvis.clusterNames(project);
  if (names.length === 0) return;
  if (names.length > 1) {
    showClusterMenu(project, names);
    return;
  }
  await openClusterNamed(project, names[0] as string);
}

function clusterMenu(): HTMLElement {
  return $("workspace-cluster-menu");
}

function closeClusterMenu(): void {
  const menu = clusterMenu();
  menu.hidden = true;
  menu.replaceChildren();
}

/** The name picker. A cluster name is config text like a project name, so
 *  it is a node with its textContent set — no innerHTML here either. */
function showClusterMenu(project: string, names: string[]): void {
  const menu = clusterMenu();
  menu.replaceChildren();
  for (const name of names) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "workspace-menu-item";
    item.textContent = name;
    item.addEventListener("click", () => {
      closeClusterMenu();
      void openClusterNamed(project, name);
    });
    menu.append(item);
  }
  menu.hidden = false;
}

/** Ensures a headlamp-server instance is running for `project` and opens
 *  one of its clusters as an ordinary browser tab — the cluster browser is
 *  not a separate surface, just a hosted page like the editor. */
async function openClusterNamed(project: string, name: string): Promise<void> {
  // Two clusters of one project are two tabs against one server, so the
  // tab's own `detail` decides this and the project alone cannot — the
  // same reason openEditorRoot matches on detail rather than project.
  const existing = latest.tabs.find(
    (tab) => tab.kind === "cluster" && tab.project === project && tab.detail === name,
  );
  if (existing !== undefined) {
    void window.jarvis.activateTab(existing.id);
    return;
  }

  const status = $("workspace-tool-status");
  const done = beginStarting("workspace-open-cluster", MESSAGES.clusterStarting(PRIMARY_LANGUAGE));

  const result = await window.jarvis.openCluster(project, name);
  done();
  if (!result.ok) {
    status.textContent = result.text;
    status.classList.add("workspace-tool-status--error");
    return;
  }
  status.textContent = "";
  void window.jarvis.openTab(project, result.value, "cluster", name);
}

/**
 * Which project has already been asked to start which hosted app, so that a
 * pointer wandering across the toolbar asks once rather than on every
 * crossing. Keyed by kind and project, never cleared: the managers reuse a
 * running instance anyway, so a second ask would be harmless but pointless.
 */
const preWarmed = new Set<string>();

/**
 * Starts the hosted app for the selected project *before* the click.
 *
 * A pointer landing on the button, or the button taking keyboard focus, is
 * the earliest honest signal that this user wants this app — measured a few
 * hundred milliseconds ahead of the click, against a 1.9-2.3s warm start.
 * It is free when unused in the only sense that matters: it starts exactly
 * the process the click would have started, for exactly the project the
 * click would have started it for, and the managers share one in-flight
 * start per project, so the click that follows costs only whatever is left
 * of it. Nothing is spawned for a project the pointer never visits.
 *
 * Failures are swallowed on purpose. Nothing was asked for yet, so nothing
 * may appear in the status line; the click makes the same call and reports
 * the failure then.
 */
function preWarm(kind: "editor" | "database" | "cluster"): void {
  const project = selectedProject();
  if (project === "") return;
  const key = `${kind}:${project}`;
  if (preWarmed.has(key)) return;
  // Already open means already running: there is nothing to warm.
  if (latest.tabs.some((tab) => tab.kind === kind && tab.project === project)) return;
  preWarmed.add(key);

  if (kind === "database") {
    void window.jarvis.openDatabase(project).catch(() => undefined);
    return;
  }

  if (kind === "cluster") {
    // Same reasoning as the editor's: warming is only worth anything if it
    // warms what the click will open. With two or more clusters the click
    // opens a menu and starts nothing — but unlike the editor, every
    // cluster of a project shares one server, so warming any of them warms
    // all of them, and the first is as good an answer as any.
    //
    // The `true` is what keeps this a warm rather than a login: a cluster
    // behind an expired AWS session would otherwise have a hover open a
    // terminal tab, run `saml2aws login`, and push MFA to the user's phone,
    // all without a click. Main backs off instead, and the click that
    // follows does the login properly, with the status line to show for it.
    void window.jarvis
      .clusterNames(project)
      .then((names) =>
        names[0] === undefined ? undefined : window.jarvis.openCluster(project, names[0], true),
      )
      .catch(() => undefined);
    return;
  }

  // A warm start is only worth anything if it warms what the click will
  // open. A project with one configured root wants its editor *there*, so
  // warming the project directory would spawn a code-server nobody asked
  // for and leave the click to spawn a second at the right place. With two
  // or more roots the click opens a menu and starts nothing, so there is no
  // single answer to warm and guessing one has the same cost.
  void window.jarvis
    .editorRoots(project)
    .then((roots) => (roots.length > 1 ? undefined : window.jarvis.openEditor(project, roots[0])))
    .catch(() => undefined);
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
  const done = beginStarting(
    "workspace-open-database",
    MESSAGES.databaseStarting(PRIMARY_LANGUAGE),
  );

  const result = await window.jarvis.openDatabase(project);
  done();
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

/** Opens the project's Docker tab, or activates the one it already has.
 *
 *  One per project, for the same reason the API tab is: the tab shows the
 *  containers a project declares, not a session, so a second tab would show
 *  the same thing the first already does. */
async function openDocker(): Promise<void> {
  const project = selectedProject();

  const existing = latest.tabs.find((tab) => tab.kind === "docker" && tab.project === project);
  if (existing !== undefined) {
    void window.jarvis.activateTab(existing.id);
    return;
  }

  const status = $("workspace-tool-status");
  status.textContent = "";
  status.classList.remove("workspace-tool-status--error");

  const result = await window.jarvis.openDockerTab(project);
  if (!result.ok) {
    status.textContent = result.text;
    status.classList.add("workspace-tool-status--error");
  }
}

/** The docker tab currently polling, if any. Unlike a terminal — which keeps
 *  every open tab's pty alive in the background — the Docker pane's poll is
 *  only worth running while it is actually on screen, so there is at most
 *  one attached tab at a time rather than a pane per tab. */
let dockerAttached: string | undefined;

/** Shows or hides the Docker pane and starts/stops its poll to match: the
 *  same "flex sibling of the page slot" rule the terminal and API panes
 *  follow, and the same show/hide call site they are wired at. */
function renderDocker(tabs: WorkspaceTab[], activeTabId: string | undefined, selectedProject: string): void {
  const active = tabs.find((tab) => tab.id === activeTabId);
  const showing = active?.kind === "docker" && active.project === selectedProject ? active.id : undefined;

  ($("workspace-docker") as HTMLElement).hidden = showing === undefined;
  if (showing === dockerAttached) return;

  if (dockerAttached !== undefined) detachDockerPane(dockerAttached);
  if (showing !== undefined) attachDockerPane(showing, selectedProject);
  dockerAttached = showing;
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
  // bookmarks: the bar sits inside the browser's own chrome, directly under
  // the address bar, so it goes away with the rest of it. Stated as "not a
  // web tab" rather than as a list of kinds, so a fourth hosted app
  // inherits the rule for free. With no tab open at all the chrome stays:
  // that is the state where the bar is the quickest way to open something.
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
  const pageHidden = tab !== undefined && RENDERER_DRAWN.has(tab.kind) && tab.project === selected;
  ($("workspace-page") as HTMLElement).hidden = pageHidden;
  // The row wrapping the sidebar and the page slot must hide with the page:
  // otherwise, with the sidebar already hidden by hostedApp above, it would
  // sit here empty yet still claim its flex share, squeezing whichever
  // renderer-drawn pane is meant to fill that space instead.
  ($("workspace-body") as HTMLElement).hidden = pageHidden;
  renderWorkspaceTerminals(state.tabs, state.activeTabId, selected);
  renderApi(state.tabs, state.activeTabId, selected);
  renderDocker(state.tabs, state.activeTabId, selected);
  // dockerNames is a config lookup, not a docker subprocess (see
  // renderDockerButton) — cheap enough to recheck on every push of
  // workspace state, which is what lets a config change or a stale answer
  // correct itself without waiting for the user to switch projects and back.
  void renderDockerButton();

  // A closed tab takes its DevTools with it: main destroys the panel's view
  // along with the page's, so an id left here would resurrect a panel for a
  // later tab that happened to reuse it.
  const liveTabs = new Set(state.tabs.map((openTab) => openTab.id));
  for (const id of devToolsByTab) if (!liveTabs.has(id)) devToolsByTab.delete(id);
  renderDevTools();

  // Hiding the address bar or the bookmarks bar under it resizes the page
  // slot the hosted view is pinned to, and nothing else re-measures it — a
  // resize is the only reflow the window itself reports.
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
    devicePixelRatio: window.devicePixelRatio,
  });
}
