import type { WorkspaceState, WorkspaceTab } from "@jarvis/core";
import { setWorkspaceMode } from "./views.js";
import { renderDocument } from "./doc-view.js";
import type { DocEntry } from "@jarvis/core";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";

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

  // Only refetch if Docs is the mode actually on screen — switching
  // projects while browsing has nothing to do with the doc tree.
  const docs = document.getElementById("workspace-docs");
  if (docs instanceof HTMLElement && !docs.hidden) await openDocs(project);
}

export function initWorkspace(projects: string[]): void {
  const select = $("workspace-project") as HTMLSelectElement;
  select.replaceChildren();
  for (const project of projects) {
    colorFor(project);
    const option = document.createElement("option");
    option.value = project;
    option.textContent = project;
    select.append(option);
  }
  select.addEventListener("change", () => void switchToProject(select.value));

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

  $("workspace-mode-browser").addEventListener("click", () => showMode("browser"));
  $("workspace-mode-docs").addEventListener("click", () => showMode("docs"));

  // The overlay does not move with the layout, so every reflow has to be
  // pushed. A resize is the only one the renderer can observe cheaply.
  window.addEventListener("resize", reportWorkspaceBounds);

  $("workspace-doc-mode-writing").addEventListener("click", () => void switchDocMode("writing"));
  $("workspace-doc-mode-dev").addEventListener("click", () => void switchDocMode("dev"));

  // Event delegation: the body is replaced wholesale on every doc open and
  // every mode switch, so a listener on each checkbox would need rewiring
  // every time. One listener on the container survives all of that.
  $("workspace-doc-body").addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === "checkbox") void toggleTask(target);
  });

  $("workspace-doc-editor").addEventListener("input", () => setSaveStatus(""));
  $("workspace-doc-save").addEventListener("click", () => void saveDoc());

  $("workspace-doc-h1").addEventListener("click", () => applyToEditor(prefixLines("# ")));
  $("workspace-doc-h2").addEventListener("click", () => applyToEditor(prefixLines("## ")));
  $("workspace-doc-h3").addEventListener("click", () => applyToEditor(prefixLines("### ")));
  $("workspace-doc-bold").addEventListener("click", () => applyToEditor(wrapSelection("**", "**")));
  $("workspace-doc-italic").addEventListener("click", () => applyToEditor(wrapSelection("*", "*")));
  $("workspace-doc-strike").addEventListener("click", () => applyToEditor(wrapSelection("~~", "~~")));
  $("workspace-doc-code").addEventListener("click", () => applyToEditor(wrapSelection("`", "`")));
  $("workspace-doc-codeblock").addEventListener("click", () =>
    applyToEditor(wrapSelection("```\n", "\n```")),
  );
  $("workspace-doc-ul").addEventListener("click", () => applyToEditor(prefixLines("- ")));
  $("workspace-doc-ol").addEventListener("click", () => applyToEditor(prefixLines("1. ")));
  $("workspace-doc-quote").addEventListener("click", () => applyToEditor(prefixLines("> ")));
  $("workspace-doc-link").addEventListener("click", () => applyToEditor(wrapSelection("[", "](url)")));
  $("workspace-doc-hr").addEventListener("click", () => applyToEditor(insertAtCursor("\n---\n")));

  $("workspace-open-editor").addEventListener("click", () => void openEditor());
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
    showMode("browser");
    return;
  }

  const status = $("workspace-editor-status");
  status.textContent = "";
  status.classList.remove("workspace-editor-status--error");

  const result = await window.jarvis.openEditor(project);
  if (!result.ok) {
    status.textContent = result.text;
    status.classList.add("workspace-editor-status--error");
    return;
  }
  void window.jarvis.openTab(project, result.value, "editor");
  showMode("browser");
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
  else void openDocs(selectedProject());
}


let openDocPath: string | undefined;
let openDocProject: string | undefined;
/** The document's raw markdown source — Dev-mode's textarea starts here,
 *  and it is what a checkbox click and Save actually write back. Distinct
 *  from the parsed model shown in Writing mode, which cannot losslessly
 *  round-trip back to source text. */
let openDocRawText: string | undefined;
/** Character offsets of each task marker's state character in
 *  openDocRawText, in the same document order renderDocument assigns
 *  checkbox data-task-index — see findTaskMarkerOffsets in core. Same
 *  length after a checkbox flip (space<->x is a same-length swap), so it is
 *  only ever recomputed when the text itself changes for another reason
 *  (opening a doc, switching back from Dev, a successful Save). */
