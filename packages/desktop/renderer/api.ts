import type { WorkspaceTab } from "@jarvis/core";
import type { BrunoCollection, BrunoFolder, BrunoTree, BrunoVariable } from "@jarvis/platform";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { currentTab, initEditor, renderEditor, setHttp } from "./api-editor.js";
import { renderResponse, setResponse } from "./api-response.js";

// The Workspace's API tab.
//
// Like a Terminal tab this has no hosted view — the surface is drawn here,
// over the region a hosted page would occupy — and unlike a Terminal there is
// one per project: a collection tree is a view of the filesystem, not a
// session.
//
// This module owns the state, the tree and the toolbar. The request editor
// (api-editor.ts) and the response pane (api-response.ts) own their own
// halves; all three read the one request object below, and every edit goes
// back to disk as the whole parsed .bru, so scripts, docs and anything else
// a request carries survive a save untouched.

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

type State = {
  project: string | undefined;
  collections: BrunoCollection[];
  collectionPath: string;
  tree: BrunoTree | undefined;
  request: Record<string, unknown> | undefined;
  requestPath: string | undefined;
  dirty: boolean;
  sending: boolean;
  environment: string;
};

const state: State = {
  project: undefined,
  collections: [],
  collectionPath: "",
  tree: undefined,
  request: undefined,
  requestPath: undefined,
  dirty: false,
  sending: false,
  environment: "",
};

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

export function initApi(): void {
  initEditor({
    request: () => state.request,
    changed: () => markDirty(),
  });

  const collection = $("api-collection") as HTMLSelectElement;
  collection.addEventListener("change", () => void loadTree(collection.value));

  const environment = $("api-environment") as HTMLSelectElement;
  environment.addEventListener("change", () => {
    state.environment = environment.value;
  });

  const method = $("api-method") as HTMLSelectElement;
  for (const name of METHODS) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name.toUpperCase();
    method.append(option);
  }
  method.addEventListener("change", () => {
    setHttp("method", method.value);
    renderTree();
  });

  const url = $("api-url") as HTMLInputElement;
  url.addEventListener("change", () => applyUrl(url.value));

  $("api-send").addEventListener("click", () => void send());
  $("api-save").addEventListener("click", () => void save());
  $("api-curl").addEventListener("click", () => void copyCurl());
  $("api-new-request").addEventListener("click", () => void newRequest());
  $("api-new-folder").addEventListener("click", () => void newFolder());
  $("api-new-collection").addEventListener("click", () => void newCollection());
  $("api-import").addEventListener("click", () => void importPostman());
  $("api-env-edit").addEventListener("click", () => void editEnvironment());

  // Cmd+Enter sends and Cmd+S saves, the two things a request editor is for.
  // Scoped to the pane: these must not fire while the user is in a terminal
  // or the Changes view.
  document.addEventListener("keydown", (event) => {
    if (($("workspace-api") as HTMLElement).hidden) return;
    if (!event.metaKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void send();
    } else if (event.key === "s") {
      event.preventDefault();
      void save();
    }
  });
}

export function renderApi(
  tabs: WorkspaceTab[],
  activeTabId: string | undefined,
  selectedProject: string,
): void {
  const active = tabs.find((tab) => tab.id === activeTabId);
  const showing =
    active?.kind === "api" && active.project === selectedProject ? active.project : undefined;

  ($("workspace-api") as HTMLElement).hidden = showing === undefined;
  if (showing === undefined || showing === state.project) return;

  state.project = showing;
  void loadCollections();
}

async function loadCollections(): Promise<void> {
  const project = state.project;
  if (project === undefined) return;

  const result = await window.jarvis.listApiCollections(project);
  state.collections = result.ok ? result.value : [];
  clearRequest();

  const select = $("api-collection") as HTMLSelectElement;
  select.replaceChildren();
  for (const collection of state.collections) {
    const option = document.createElement("option");
    option.value = collection.path;
    option.textContent = collection.name;
    select.append(option);
  }

  const first = state.collections[0];
  if (first === undefined) {
    state.tree = undefined;
    state.collectionPath = "";
    renderAll();
    return;
  }
  select.value = first.path;
  await loadTree(first.path);
}

async function loadTree(collectionPath: string): Promise<void> {
  const project = state.project;
  if (project === undefined) return;

  const result = await window.jarvis.readApiTree(project, collectionPath);
  state.tree = result.ok ? result.value : undefined;
  state.collectionPath = collectionPath;
  clearRequest();
  state.environment = state.tree?.environments[0]?.name ?? "";
  renderEnvironments();
  renderAll();
}

