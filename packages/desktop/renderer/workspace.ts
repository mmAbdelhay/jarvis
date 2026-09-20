import type { WorkspaceState, WorkspaceTab } from "@jarvis/core";
import type { BrowserConfig } from "../src/config.js";
import type { DevToolsDock } from "../src/browser-host.js";
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
// Exported so the Dashboard's project cards (app.ts's buildProjectRow) can
// open the same blank tab their own "+" button does, without a second
// magic string to keep in sync with this one.
export const NEW_TAB_URL = "https://duckduckgo.com";

// The saved `browser:` settings, mirrored here the same way prayer.ts
// mirrors PrayerConfig — set once at load and again after every Save
// (app.ts), so a new tab opens the configured home page without a round
// trip through main for something the renderer already has.
let browserSnapshot: BrowserConfig = { allowPopups: true };
export function setBrowserSnapshot(value: BrowserConfig): void {
  browserSnapshot = value;
}

let latest: WorkspaceState = { tabs: [], activeTabId: undefined };
/** The activeTabId the last render saw — renderWorkspace follows the
 *  switcher to a tab's project only when this changes. */
let followedActiveTabId: string | undefined;

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

/** The Chat button's own tooltip, captured for the same reason
 *  clusterButtonTitle and dockerButtonTitle are. */
let chatButtonTitle = "";

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
    // Only our own text is cleared — the status line is shared with other
    // tool feedback (starting/error text for the editor, database, etc.).
    status.textContent = "";
  }
}

/** The shared status line under the tool row, the same surface openApi and
 *  openDocker report failures to. */
function showToolStatus(text: string): void {
  const status = $("workspace-tool-status");
  status.textContent = text;
  status.classList.add("workspace-tool-status--error");
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
  const result =
    project === "" ? { ok: true as const, value: [] } : await window.jarvis.dockerNames(project);
  // The user may have switched projects while that request was in flight;
  // a stale answer must not clobber whatever project is selected now.
  if (selectedProject() !== project) return;

  const names = result.ok ? result.value : [];
  const button = $("workspace-open-docker") as HTMLButtonElement;
  const disabled = names.length === 0;
  button.disabled = disabled;
  button.title = disabled ? MESSAGES.dockerNoContainers(PRIMARY_LANGUAGE) : dockerButtonTitle;
}

/** The Chat button follows the Cluster button's rule: disabled whenever the
 *  selected project declares no `chat:` entry, which is most projects and
 *  always the personal browser. Its own reason rather than
 *  personalHasNoDirectory — a chat is not rooted in a directory either. */