let openDocTaskOffsets: number[] = [];
type DocMode = "writing" | "dev";
let docMode: DocMode = "writing";

/** Lists a project's documents and shows the first one, or an error line if
 *  the project cannot be read. Called when Docs mode is entered and when the
 *  project selector changes. */
export async function openDocs(project: string): Promise<void> {
  const list = $("workspace-doc-list");
  list.replaceChildren();
  const result = await window.jarvis.listDocs(project);
  if (!result.ok) {
    showDocError(result);
    return;
  }
  for (const entry of result.value) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-doc-item";
    button.classList.toggle("workspace-doc-item--on", entry.path === openDocPath);
    // A filename comes from the filesystem; it is text.
    button.textContent = entry.path;
    button.addEventListener("click", () => void openDoc(project, entry));
    list.append(button);
  }
}

async function openDoc(project: string, entry: DocEntry): Promise<void> {
  const result = await window.jarvis.readDoc(project, entry.path);
  const body = $("workspace-doc-body");
  const title = $("workspace-doc-title");
  if (!result.ok) {
    showDocError(result);
    return;
  }
  openDocPath = entry.path;
  openDocProject = project;
  title.textContent = entry.path;
  body.replaceChildren(renderDocument(result.value));
  for (const item of document.querySelectorAll(".workspace-doc-item")) {
    item.classList.toggle("workspace-doc-item--on", item.textContent === entry.path);
  }

  // The parsed model above is enough for Writing mode; Dev mode needs the
  // actual source text, which the model cannot losslessly reconstruct.
  const raw = await window.jarvis.readDocRaw(project, entry.path);
  const editor = $("workspace-doc-editor") as HTMLTextAreaElement;
  if (raw.ok) {
    openDocRawText = raw.value;
    editor.value = raw.value;
    openDocTaskOffsets = await window.jarvis.taskOffsets(raw.value);
  } else {
    openDocRawText = undefined;
    openDocTaskOffsets = [];
    editor.value = "";
  }
  setSaveStatus("");
  setDocMode("writing");
}

/** Swaps which of the rendered body / raw-text editor is on screen. Purely
 *  visual — switchDocMode (below) is what also decides whether the other
 *  side needs to be resynced first. */
function setDocMode(mode: DocMode): void {
  docMode = mode;
  ($("workspace-doc-body") as HTMLElement).hidden = mode !== "writing";
  ($("workspace-doc-editor") as HTMLElement).hidden = mode !== "dev";
  ($("workspace-doc-toolbar") as HTMLElement).hidden = mode !== "dev";
  $("workspace-doc-mode-writing").classList.toggle("diff-mode--on", mode === "writing");
  $("workspace-doc-mode-dev").classList.toggle("diff-mode--on", mode === "dev");
}

/** Entering Writing from Dev re-parses whatever is currently in the
 *  editor — including an edit that has not been saved yet — so switching
 *  back and forth always shows the true current state, and recomputes the
 *  task offsets against that same text so a checkbox click afterwards
 *  flips the right character. Entering Dev needs none of that: the editor
 *  already holds the current text (openDoc populated it, or Writing mode
 *  never had a way to change it in the first place). */
async function switchDocMode(mode: DocMode): Promise<void> {
  if (mode === "writing" && docMode === "dev") {
    const editor = $("workspace-doc-editor") as HTMLTextAreaElement;
    const text = editor.value;
    const blocks = await window.jarvis.parseDoc(text);
    $("workspace-doc-body").replaceChildren(renderDocument(blocks));
    openDocRawText = text;
    openDocTaskOffsets = await window.jarvis.taskOffsets(text);
  }
  setDocMode(mode);
}

async function toggleTask(box: HTMLInputElement): Promise<void> {
  const indexRaw = box.dataset["taskIndex"];
  if (
    indexRaw === undefined ||
    openDocRawText === undefined ||
    openDocProject === undefined ||
    openDocPath === undefined
  ) {
    return;
  }
  const offset = openDocTaskOffsets[Number(indexRaw)];
  if (offset === undefined) return;

  const nextChar = box.checked ? "x" : " ";
  const newText = openDocRawText.slice(0, offset) + nextChar + openDocRawText.slice(offset + 1);

  const result = await window.jarvis.writeDoc(openDocProject, openDocPath, newText);
  if (!result.ok) {
    // The write failed; the checkbox must not silently claim a state the
    // file does not actually have.
    box.checked = !box.checked;
    return;
  }
  openDocRawText = newText;
  const editor = $("workspace-doc-editor") as HTMLTextAreaElement;
  if (docMode === "dev") editor.value = newText;
}