/** Re-reads the tree without losing the request open in the editor — after a
 *  save, where the name or method in the tree may have changed. */
async function refreshTree(): Promise<void> {
  const project = state.project;
  if (project === undefined || state.collectionPath === "") return;
  const result = await window.jarvis.readApiTree(project, state.collectionPath);
  if (result.ok) state.tree = result.value;
  renderTree();
}

function clearRequest(): void {
  state.request = undefined;
  state.requestPath = undefined;
  state.dirty = false;
  setResponse({ response: undefined, assertions: [], hasScript: false });
}

function renderEnvironments(): void {
  const select = $("api-environment") as HTMLSelectElement;
  select.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "(no environment)";
  select.append(none);
  for (const environment of state.tree?.environments ?? []) {
    const option = document.createElement("option");
    option.value = environment.name;
    option.textContent = environment.name;
    select.append(option);
  }
  select.value = state.environment;
}

function renderAll(): void {
  renderTree();
  renderToolbar();
  renderEditor();
  renderResponse();
}

function renderToolbar(): void {
  const has = state.request !== undefined;
  const http = (state.request?.["http"] ?? {}) as Record<string, unknown>;

  ($("api-method") as HTMLSelectElement).disabled = !has;
  ($("api-method") as HTMLSelectElement).value = String(http["method"] ?? "get");
  const url = $("api-url") as HTMLInputElement;
  url.disabled = !has;
  url.value = displayUrl();
  ($("api-send") as HTMLButtonElement).disabled = !has || state.sending;
  ($("api-save") as HTMLButtonElement).disabled = !has || !state.dirty;
  ($("api-curl") as HTMLButtonElement).disabled = !has;
  ($("api-dirty") as HTMLElement).hidden = !state.dirty;
}

/** The URL as the user should see it: the stored URL plus its enabled query
 *  params, so the address bar reads like an address rather than half of one.
 *  Bruno keeps params in their own block; this is where the two are joined. */