async function renderChatButton(): Promise<void> {
  const project = selectedProject();
  const names = project === "" ? [] : await window.jarvis.chatNames(project);
  // The user may have switched projects while that request was in flight;
  // a stale answer must not clobber whatever project is selected now.
  if (selectedProject() !== project) return;

  const button = $("workspace-open-chat") as HTMLButtonElement;
  const disabled = names.length === 0;
  button.disabled = disabled;
  button.title = disabled ? MESSAGES.noChatConfigured(PRIMARY_LANGUAGE) : chatButtonTitle;
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

/** One tab chip's live DOM identity plus the means to catch it up to a new
 *  WorkspaceTab, kept across renders in `tabChips` below (round 3) — the
 *  reconcile that replaced renderWorkspace's old
 *  `strip.replaceChildren(newTabButton)` rebuild, which tore down and
 *  recreated every chip (drag handlers, context menu, the works) on every
 *  `workspace:update`, flashing the strip and destroying an in-progress
 *  inline rename's `<input>` out from under a keystroke. */
type TabChipHandle = {
  element: HTMLElement;
  update: (tab: WorkspaceTab, activeTabId: string | undefined) => void;
};

/** Keyed by tab id, so a tab's chip survives every render its tab survives
 *  — including while its project is collapsed behind another one's pill,
 *  so switching back to it does not lose whatever the chip was mid-doing.
 *  Pruned in renderWorkspace to the tabs actually still open. */
const tabChips = new Map<string, TabChipHandle>();

/** Selects `project` and shows whatever it was last on: its remembered
 *  tab if that tab still exists, any other of its open tabs otherwise, or
 *  nothing (hideAll) if it has none open at all. Shared by the project
 *  <select> and by clicking a collapsed project pill in the tab strip. */
async function switchToProject(project: string): Promise<void> {
  const remembered = lastActiveTabByProject.get(project);
  const target =
    latest.tabs.find((tab) => tab.id === remembered && tab.project === project) ??
    latest.tabs.find((tab) => tab.project === project);
  if (target !== undefined) void window.jarvis.activateTab(target.id);
  else void window.jarvis.hideAllTabs();

  await selectProjectChrome(project);
}

/** Everything about the chrome that belongs to the selected project — the
 *  switcher's own value, the per-project menus and buttons, the bookmarks —
 *  without touching which tab is active. switchToProject adds the
 *  activation; renderWorkspace calls this alone when a tab activated from
 *  outside this view (a Dashboard card's shortcut, the Session view) turns
 *  out to belong to another project, so the switcher follows the tab
 *  instead of still naming the project it showed a moment ago. */
async function selectProjectChrome(project: string): Promise<void> {
  ($("workspace-project") as HTMLSelectElement).value = project;
  // The menu lists one project's roots; leaving it up over another project
  // would open a root the selector no longer shows.
  closeEditorMenu();
  // Same reasoning, and the same bug otherwise: the menu's items close over
  // the OLD project, so a stale one left open would open or activate the
  // wrong project's cluster tab.
  closeClusterMenu();
  // And again for the chat menu, whose items close over the old project in
  // exactly the same way.
  closeChatMenu();

  renderProjectTools();
  void renderClusterButton();
  void renderDockerButton();
  void renderChatButton();
  await refreshBookmarks();
}

let bookmarks: BookmarkView[] = [];

/** Whether the user wants the bookmarks sidebar at all. Their preference
 *  for browser tabs only — a hosted app has no sidebar to show either way, so
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

/** The panel's share of the stage — its height docked to the bottom, its
 *  width docked to a side. Dragged by the handle between page and panel,
 *  clamped so neither is squeezed away. Kept apart because a comfortable
 *  height and a comfortable width are different numbers. */
let devToolsFraction = 0.4;
let devToolsSideFraction = 0.4;
const MIN_DEVTOOLS_FRACTION = 0.15;
const MAX_DEVTOOLS_FRACTION = 0.85;

/** Where DevTools dock, for every tab, as in Chrome. The order is Chrome's
 *  own dock-side row, which the panel head copies. */
const DEVTOOLS_DOCKS: readonly DevToolsDock[] = ["undocked", "left", "bottom", "right"];
let devToolsDock: DevToolsDock = "bottom";

/** Remembered per machine rather than written to jarvis.yaml: where DevTools
 *  sit is a habit, not configuration. */
const DEVTOOLS_LAYOUT_KEY = "jarvis.devtools.layout";

function clampDevToolsFraction(value: number): number {
  return Math.min(MAX_DEVTOOLS_FRACTION, Math.max(MIN_DEVTOOLS_FRACTION, value));
}

function loadDevToolsLayout(): void {
  try {
    const raw = window.localStorage.getItem(DEVTOOLS_LAYOUT_KEY);
    if (raw === null) return;
    const saved = JSON.parse(raw) as { dock?: unknown; height?: unknown; width?: unknown };
    const dock = DEVTOOLS_DOCKS.find((candidate) => candidate === saved.dock);
    if (dock !== undefined) devToolsDock = dock;
    if (typeof saved.height === "number") devToolsFraction = clampDevToolsFraction(saved.height);
    if (typeof saved.width === "number") devToolsSideFraction = clampDevToolsFraction(saved.width);
  } catch {
    // Unreadable or unavailable storage is a first run: the defaults stand.
  }
}

function saveDevToolsLayout(): void {
  try {
    window.localStorage.setItem(
      DEVTOOLS_LAYOUT_KEY,
      JSON.stringify({ dock: devToolsDock, height: devToolsFraction, width: devToolsSideFraction }),
    );
  } catch {
    // Not remembering is not worth interrupting anyone over.
  }
}

/** Refetches the *selected* project's bookmarks and redraws the bar —
 *  called on init and every project switch, never kept in sync with tabs
 *  (a different project's tabs collapsing into a pill does not touch it). */
async function refreshBookmarks(): Promise<void> {
  const project = selectedProject();
  const result =
    project === "" ? { ok: true as const, value: [] } : await window.jarvis.listBookmarks(project);
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

/** One row in the list. The rail stacked the title over the host; a row
 *  one line tall has space for the title alone, so the address moves to the
 *  tooltip — where it is the more useful half anyway. Its icon is the same
 *  cached-icon-or-monogram choice the grid makes, at list-row size rather
 *  than the grid's tile size. */
/** U+270E with a variation selector forcing *text* presentation. Without
 *  it the font substitutes the emoji pencil, which renders fat and coloured
 *  beside the hairline \u229E and \u00D7 it sits next to. */
const RENAME_GLYPH = "\u270E\uFE0E";

function renderBookmarkChip(bookmark: BookmarkView): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "workspace-bookmark";
  // Both the title and the URL are page-supplied text; the attribute takes
  // it as text and nothing else, same discipline as the tab strip.
  chip.title = bookmark.url;
  chip.addEventListener("click", () => openBookmark(bookmark.url));
  wireDrag(chip, bookmark);

  const icon = document.createElement("span");
  icon.className = "workspace-bookmark-icon";
  if (bookmark.icon === undefined) {
    icon.append(monogramTile(bookmark));
  } else {
    const img = document.createElement("img");
    img.src = bookmark.icon;
    img.alt = "";
    icon.append(img);
  }

  const title = document.createElement("span");
  title.className = "workspace-bookmark-title";
  const label = bookmark.title === "" ? bookmark.url : bookmark.title;
  title.textContent = label;
  // An Arabic title left at the document's LTR direction puts its
  // punctuation and its ellipsis on the wrong edge — visible immediately in
  // a strip of short chips, which is the whole bar.
  title.dir = detectLanguage(label) === "ar" ? "rtl" : "ltr";

  // The spec's per-row pin control (design :240). Drag alone leaves the
  // feature unreachable from the state every existing install upgrades
  // into — everything unpinned, so an empty grid with no tile to drop on —
  // and gives a keyboard user no path at all.
  const pin = glyphControl(
    "⊞",
    MESSAGES.pinBookmark(PRIMARY_LANGUAGE),
    () => void pinBookmark(bookmark.url, true),
  );
  pin.classList.add("workspace-bookmark-pin");

  const rename = glyphControl(RENAME_GLYPH, MESSAGES.renameBookmark(PRIMARY_LANGUAGE), () =>
    editChipTitle(title, bookmark, label),
  );
  rename.classList.add("workspace-bookmark-rename");

  const remove = document.createElement("span");
  remove.className = "workspace-bookmark-remove";
  remove.textContent = "×";
  remove.addEventListener("click", (event) => {
    // Without this the chip underneath also receives the click and opens
    // the bookmark it was just removed from.
    event.stopPropagation();
    void removeBookmark(bookmark.url);
  });

  chip.append(icon, title, rename, pin, remove);
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
  // `ch` is a whole code point from a string iterator, so codePointAt(0) is
  // always there; the ?? keeps that out of the type system’ hands.
  for (const ch of origin) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 360;
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

/** A quiet glyph button, the same idiom workspace-docker.ts's actionButton
 *  uses: dim at rest, full opacity on hover or focus, the bilingual name on
 *  both `title` and `aria-label` with the glyph itself hidden from the
 *  accessibility tree. `stopPropagation` because every one of these sits
 *  inside something that is itself clickable. */
/**
 * The field a rename is typed into.
 *
 * Editing happens in place — the chip's own label becomes this input —
 * rather than through a prompt row, because the bookmarks bar is a narrow
 * column and a row of input-plus-buttons pushed the whole list down for
 * something that should not move the page at all.
 *
 * Electron has no window.prompt (it throws), and jsdom has one, so a test
 * suite cannot warn you off it. That trap cost the API pane every rename it
 * had; this avoids the question entirely by never asking outside the DOM.
 *
 * Enter and blur commit, Escape abandons. `settled` is the guard that keeps
 * those from firing twice: committing on Enter moves focus, which fires
 * blur, which would otherwise commit a second time.
 */
function titleEditor(
  current: string,
  commit: (title: string) => void,
  done: () => void,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "workspace-rename-input";
  input.spellcheck = false;
  input.value = current;

  let settled = false;
  const accept = (): void => {
    if (settled) return;
    settled = true;
    const title = input.value.trim();
    // An empty field means "leave it alone", not "name it nothing" — the
    // store would refuse the blank anyway, and a refusal message for an
    // empty box the user clicked away from is noise.
    if (title === "" || title === current) done();
    else commit(title);
  };
  const abandon = (): void => {
    if (settled) return;
    settled = true;
    done();
  };

  input.addEventListener("keydown", (event) => {
    // A text field inside a pane that binds bare keys to tab and address-bar
    // shortcuts: its keys are its own.
    event.stopPropagation();
    if (event.key === "Enter") accept();
    else if (event.key === "Escape") abandon();
  });
  input.addEventListener("blur", accept);
  // The chip underneath opens the bookmark on click; typing in the field is
  // not a request to navigate.
  input.addEventListener("click", (event) => event.stopPropagation());
  return input;
}

/** Retitles one bookmark. The store keeps the url, the pin and the order,
 *  so an essential renamed from its tile stays in the tile it was in —
 *  only its label and its monogram change. */
async function renameBookmark(url: string, title: string): Promise<void> {
  const result = await window.jarvis.renameBookmark(selectedProject(), url, title);
  if (result.ok) bookmarks = result.value;
  else showToolStatus(result.text);
  renderBookmarks();
}

/** Swaps a chip's label for the field, in place. Redrawing the bar would
 *  destroy the input mid-edit, so nothing is re-rendered until the edit
 *  settles: cancelling just puts the label back. */
function editChipTitle(label: HTMLElement, bookmark: BookmarkView, current: string): void {
  const input = titleEditor(
    current,
    (title) => void renameBookmark(bookmark.url, title),
    () => {
      input.replaceWith(label);
    },
  );
  label.replaceWith(input);
  input.focus();
  input.select();
}

/** A pinned bookmark has no label to edit — the tile is an icon and a
 *  monogram — so its rename appears as one line under the grid. Which is
 *  where the name matters most: the monogram is built from it. */
function editEssentialTitle(bookmark: BookmarkView, current: string): void {
  const row = $("workspace-ask");
  row.replaceChildren();
  // Closed on both paths, not just on cancel: committing redraws the grid
  // but not this row, which would otherwise stay open under it holding the
  // name it had already saved.
  const close = (): void => {
    row.hidden = true;
    row.replaceChildren();
  };
  const input = titleEditor(
    current,
    (title) => {
      close();
      void renameBookmark(bookmark.url, title);
    },
    close,
  );
  row.append(input);
  row.hidden = false;
  input.focus();
  input.select();
}

function glyphControl(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "workspace-bookmark-action";
  button.title = label;
  button.setAttribute("aria-label", label);
  const mark = document.createElement("span");
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = glyph;
  button.append(mark);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

/** A grid tile: the bookmark's icon, plus the spec's unpin action.
 *
 *  The tile used to *be* a `<button>`, which leaves nowhere to put the
 *  unpin control — a button inside a button is invalid HTML and browsers
 *  reparent it. So the tile is a plain wrapper holding two sibling
 *  buttons: one filling it, which opens the bookmark, and the unpin action
 *  in its corner. Both keep a real tab stop that way, which a
 *  `role="button"` div would have had to reimplement by hand. */
function renderEssential(bookmark: BookmarkView): HTMLElement {
  const label = bookmark.title === "" ? bookmark.url : bookmark.title;
  const tile = document.createElement("div");
  tile.className = "workspace-essential";
  tile.title = label;
  tile.dataset["url"] = bookmark.url;

  const open = document.createElement("button");
  open.type = "button";
  open.className = "workspace-essential-open";
  open.setAttribute("aria-label", label);
  if (bookmark.icon === undefined) {
    open.append(monogramTile(bookmark));
  } else {
    const img = document.createElement("img");
    img.src = bookmark.icon;
    img.alt = "";
    open.append(img);
  }
  open.addEventListener("click", () => openBookmark(bookmark.url));

  const unpin = glyphControl(
    "⊟",
    MESSAGES.unpinBookmark(PRIMARY_LANGUAGE),
    () => void pinBookmark(bookmark.url, false),
  );
  unpin.classList.add("workspace-essential-unpin");

  // A pinned bookmark is not in the chip list — the list is the unpinned
  // ones — so without this the essentials grid would be the one place a
  // bookmark could not be renamed. Which is exactly where the names matter
  // most: the tile shows a monogram built from the title.
  const rename = glyphControl(RENAME_GLYPH, MESSAGES.renameBookmark(PRIMARY_LANGUAGE), () =>
    editEssentialTitle(bookmark, label),
  );
  rename.classList.add("workspace-essential-rename");

  tile.append(open, unpin, rename);
  wireDrag(tile, bookmark);
  return tile;
}

/** The click and keyboard path for what dragging does: pin a listed
 *  bookmark, or unpin a tile. A refusal (a thirteenth pin) is surfaced the
 *  way the drag path surfaces it, through the store's own words. */
async function pinBookmark(url: string, pinned: boolean): Promise<void> {
  const result = await window.jarvis.setBookmarkPinned(selectedProject(), url, pinned);
  if (result.ok) bookmarks = result.value;
  else showToolStatus(result.text);
  renderBookmarks();
}

/** Dropping onto a bookmark puts the dragged one in its place, within
 *  whichever group the target belongs to. The store is sent the whole
 *  group in its new order, so it never has to infer a move from a delta. */
async function dropOnto(draggedUrl: string, target: BookmarkView): Promise<void> {
  const project = selectedProject();
  const dragged = bookmarks.find((b) => b.url === draggedUrl);
  if (dragged === undefined) return;

  // Crossing between the grid and the list is a pin change first: the
  // store decides whether a thirteenth pin is allowed, and a refusal must
  // stop the reorder rather than leave the two disagreeing.
  if ((dragged.pinned === true) !== (target.pinned === true)) {
    const pinResult = await window.jarvis.setBookmarkPinned(
      project,
      draggedUrl,
      target.pinned === true,
    );
    if (!pinResult.ok) {
      showToolStatus(pinResult.text);
      return;
    }
    bookmarks = pinResult.value;
  }

  const group = bookmarks.filter((b) => (b.pinned === true) === (target.pinned === true));
  const without = group.filter((b) => b.url !== draggedUrl).map((b) => b.url);
  const at = without.indexOf(target.url);
  const order = [...without.slice(0, at), draggedUrl, ...without.slice(at)];

  const result = await window.jarvis.reorderBookmarks(project, order);
  if (result.ok) bookmarks = result.value;
  else showToolStatus(result.text);
  renderBookmarks();
}

/** Dropping on the grid's empty space pins, and puts the newly pinned
 *  bookmark last.
 *
 *  The trailing reorder is not decoration: a pin change leaves `order`
 *  alone, so a listed bookmark carrying `order: 2` would otherwise land in
 *  the *middle* of the grid — a position the user never chose and the drop
 *  never implied. Empty space means "at the end". A tile that is already
 *  pinned returns before any of that: the pin call would change nothing
 *  and still rewrite bookmarks.json. */
async function dropOnGrid(draggedUrl: string): Promise<void> {
  const project = selectedProject();
  const dragged = bookmarks.find((b) => b.url === draggedUrl);
  if (dragged === undefined || dragged.pinned === true) return;

  const result = await window.jarvis.setBookmarkPinned(project, draggedUrl, true);
  if (!result.ok) {
    showToolStatus(result.text);
    renderBookmarks();
    return;
  }
  bookmarks = result.value;
  await appendWithinGroup(project, draggedUrl, true);
}

/** Dropping on the list's empty space unpins, on the same terms — the
 *  mirror of dropOnGrid, and the drag path out of a grid that holds every
 *  bookmark the project has. */
async function dropOnList(draggedUrl: string): Promise<void> {
  const project = selectedProject();
  const dragged = bookmarks.find((b) => b.url === draggedUrl);
  if (dragged === undefined || dragged.pinned !== true) return;

  const result = await window.jarvis.setBookmarkPinned(project, draggedUrl, false);
  if (!result.ok) {
    showToolStatus(result.text);
    renderBookmarks();
    return;
  }
  bookmarks = result.value;
  await appendWithinGroup(project, draggedUrl, false);
}

/** Sends the group's order with `url` moved to the end of it. */
async function appendWithinGroup(project: string, url: string, pinned: boolean): Promise<void> {
  const group = bookmarks.filter((b) => (b.pinned === true) === pinned).map((b) => b.url);
  const order = [...group.filter((u) => u !== url), url];
  const result = await window.jarvis.reorderBookmarks(project, order);
  if (result.ok) bookmarks = result.value;
  else showToolStatus(result.text);
  renderBookmarks();
}

/** Makes a bookmark's element draggable and wires the reorder/pin drop
 *  protocol shared by the grid and the list: the only thing a drag ever
 *  carries is a url, so renderEssential and renderBookmarkChip wire this
 *  identically. */
function wireDrag(element: HTMLElement, bookmark: BookmarkView): void {
  element.draggable = true;
  element.addEventListener("dragstart", (event) => {
    (event as DragEvent).dataTransfer?.setData("text/plain", bookmark.url);
  });
  element.addEventListener("dragover", (event) => event.preventDefault());
  element.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const dragged = (
      event as unknown as { dataTransfer: { getData(type: string): string } }
    ).dataTransfer.getData("text/plain");
    if (dragged === "" || dragged === bookmark.url) return;
    void dropOnto(dragged, bookmark);
  });
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

  // Nothing pinned is the state every install upgrades into, and the grid
  // keeps its height there (styles.css gives it a min-height) so it stays a
  // drop target. A blank band with no words in it reads as a glitch — the
  // same reason the list has had a note of its own all along.
  if (pinned.length === 0) {
    const hint = document.createElement("span");
    hint.className = "workspace-essentials-empty";
    const note = MESSAGES.noEssentials(PRIMARY_LANGUAGE);
    hint.textContent = note;
    hint.dir = detectLanguage(note) === "ar" ? "rtl" : "ltr";
    grid.append(hint);
  }

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

/** The sidebar shows only when both the chrome rule and the user's own
 *  toggle allow it. Kept in one function because those two reasons to be
 *  hidden are decided in different places and must not drift. */
function renderBookmarksVisibility(
  hostedApp = activeTab() !== undefined && activeTab()?.kind !== "web",
): void {
  ($("workspace-bookmarks") as HTMLElement).hidden = hostedApp || !bookmarksVisible;
  $("workspace-toggle-bookmarks").classList.toggle("workspace-nav--on", bookmarksVisible);
}

function toggleBookmarksSidebar(): void {
  bookmarksVisible = !bookmarksVisible;
  renderBookmarksVisibility();
  // The sidebar is a column beside the page slot; showing or hiding it
  // moves the slot's left edge, and a hosted view pinned to the old
  // rectangle would be left overlapping the sidebar or short of the right.
  reportWorkspaceBounds();
}

/** Shows or hides the DevTools panel for whatever tab is active, lays the
 *  stage out for the dock side, sizes the panel, and reports its rectangle.
 *  Undocked DevTools are a window of their own and take no room here, but
 *  the toggle still reads as on. */
function renderDevTools(): void {
  const tab = activeTab();
  const open = tab !== undefined && devToolsByTab.has(tab.id);
  const docked = open && devToolsDock !== "undocked";
  const panel = $("workspace-devtools") as HTMLElement;
  const stage = $("workspace-stage");

  const side = devToolsDock === "undocked" ? "bottom" : devToolsDock;
  for (const candidate of ["left", "bottom", "right"] as const) {
    stage.classList.toggle(`workspace-stage--${candidate}`, candidate === side);
  }
  panel.hidden = !docked;
  ($("workspace-devtools-handle") as HTMLElement).hidden = !docked;
  $("workspace-toggle-devtools").classList.toggle("workspace-nav--on", open);
  for (const dock of DEVTOOLS_DOCKS) {
    $(`workspace-devtools-dock-${dock}`).classList.toggle(
      "workspace-devtools-button--on",
      dock === devToolsDock,
    );
  }

  if (!docked) return;

  const bottom = devToolsDock === "bottom";
  const available = bottom ? stage.clientHeight : stage.clientWidth;
  const fraction = bottom ? devToolsFraction : devToolsSideFraction;
  // A stage with no layout yet measures zero; a percentage still lands
  // correctly once it does, where a computed pixel size would not.
  const size =
    available === 0 ? `${Math.round(fraction * 100)}%` : `${Math.round(available * fraction)}px`;
  panel.style.height = bottom ? size : "";
  panel.style.width = bottom ? "" : size;
  reportDevToolsBounds();
}

/** Moves DevTools to another side, or out into their own window. Choosing
 *  where DevTools go is asking for them, so a choice made from the
 *  right-click menu while they are shut opens them there. */
function chooseDevToolsDock(dock: DevToolsDock): void {
  devToolsDock = dock;
  saveDevToolsLayout();
  // Before any setDevTools below, so main opens them where they now belong.
  void window.jarvis.setDevToolsDock(dock);
  const tab = activeTab();
  if (tab !== undefined && !devToolsByTab.has(tab.id)) {
    toggleDevTools();
    return;
  }
  renderDevTools();
  // The page slot just grew or shrank with the panel.
  reportWorkspaceBounds();
}

function reportDevToolsBounds(): void {
  const rect = $("workspace-devtools-slot").getBoundingClientRect();
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

/** Drags the split between the page and the DevTools panel — vertically
 *  while they dock to the bottom, horizontally while they dock to a side.
 *  The pointer is tracked on the window rather than the handle, so a fast
 *  drag that leaves the 6px strip does not silently stop resizing. */
function wireDevToolsHandle(): void {
  $("workspace-devtools-handle").addEventListener("mousedown", (event) => {
    event.preventDefault();
    const panel = $("workspace-devtools") as HTMLElement;
    const stage = $("workspace-stage");

    const onMove = (move: MouseEvent): void => {
      const box = stage.getBoundingClientRect();
      if (devToolsDock === "bottom") {
        if (box.height === 0) return;
        devToolsFraction = clampDevToolsFraction((box.bottom - move.clientY) / box.height);
        panel.style.height = `${Math.round(box.height * devToolsFraction)}px`;
      } else {
        if (box.width === 0) return;
        const share =
          devToolsDock === "right"
            ? (box.right - move.clientX) / box.width
            : (move.clientX - box.left) / box.width;
        devToolsSideFraction = clampDevToolsFraction(share);
        panel.style.width = `${Math.round(box.width * devToolsSideFraction)}px`;
      }
      reportDevToolsBounds();
      reportWorkspaceBounds();
    };

    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      saveDevToolsLayout();
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
  chatButtonTitle = ($("workspace-open-chat") as HTMLButtonElement).title;

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
    void window.jarvis.openTab(selectedProject(), browserSnapshot.homePage ?? NEW_TAB_URL);
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
  $("view-workspace").addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.defaultPrevented || event.altKey || event.shiftKey) return;
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "r") return;
    const tab = activeTab();
    if (tab?.kind !== "web") return;
    event.preventDefault();
    void window.jarvis.tabReload(tab.id);
  });

  // The overlay does not move with the layout, so every reflow has to be
  // pushed. A resize is the only one the renderer can observe cheaply.
  // The panel's size is a share of the stage, held as pixels; a resized
  // window has to recompute it before the page slot is measured.
  window.addEventListener("resize", () => {
    renderDevTools();
    reportWorkspaceBounds();
  });

  $("workspace-open-editor").addEventListener("click", () => void openEditor());
  $("workspace-open-database").addEventListener("click", () => void openDatabase());
  $("workspace-open-cluster").addEventListener("click", () => void openCluster());
  // No preWarm twin below: nothing is spawned behind a chat tab, so a hover
  // has nothing to warm and the click pays nothing to skip.
  $("workspace-open-chat").addEventListener("click", () => void openChat());
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

  const grid = $("workspace-essentials");
  grid.addEventListener("dragover", (event) => event.preventDefault());
  grid.addEventListener("drop", (event) => {
    event.preventDefault();
    const dragged = (
      event as unknown as { dataTransfer: { getData(type: string): string } }
    ).dataTransfer.getData("text/plain");
    if (dragged !== "") void dropOnGrid(dragged);
  });

  // The list's own container drop, mirroring the grid's: without it a
  // project whose bookmarks are all pinned has an empty list with no
  // row to drop onto, and dragging could never take anything back out.
  const list = $("workspace-bookmark-list");
  list.addEventListener("dragover", (event) => event.preventDefault());
  list.addEventListener("drop", (event) => {
    event.preventDefault();
    const dragged = (
      event as unknown as { dataTransfer: { getData(type: string): string } }
    ).dataTransfer.getData("text/plain");
    if (dragged !== "") void dropOnList(dragged);
  });

  $("workspace-bookmark-toggle").addEventListener("click", () => void toggleBookmark());
  $("workspace-toggle-bookmarks").addEventListener("click", () => toggleBookmarksSidebar());
  // Bilingual like every other user-facing string, and set here rather than
  // hard-coded in index.html — the same treatment #workspace-pip's title
  // gets above.
  ($("workspace-toggle-bookmarks") as HTMLButtonElement).title =
    MESSAGES.toggleBookmarksSidebar(PRIMARY_LANGUAGE);
  $("workspace-toggle-devtools").addEventListener("click", () => toggleDevTools());
  // Right-click is the way back from an undocked window, which has no dock
  // buttons of its own — so it works whether DevTools are open or not.
  $("workspace-toggle-devtools").addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void window.jarvis.showDevToolsDockMenu(devToolsDock);
  });
  ($("workspace-toggle-devtools") as HTMLButtonElement).title =
    MESSAGES.devToolsToggle(PRIMARY_LANGUAGE);
  for (const dock of DEVTOOLS_DOCKS) {
    const button = $(`workspace-devtools-dock-${dock}`) as HTMLButtonElement;
    button.title = MESSAGES.devToolsDock(dock, PRIMARY_LANGUAGE);
    button.addEventListener("click", () => chooseDevToolsDock(dock));
  }
  const closeDevToolsButton = $("workspace-devtools-close") as HTMLButtonElement;
  closeDevToolsButton.title = MESSAGES.devToolsClose(PRIMARY_LANGUAGE);
  closeDevToolsButton.addEventListener("click", () => toggleDevTools());
  window.jarvis.onDevToolsDockChosen((dock) => chooseDevToolsDock(dock));
  window.jarvis.onDevToolsClosed((tabId) => {
    if (!devToolsByTab.delete(tabId)) return;
    renderDevTools();
    reportWorkspaceBounds();
  });
  loadDevToolsLayout();
  // Main starts at its own default; this is what brings it in line with the
  // side remembered from last time before any DevTools are opened.
  void window.jarvis.setDevToolsDock(devToolsDock);
  wireDevToolsHandle();
  renderBookmarksVisibility(false);
  renderProjectTools();
  void renderClusterButton();
  void renderDockerButton();
  void renderChatButton();
  void refreshBookmarks();
}