function setSaveStatus(text: string, isError = false): void {
  const status = $("workspace-doc-save-status");
  status.textContent = text;
  status.classList.toggle("workspace-doc-save-status--error", isError);
}

async function saveDoc(): Promise<void> {
  if (openDocProject === undefined || openDocPath === undefined) return;
  const editor = $("workspace-doc-editor") as HTMLTextAreaElement;
  const result = await window.jarvis.writeDoc(openDocProject, openDocPath, editor.value);
  if (!result.ok) {
    setSaveStatus(result.text, true);
    return;
  }
  openDocRawText = editor.value;
  openDocTaskOffsets = await window.jarvis.taskOffsets(editor.value);
  setSaveStatus(MESSAGES.docSaved(PRIMARY_LANGUAGE));
}

type TextSelection = { start: number; end: number };
type EditorMutation = (text: string, selection: TextSelection) => { text: string; selection: TextSelection };

/** Wraps the selection in `before`/`after` — or, with nothing selected,
 *  inserts an empty pair and leaves the cursor between them, ready to type
 *  into. Not true WYSIWYG: this is text surgery on the raw markdown, the
 *  same as every toolbar button here. */
function wrapSelection(before: string, after: string): EditorMutation {
  return (text, selection) => {
    const selected = text.slice(selection.start, selection.end);
    const replacement = before + selected + after;
    const newText = text.slice(0, selection.start) + replacement + text.slice(selection.end);
    const newSelection: TextSelection =
      selected === ""
        ? { start: selection.start + before.length, end: selection.start + before.length }
        : { start: selection.start, end: selection.start + replacement.length };
    return { text: newText, selection: newSelection };
  };
}

/** Prefixes every line the selection touches (or just the current line, if
 *  the selection is collapsed) with `marker`. */
function prefixLines(marker: string): EditorMutation {
  return (text, selection) => {
    const lineStart = text.lastIndexOf("\n", selection.start - 1) + 1;
    const nextBreak = text.indexOf("\n", selection.end);
    const lineEnd = nextBreak === -1 ? text.length : nextBreak;
    const block = text.slice(lineStart, lineEnd);
    const prefixed = block
      .split("\n")
      .map((line) => marker + line)
      .join("\n");
    const newText = text.slice(0, lineStart) + prefixed + text.slice(lineEnd);
    const delta = prefixed.length - block.length;
    return {
      text: newText,
      selection: { start: selection.start + marker.length, end: selection.end + delta },
    };
  };
}

/** Inserts `snippet` at the cursor, replacing any selection, cursor left at
 *  the end of what was inserted. */
function insertAtCursor(snippet: string): EditorMutation {
  return (text, selection) => {
    const newText = text.slice(0, selection.start) + snippet + text.slice(selection.end);
    const at = selection.start + snippet.length;
    return { text: newText, selection: { start: at, end: at } };
  };
}

function applyToEditor(mutate: EditorMutation): void {
  const editor = $("workspace-doc-editor") as HTMLTextAreaElement;
  const selection = { start: editor.selectionStart, end: editor.selectionEnd };
  const result = mutate(editor.value, selection);
  editor.value = result.text;
  editor.focus();
  editor.setSelectionRange(result.selection.start, result.selection.end);
  setSaveStatus("");
}

function showDocError(result: { text: string; language: "ar" | "en" }): void {
  const body = $("workspace-doc-body");
  body.replaceChildren();
  const line = document.createElement("p");
  line.dir = result.language === "ar" ? "rtl" : "ltr";
  line.classList.toggle("arabic", result.language === "ar");
  line.textContent = result.text;
  body.append(line);
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
  label.textContent = `${project} (${count})`;

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

  const tab = activeTab();

  // Nothing in this row means anything for a code editor — nobody
  // navigates it like a webpage.
  ($("workspace-bar") as HTMLElement).hidden = tab?.kind === "editor";

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