function displayUrl(): string {
  const http = (state.request?.["http"] ?? {}) as Record<string, unknown>;
  const base = String(http["url"] ?? "");
  const params = Array.isArray(state.request?.["params"]) ? (state.request?.["params"] as Record<string, unknown>[]) : [];
  const query = params
    .filter((param) => param["enabled"] !== false && (param["type"] ?? "query") === "query" && param["name"])
    .map((param) => `${String(param["name"])}=${String(param["value"] ?? "")}`);
  if (query.length === 0) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${query.join("&")}`;
}

/** Typing a URL with a query string in it splits the query back out into the
 *  params table, which is where Bruno keeps it — so pasting a URL from a log
 *  or a browser does the thing the user meant. */
function applyUrl(value: string): void {
  if (state.request === undefined) return;
  const [base = "", query = ""] = value.split("?");
  setHttp("url", base);

  if (query === "") {
    // Only clear params the URL owned; a param the user typed by hand in the
    // table has no query string to have come from.
    const existing = Array.isArray(state.request["params"]) ? (state.request["params"] as Record<string, unknown>[]) : [];
    state.request["params"] = existing.filter((param) => (param["type"] ?? "query") !== "query");
  } else {
    const parsed = new URLSearchParams(query);
    const others = Array.isArray(state.request["params"])
      ? (state.request["params"] as Record<string, unknown>[]).filter((param) => (param["type"] ?? "query") !== "query")
      : [];
    state.request["params"] = [
      ...others,
      ...[...parsed.entries()].map(([name, entry]) => ({ name, value: entry, type: "query", enabled: true })),
    ];
  }
  markDirty();
  renderToolbar();
  renderEditor();
}

function markDirty(): void {
  state.dirty = true;
  renderToolbar();
}

function renderTree(): void {
  const container = $("api-tree");
  container.replaceChildren();

  if (state.collections.length === 0) {
    const empty = document.createElement("div");
    empty.className = "api-empty";
    empty.textContent = MESSAGES.apiNoCollections(PRIMARY_LANGUAGE);
    container.append(empty);
    return;
  }
  if (state.tree !== undefined) container.append(...folderNodes(state.tree.root, true));
}

function folderNodes(folder: BrunoFolder, isRoot = false): HTMLElement[] {
  const nodes: HTMLElement[] = [];

  if (!isRoot) {
    const row = document.createElement("div");
    row.className = "api-folder";
    const name = document.createElement("span");
    // A folder name comes from the filesystem: text, like everything else
    // this file builds.
    name.textContent = folder.name;
    row.append(name, entryActions(folder.path, folder.name, true));
    nodes.push(row);
  }

  for (const request of folder.requests) {
    const row = document.createElement("div");
    row.className = "api-request";
    row.classList.toggle("api-request--on", request.path === state.requestPath);
    row.addEventListener("click", () => void openRequest(request.path));

    const method = document.createElement("span");
    method.className = `api-method-badge api-method-badge--${request.method.toLowerCase()}`;
    method.textContent = request.method;
    const name = document.createElement("span");
    name.className = "api-request-name";
    name.textContent = request.name;

    row.append(method, name, entryActions(request.path, request.name, false));
    nodes.push(row);
  }

  for (const child of folder.folders) {
    const group = document.createElement("div");
    group.className = "api-group";
    group.append(...folderNodes(child));
    nodes.push(group);
  }

  return nodes;
}

function entryActions(path: string, name: string, isFolder: boolean): HTMLElement {
  const actions = document.createElement("span");
  actions.className = "api-entry-actions";

  const rename = document.createElement("span");
  rename.className = "api-entry-action";
  rename.textContent = "✎";
  rename.title = MESSAGES.apiRename(PRIMARY_LANGUAGE);
  rename.setAttribute("role", "button");
  rename.addEventListener("click", (event) => {
    event.stopPropagation();
    void renameEntry(path, name, isFolder);
  });

  const remove = document.createElement("span");
  remove.className = "api-entry-action api-entry-action--del";
  remove.textContent = "×";
  remove.title = MESSAGES.apiDelete(PRIMARY_LANGUAGE);
  remove.setAttribute("role", "button");
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    void deleteEntry(path, name);
  });

  actions.append(rename, remove);
  return actions;
}

async function openRequest(path: string): Promise<void> {
  const project = state.project;
  if (project === undefined) return;
  // Switching away from unsaved edits would lose them silently, which is the
  // one thing a request editor must never do.
  if (state.dirty && !window.confirm(MESSAGES.apiDiscardEdits(PRIMARY_LANGUAGE))) return;

  const result = await window.jarvis.readApiRequest(project, path);
  if (!result.ok) return;
  state.request = result.value;
  state.requestPath = path;
  state.dirty = false;
  setResponse({ response: undefined, assertions: [], hasScript: false });
  renderAll();
}

async function save(): Promise<void> {
  const { project, requestPath, request } = state;
  if (project === undefined || requestPath === undefined || request === undefined || !state.dirty) return;

  const result = await window.jarvis.saveApiRequest(project, requestPath, request);
  if (!result.ok) return;
  state.dirty = false;
  renderToolbar();
  await refreshTree();
}

/** The variables a request is sent with: the selected environment's. Secrets
 *  are included because they are needed to make the call — what Jarvis never
 *  does is write one into a request file. */
function variables(): Record<string, string> {
  const environment = state.tree?.environments.find((entry) => entry.name === state.environment);
  const resolved: Record<string, string> = {};
  for (const variable of environment?.variables ?? []) {
    if (variable.enabled === false) continue;
    resolved[variable.name] = variable.value;
  }
  return resolved;
}

async function send(): Promise<void> {
  const { project, request } = state;
  if (project === undefined || request === undefined || state.sending) return;

  state.sending = true;
  renderToolbar();
  const result = await window.jarvis.sendApiRequest(project, request, variables());
  state.sending = false;
  renderToolbar();

  // Assertions are evaluated in main, where the response already is: asking
  // for them separately would mean shipping the body back across IPC to be
  // checked against.
  const value = result.ok
    ? result.value
    : { response: { failed: true as const, detail: result.text, timeMs: 0 }, assertions: [] };

  setResponse({
    response: value.response,
    assertions: value.assertions,
    hasScript: request["script"] !== undefined || request["tests"] !== undefined,
  });
}

async function newRequest(): Promise<void> {
  const project = state.project;
  if (project === undefined || state.collectionPath === "") return;
  const name = window.prompt(MESSAGES.apiNewRequest(PRIMARY_LANGUAGE), "New request");
  if (name === null || name.trim() === "") return;

  const seq = (state.tree?.root.requests.length ?? 0) + 1;
  const result = await window.jarvis.createApiRequest(project, folderForNew(), name, seq);
  if (!result.ok) return;
  await refreshTree();
  await openRequest(result.value);
}

/** A new request lands beside the one that is open, or at the collection root
 *  when nothing is. */
function folderForNew(): string {
  const path = state.requestPath;
  if (path === undefined) return state.collectionPath;
  return path.slice(0, path.lastIndexOf("/"));
}

async function newFolder(): Promise<void> {
  const project = state.project;
  if (project === undefined || state.collectionPath === "") return;
  const name = window.prompt(MESSAGES.apiNewFolder(PRIMARY_LANGUAGE), "folder");
  if (name === null || name.trim() === "") return;

  const result = await window.jarvis.createApiFolder(project, folderForNew(), name);
  if (result.ok) await refreshTree();
}

async function newCollection(): Promise<void> {
  const project = state.project;
  if (project === undefined) return;
  const name = window.prompt(MESSAGES.apiNewCollection(PRIMARY_LANGUAGE), "api");
  if (name === null || name.trim() === "") return;

  const result = await window.jarvis.createApiCollection(project, name);
  if (result.ok) await loadCollections();
}

async function renameEntry(path: string, current: string, isFolder: boolean): Promise<void> {
  const project = state.project;
  if (project === undefined) return;
  const name = window.prompt(MESSAGES.apiRename(PRIMARY_LANGUAGE), current);
  if (name === null || name.trim() === "" || name === current) return;

  const result = await window.jarvis.renameApiEntry(project, path, name, isFolder);
  if (!result.ok) return;
  // The open request may be the one that just moved.
  if (state.requestPath === path) state.requestPath = result.value;
  await refreshTree();
}

async function deleteEntry(path: string, name: string): Promise<void> {
  const project = state.project;
  if (project === undefined) return;
  if (!window.confirm(MESSAGES.apiConfirmDelete(name, PRIMARY_LANGUAGE))) return;

  const result = await window.jarvis.deleteApiEntry(project, path);
  if (!result.ok) return;
  if (state.requestPath === path) clearRequest();
  await refreshTree();
  renderAll();
}

async function importPostman(): Promise<void> {
  const project = state.project;
  if (project === undefined) return;
  const text = window.prompt(MESSAGES.apiImport(PRIMARY_LANGUAGE), "");
  if (text === null || text.trim() === "") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    setStatus("Not valid JSON");
    return;
  }
  const result = await window.jarvis.importPostmanCollection(project, "", parsed);
  if (!result.ok) {
    setStatus(result.text);
    return;
  }
  await loadCollections();
}

/** The environment editor is a prompt over the variables as `name=value`
 *  lines: small, and it keeps the whole feature to one round trip. A richer
 *  editor is a later change, not a missing one — nothing here is unreachable
 *  without it. */
async function editEnvironment(): Promise<void> {
  const project = state.project;
  if (project === undefined || state.collectionPath === "") return;

  const current = state.tree?.environments.find((entry) => entry.name === state.environment);
  const name = current?.name ?? window.prompt(MESSAGES.apiNewCollection(PRIMARY_LANGUAGE), "local");
  if (name === null || name.trim() === "") return;

  const asText = (current?.variables ?? [])
    .map((variable) => `${variable.name}=${variable.value}`)
    .join("\n");
  const edited = window.prompt(`${name}`, asText);
  if (edited === null) return;

  const variables: BrunoVariable[] = edited
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const at = line.indexOf("=");
      const key = at === -1 ? line : line.slice(0, at);
      const value = at === -1 ? "" : line.slice(at + 1);
      const existing = current?.variables.find((variable) => variable.name === key);
      return { name: key, value, enabled: true, secret: existing?.secret ?? false };
    });

  const result = await window.jarvis.saveApiEnvironment(project, state.collectionPath, name, variables);
  if (result.ok) await loadTree(state.collectionPath);
}

async function copyCurl(): Promise<void> {
  const { project, request } = state;
  if (project === undefined || request === undefined) return;
  const result = await window.jarvis.apiCurl(project, request, variables());
  if (!result.ok) return;
  await navigator.clipboard?.writeText(result.value);
  setStatus(MESSAGES.apiCopied(PRIMARY_LANGUAGE));
}

function setStatus(text: string): void {
  $("api-status").textContent = text;
}

export function activeEditorTab(): string {
  return currentTab();
}