/** Refreshes the project choices after Settings saves, without wiring the
 * Workspace's one-time event listeners a second time. */
export function refreshWorkspaceProjects(projects: string[]): void {
  const select = $("workspace-project") as HTMLSelectElement;
  const previous = select.value;
  select.replaceChildren();
  for (const project of [...projects, PERSONAL_PROJECT]) {
    colorFor(project);
    const option = document.createElement("option");
    option.value = project;
    option.textContent = projectLabel(project);
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  renderWorkspace(latest);
}

/** The Editor button. A project that configures no `editors:` roots opens
 *  at its own directory, exactly as it always did; one root opens straight
 *  into it; two or more offer a menu, since picking is the whole point of
 *  having configured them. The roots are re-read on every click rather than
 *  cached, so a saved config change takes effect on the next click. */
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

/** The Chat button. The Cluster button's shape with the waiting taken out:
 *  no chat entries disables it (see renderChatButton), one opens it, two or
 *  more offer a menu. Names are re-read on every click rather than cached,
 *  so a config change needs no more than the Settings restart. */
async function openChat(): Promise<void> {
  // A second click on the button is "put that menu away", not "open it
  // again" — the only other way out would be clicking a name.
  if (!chatMenu().hidden) {
    closeChatMenu();
    return;
  }

  const project = selectedProject();
  const names = await window.jarvis.chatNames(project);
  if (names.length === 0) return;
  if (names.length > 1) {
    showChatMenu(project, names);
    return;
  }
  await openChatNamed(project, names[0] as string);
}

function chatMenu(): HTMLElement {
  return $("workspace-chat-menu");
}

function closeChatMenu(): void {
  const menu = chatMenu();
  menu.hidden = true;
  menu.replaceChildren();
}

/** The name picker. A chat name is config text like a project name, so it
 *  is a node with its textContent set — no innerHTML here either. */
function showChatMenu(project: string, names: string[]): void {
  const menu = chatMenu();
  menu.replaceChildren();
  for (const name of names) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "workspace-menu-item";
    item.textContent = name;
    item.addEventListener("click", () => {
      closeChatMenu();
      void openChatNamed(project, name);
    });
    menu.append(item);
  }
  menu.hidden = false;
}

/** Opens one of a project's configured chats as an ordinary hosted page.
 *
 *  There is no beginStarting here, unlike every other button in this
 *  toolbar: nothing is spawned, so main answers with the URL in the time an
 *  IPC round trip takes, and a "starting…" line would flash and vanish. */
async function openChatNamed(project: string, name: string): Promise<void> {
  // A project may declare both a Teams tenant and a Slack workspace, so the
  // tab's own `detail` decides which is already open and the project alone
  // cannot — the same reason openClusterNamed matches on detail.
  const existing = latest.tabs.find(
    (tab) => tab.kind === "chat" && tab.project === project && tab.detail === name,
  );
  if (existing !== undefined) {
    void window.jarvis.activateTab(existing.id);
    return;
  }

  const status = $("workspace-tool-status");
  const result = await window.jarvis.openChat(project, name);
  if (!result.ok) {
    status.textContent = result.text;
    status.classList.add("workspace-tool-status--error");
    return;
  }
  status.textContent = "";
  void window.jarvis.openTab(project, result.value, "chat", name);
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
 *  instances are guarded by a login generated at spawn. The desktop answers
 *  that login itself (Electron's `login` event, main.ts), so the tab opens
 *  already authenticated and the credential is never shown here. */
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

  status.textContent = "";
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
function renderDocker(
  tabs: WorkspaceTab[],
  activeTabId: string | undefined,
  selectedProject: string,
): void {
  const active = tabs.find((tab) => tab.id === activeTabId);
  const showing =
    active?.kind === "docker" && active.project === selectedProject ? active.id : undefined;

  ($("workspace-docker") as HTMLElement).hidden = showing === undefined;
  if (showing === dockerAttached) return;

  if (dockerAttached !== undefined) detachDockerPane(dockerAttached);
  if (showing !== undefined) attachDockerPane(showing, selectedProject);
  dockerAttached = showing;
}

/** Hides a chip's own context menu, undoing openTabMenu below. Shared by
 *  every item's click and by the light-dismiss `toggle` event, the same
 *  split block-view.ts's hideMoreMenu uses for the block "more" menu. */
function hideTabMenu(menu: HTMLElement): void {
  if (typeof menu.hidePopover === "function") {
    try {
      menu.hidePopover();
    } catch {
      // Already light-dismissed (an outside click, or Escape).
    }
  }
  menu.hidden = true;
}

/** Opens a chip's context menu in the top layer, positioned off the click
 *  that asked for it — same Popover API and clamped placement as the
 *  block's own "more" menu (block-view.ts), so a chip near the window's
 *  edge never draws off screen. */
function openTabMenu(menu: HTMLElement, event: MouseEvent): void {
  menu.hidden = false;
  if (typeof menu.showPopover !== "function") return;
  menu.showPopover();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
}

/** Builds one tab chip and the `update` closure that catches it up to a
 *  later WorkspaceTab, so the strip's reconcile (renderWorkspace) can reuse
 *  the same element — and the same drag/context-menu listeners, attached
 *  here exactly once — across every render the tab survives.
 *
 *  `tab` is a `let`, reassigned by `update`: every closure below
 *  (drag/drop, click, the menu items, startRename) reads it live rather
 *  than a value frozen at creation, so a chip built for one WorkspaceTab
 *  keeps acting on the current one after a reuse. Only `tab.id` actually
 *  needs that — it never changes for a chip kept in `tabChips` by that same
 *  id — but reading the whole object uniformly is what keeps startRename's
 *  `tab.customTitle` fallback correct after a rename or a title push. */
function createTabChip(initialTab: WorkspaceTab, activeTabId: string | undefined): TabChipHandle {
  let tab = initialTab;
  // True while the inline rename `<input>` has replaced `title` in the DOM
  // — update() must not touch `title`'s text then, or it would overwrite
  // what the user is mid-typing the moment an unrelated push (a loading
  // flag, another tab's title) triggers a re-render.
  let renaming = false;

  const element = document.createElement("div");
  element.className = "workspace-tab";
  element.draggable = true;
  // Right-click reaches the same rename the double-click below starts, plus
  // Reload and Close — discoverable without knowing double-click renames at
  // all, which the title below also now says outright.
  element.title = MESSAGES.tabRenameHint(PRIMARY_LANGUAGE);
  element.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("text/x-jarvis-tab", tab.id);
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
  });
  element.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("text/x-jarvis-tab")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  });
  element.addEventListener("drop", (event) => {
    const source = event.dataTransfer?.getData("text/x-jarvis-tab");
    if (!source || source === tab.id) return;
    event.preventDefault();
    const after = event.clientX >= element.getBoundingClientRect().left + element.clientWidth / 2;
    void window.jarvis.moveTab(source, tab.id, after);
  });
  element.addEventListener("click", () => void window.jarvis.activateTab(tab.id));

  const title = document.createElement("span");
  title.className = "workspace-tab-title";

  const currentTitle = (): string => tab.customTitle ?? (tab.title === "" ? tab.url : tab.title);

  // Shared by the double-click below and the menu's own Rename item, so
  // there is exactly one way an inline rename actually starts.
  const startRename = (): void => {
    const input = document.createElement("input");
    input.className = "workspace-tab-rename";
    input.setAttribute("aria-label", MESSAGES.renameTab(PRIMARY_LANGUAGE));
    input.value = tab.customTitle ?? title.textContent ?? "";
    title.replaceWith(input);
    element.draggable = false;
    renaming = true;
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      if (save) void window.jarvis.renameTab(tab.id, input.value);
      input.replaceWith(title);
      element.draggable = true;
      renaming = false;
      // A push may have landed while the field was open and been withheld
      // from `title` the whole time (see update() below) — catch it up now
      // that the span is back in the DOM.
      title.textContent = currentTitle();
    };
    input.addEventListener("keydown", (key) => {
      key.stopPropagation();
      if (key.key === "Enter") finish(true);
      if (key.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (click) => click.stopPropagation());
  };

  element.addEventListener("dblclick", (event) => {
    if ((event.target as HTMLElement).closest(".workspace-tab-close") !== null) return;
    event.stopPropagation();
    startRename();
  });

  const close = document.createElement("span");
  close.className = "workspace-tab-close";
  close.textContent = "×";
  close.addEventListener("click", (event) => {
    // Without this the tab underneath also receives the click and gets
    // activated on its way out.
    event.stopPropagation();
    void window.jarvis.closeTab(tab.id);
  });

  const menu = document.createElement("div");
  menu.className = "workspace-tab-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("popover", "auto");
  menu.hidden = true;
  menu.addEventListener("toggle", () => {
    if (menu.matches(":popover-open")) return;
    menu.hidden = true;
  });
  // Without this a click inside the menu bubbles to `element` and activates
  // the tab underneath it on its way out, same reason `close` above stops it.
  menu.addEventListener("click", (event) => event.stopPropagation());

  const menuItem = (label: string, run: () => void): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-tab-menu-item";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.addEventListener("click", () => {
      hideTabMenu(menu);
      run();
    });
    return button;
  };

  menu.append(
    menuItem(MESSAGES.tabMenuRename(PRIMARY_LANGUAGE), startRename),
    menuItem(MESSAGES.tabMenuReload(PRIMARY_LANGUAGE), () => void window.jarvis.tabReload(tab.id)),
    menuItem(MESSAGES.tabMenuClose(PRIMARY_LANGUAGE), () => void window.jarvis.closeTab(tab.id)),
  );

  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openTabMenu(menu, event);
  });

  element.append(title, close, menu);

  const update = (nextTab: WorkspaceTab, nextActiveTabId: string | undefined): void => {
    tab = nextTab;
    element.style.setProperty("--tab-color", colorFor(tab.project));
    element.classList.toggle("workspace-tab--on", tab.id === nextActiveTabId);
    element.classList.toggle("workspace-tab--loading", tab.loading);
    // A page picks its own title; it is text here and nothing else — but
    // never while the rename input is standing in for this span (see
    // `renaming` above).
    if (!renaming) title.textContent = currentTitle();
  };
  update(tab, activeTabId);

  return { element, update };
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
    // The switcher follows a NEWLY activated tab: a Terminal opened from a
    // Dashboard card lands here with its own project active, and the
    // <select> used to keep showing whichever project it showed last. Only
    // on a change of active tab — hideAll() (switching to a project with no
    // open tabs) deliberately keeps the old tab active, and following it
    // there would snap the switcher straight back.
    if (
      state.activeTabId !== followedActiveTabId &&
      selectedProject() !== activeTabForState.project
    ) {
      void selectProjectChrome(activeTabForState.project);
    }
  }
  followedActiveTabId = state.activeTabId;

  const selected = selectedProject();
  // The project switcher's own leading edge picks up the selected project's
  // colour, the same palette a tab chip's top band uses — colorFor never
  // reassigns one, so the switcher and every one of that project's chips
  // always agree.
  if (selected !== "") $("workspace-project").style.setProperty("--tab-color", colorFor(selected));
  const strip = $("workspace-tabs");
  // "+" is the strip's own static last child (index.html), found by id
  // rather than kept from a previous render — nothing here ever moves it
  // after this, so it stays the insertion point for every chip and pill,
  // immediately after the last one, for the same reason it always has been.
  const newTabButton = $("workspace-new-tab");

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

  // A keyed reconcile (round 3), replacing the old
  // `strip.replaceChildren(newTabButton)` + full rebuild: that tore down
  // and recreated every chip on every `workspace:update` — a loading
  // toggle, a title push, anything — which flashed the strip and destroyed
  // an in-progress inline rename's `<input>` mid-keystroke. tabChips keeps
  // one chip per open tab id across renders; a collapsed-group pill is
  // cheap enough (and rare enough to need reusing) to still build fresh.
  const liveTabIds = new Set(state.tabs.map((openTab) => openTab.id));
  for (const id of [...tabChips.keys()]) {
    if (!liveTabIds.has(id)) tabChips.delete(id);
  }

  const targetElements: HTMLElement[] = [];
  for (const [project, tabs] of byProject) {
    if (project === selected) {
      for (const tab of tabs) {
        let chip = tabChips.get(tab.id);
        if (chip === undefined) {
          chip = createTabChip(tab, state.activeTabId);
          tabChips.set(tab.id, chip);
        } else {
          chip.update(tab, state.activeTabId);
        }
        targetElements.push(chip.element);
      }
    } else {
      targetElements.push(renderCollapsedGroup(project, tabs.length));
    }
  }

  // Drop whatever is on screen but not wanted any more: a chip for a tab
  // that just closed or whose project just collapsed behind another one's
  // pill, or last render's now-stale collapsed-group pill.
  const wanted = new Set<Element>(targetElements);
  for (const child of [...strip.children]) {
    if (child !== newTabButton && !wanted.has(child)) strip.removeChild(child);
  }

  // Reorder only where the order actually changed: each slot is compared
  // against the strip's *current* live children (re-read every iteration,
  // since an insertBefore just above shifts everything after it), so an
  // element already sitting in the right place is never touched.
  targetElements.forEach((element, index) => {
    if (strip.children[index] !== element) {
      strip.insertBefore(element, strip.children[index] ?? newTabButton);
    }
  });

  // The strip is never hidden any more: with no tabs open it still shows
  // the lone "+", always reachable, the same guarantee the old
  // workspace-head placement made a different way.

  const tab = activeTab();

  // Back/forward/reload/address mean nothing for a hosted app — nobody
  // navigates a code editor or a SQL client like a webpage — and neither do
  // bookmarks: the sidebar sits inside the browser's own chrome, beside the
  // page it belongs to, so it goes away with the rest of it. Stated as "not
  // a web tab" rather than as a list of kinds, so a fourth hosted app
  // inherits the rule for free. With no tab open at all the chrome stays:
  // that is the state where the sidebar is the quickest way to open
  // something.
  const hostedApp = tab !== undefined && tab.kind !== "web";
  ($("workspace-bar") as HTMLElement).hidden = hostedApp;
  ($("workspace-loading") as HTMLElement).hidden =
    tab?.kind !== "web" || tab.loading !== true || tab.error !== undefined;
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
  ($("workspace-pip") as HTMLElement).hidden =
    !(tab?.hasPlayingVideo ?? false) || tab?.kind !== "web";

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
  // And the stage wrapping the body and DevTools, for the same reason.
  ($("workspace-stage") as HTMLElement).hidden = pageHidden;
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

  // A page that has taken full screen gets the window, not the tab slot.
  // Chromium has already put the page's own full screen element over its
  // view; what it cannot do is move that view, which the renderer positions
  // from #workspace-page. So the chrome stands down — the class hides the
  // topbar, the workspace head and the bookmarks sidebar in CSS — and the
  // slot grows to the whole window, which reportWorkspaceBounds below then
  // hands to the view like any other layout change. Without this the video
  // filled the rectangle under the tab strip and only Jarvis's own furniture
  // disappeared, which is what "it full-screens Jarvis, not the video" was.
  //
  // Read from the active tab alone: a background tab cannot hold full
  // screen (Chromium drops it when a page is hidden), and a stale flag on
  // one must never strip the chrome off the tab actually on screen.
  const pageFullscreen = tab?.pageFullscreen ?? false;
  document.body.classList.toggle("page-fullscreen", pageFullscreen);
  if (pageFullscreen) {
    strip.hidden = true;
    ($("workspace-bar") as HTMLElement).hidden = true;
    renderBookmarksVisibility(true);
  } else {
    // The strip is never hidden for any other reason now (re-review 2, item
    // 1 — it always shows at least the lone "+"), so leaving full screen is
    // the one case left that has to put it back explicitly.
    strip.hidden = false;
  }

  // Hiding the address bar above the page, or the bookmarks sidebar beside
  // it, resizes the page slot the hosted view is pinned to, and nothing else
  // re-measures it — a resize is the only reflow the window itself
  // reports.
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
