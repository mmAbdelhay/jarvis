import { hostPlatform, matchChord } from "./keys.js";
import type { WorkspaceTab } from "@jarvis/core";
import type {
  ApiSettings,
  BrunoCollection,
  BrunoFolder,
  BrunoTree,
  BrunoVariable,
  Cookie,
  HistoryEntry,
} from "@jarvis/platform";
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

/**
 * Asks for a name, in the pane.
 *
 * Electron does not implement window.prompt — calling it throws
 * "prompt() is not supported" — so every create and rename in this pane
 * silently did nothing. This is the replacement: an inline row, Enter to
 * accept, Escape to cancel, resolving to null when cancelled exactly as
 * prompt() was expected to.
 */
function ask(label: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const row = $("api-ask") as HTMLElement;
    const input = $("api-ask-input") as HTMLInputElement;
    $("api-ask-label").textContent = label;
    input.value = initial;
    row.hidden = false;
    input.focus();
    input.select();

    const close = (value: string | null): void => {
      row.hidden = true;
      input.removeEventListener("keydown", onKey);
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      resolve(value);
    };
    const onOk = (): void => close(input.value.trim() === "" ? null : input.value);
    const onCancel = (): void => close(null);
    const onKey = (event: KeyboardEvent): void => {
      // The row is a text field; its keys are its own and must not reach the
      // pane's Cmd+Enter / Cmd+S shortcuts.
      event.stopPropagation();
      if (event.key === "Enter") onOk();
      else if (event.key === "Escape") onCancel();
    };

    const ok = $("api-ask-ok");
    const cancel = $("api-ask-cancel");
    input.addEventListener("keydown", onKey);
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
  });
}

/** The side panel's three drawers: what was sent before, what the jar is
 *  holding, and how requests reach the network. */
const SIDE_PANELS = ["history", "cookies", "settings"] as const;
type SidePanel = (typeof SIDE_PANELS)[number];

let history: HistoryEntry[] = [];
let cookies: Cookie[] = [];
let settings: ApiSettings = { proxyUrl: "", verifyCertificate: true, timeoutMs: 30_000 };
let sidePanel: SidePanel = "history";

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
  // The "+" menu. Each item still carries its own id and its own handler,
  // so what the menu changed is where the buttons live, not what they do.
  $("api-new").addEventListener("click", () => toggleNewMenu());
  $("api-new-request").addEventListener("click", () => {
    closeNewMenu();
    void newRequest();
  });
  $("api-new-folder").addEventListener("click", () => {
    closeNewMenu();
    void newFolder();
  });
  $("api-new-collection").addEventListener("click", () => {
    closeNewMenu();
    void newCollection();
  });
  $("api-import").addEventListener("click", () => void importPostman());
  $("api-env-edit").addEventListener("click", () => openEnvironmentEditor());
  $("api-env-add").addEventListener("click", () => addEnvironmentVariable());
  $("api-env-save").addEventListener("click", () => void saveEnvironment());
  $("api-env-close").addEventListener("click", () => closeEnvironmentEditor());
  $("api-history-toggle").addEventListener("click", () => toggleSidePanel("history"));
  $("api-cookies-toggle").addEventListener("click", () => toggleSidePanel("cookies"));
  $("api-settings-toggle").addEventListener("click", () => toggleSidePanel("settings"));

  // Send and save, the two things a request editor is for — ⌘Enter and ⌘S on
  // a Mac, Ctrl+Enter and Ctrl+S elsewhere (see keys.ts).
  //
  // Scoped to the pane, and that scoping is what makes the plain-Ctrl
  // spelling safe: Ctrl+S is XOFF to a terminal, and this listener returns
  // before looking at the key unless the API tab is the thing on screen.
  document.addEventListener("keydown", (event) => {
    if (($("workspace-api") as HTMLElement).hidden) return;
    const action = matchChord(event, hostPlatform());
    if (action === "sendRequest") {
      event.preventDefault();
      void send();
    } else if (action === "saveRequest") {
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
  setResponse({ response: undefined, assertions: [] });
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
  const params = Array.isArray(state.request?.["params"])
    ? (state.request?.["params"] as Record<string, unknown>[])
    : [];

  // Encoded, and parsed back the same way. Joining raw values means a value
  // containing & or = is read back as two params — the user's input silently
  // rewritten into something else.
  const query = new URLSearchParams();
  for (const param of params) {
    if (param["enabled"] === false || (param["type"] ?? "query") !== "query" || !param["name"])
      continue;
    query.append(String(param["name"]), String(param["value"] ?? ""));
  }
  const text = query.toString();
  if (text === "") return base;
  return `${base}${base.includes("?") ? "&" : "?"}${text}`;
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
    const existing = Array.isArray(state.request["params"])
      ? (state.request["params"] as Record<string, unknown>[])
      : [];
    state.request["params"] = existing.filter((param) => (param["type"] ?? "query") !== "query");
  } else {
    const parsed = new URLSearchParams(query);
    const others = Array.isArray(state.request["params"])
      ? (state.request["params"] as Record<string, unknown>[]).filter(
          (param) => (param["type"] ?? "query") !== "query",
        )
      : [];
    state.request["params"] = [
      ...others,
      ...[...parsed.entries()].map(([name, entry]) => ({
        name,
        value: entry,
        type: "query",
        enabled: true,
      })),
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
    name.title = folder.name;
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
    // The sidebar truncates; the whole name has to be reachable somehow.
    name.title = `${request.method} ${request.url}`;

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
  // A message from an earlier action (a failed import, say) must not sit
  // there looking like it is about this one.
  setStatus("");
  // Switching away from unsaved edits would lose them silently, which is the
  // one thing a request editor must never do.
  if (state.dirty && !window.confirm(MESSAGES.apiDiscardEdits(PRIMARY_LANGUAGE))) return;

  const result = await window.jarvis.readApiRequest(project, path);
  if (!result.ok) return;
  state.request = result.value;
  state.requestPath = path;
  state.dirty = false;
  setResponse({ response: undefined, assertions: [] });
  renderAll();
}

async function save(): Promise<void> {
  const { project, requestPath, request } = state;
  if (project === undefined || requestPath === undefined || request === undefined || !state.dirty)
    return;

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
    : {
        response: { failed: true as const, detail: result.text, timeMs: 0 },
        assertions: [],
        scripts: undefined,
        history: undefined,
        cookies: undefined,
      };

  setResponse({
    response: value.response,
    assertions: value.assertions,
    ...(value.scripts === undefined ? {} : { scripts: value.scripts }),
  });
  // A send updates history and the cookie jar, both of which have their own
  // panels; keeping the copies here in step avoids a stale panel.
  if (value.history !== undefined) history = value.history;
  if (value.cookies !== undefined) cookies = value.cookies;
  if (!($("api-side-panel") as HTMLElement).hidden) renderSidePanel();
}

async function newRequest(): Promise<void> {
  const project = state.project;
  if (project === undefined || state.collectionPath === "") return;
  const name = await ask(MESSAGES.apiNewRequest(PRIMARY_LANGUAGE), "New request");
  if (name === null) return;

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
  const name = await ask(MESSAGES.apiNewFolder(PRIMARY_LANGUAGE), "folder");
  if (name === null) return;

  const result = await window.jarvis.createApiFolder(project, folderForNew(), name);
  if (result.ok) await refreshTree();
}

async function newCollection(): Promise<void> {
  const project = state.project;
  if (project === undefined) return;
  const name = await ask(MESSAGES.apiNewCollection(PRIMARY_LANGUAGE), "api");
  if (name === null) return;

  const result = await window.jarvis.createApiCollection(project, name);
  if (result.ok) await loadCollections();
}

async function renameEntry(path: string, current: string, isFolder: boolean): Promise<void> {
  const project = state.project;
  if (project === undefined) return;
  const name = await ask(MESSAGES.apiRename(PRIMARY_LANGUAGE), current);
  if (name === null || name === current) return;

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

  // A file picker rather than a paste box: a Postman export is a file, and
  // asking someone to paste one into a prompt is asking them to lose it.
  const paths = await window.jarvis.pickFiles();
  const path = paths[0];
  if (path === undefined) return;

  const file = await window.jarvis.readJsonFile(path);
  if (!file.ok) {
    setStatus(file.text);
    return;
  }
  const result = await window.jarvis.importPostmanCollection(project, "", file.value);
  if (!result.ok) {
    setStatus(result.text);
    return;
  }
  await loadCollections();
}

/** The variables being edited in the environment panel. A copy, not the
 *  tree's own: cancelling has to leave the collection as it was. */
let editingEnvironment: { name: string; variables: BrunoVariable[] } | undefined;

function openEnvironmentEditor(): void {
  if (state.collectionPath === "") return;
  const current = state.tree?.environments.find((entry) => entry.name === state.environment);
  editingEnvironment = {
    name: current?.name ?? "local",
    variables: (current?.variables ?? []).map((variable) => ({ ...variable })),
  };
  renderEnvironmentEditor();
}

function closeEnvironmentEditor(): void {
  editingEnvironment = undefined;
  renderEnvironmentEditor();
}

function renderEnvironmentEditor(): void {
  const panel = $("api-env-panel") as HTMLElement;
  panel.hidden = editingEnvironment === undefined;
  const rows = $("api-env-vars");
  rows.replaceChildren();
  if (editingEnvironment === undefined) return;

  ($("api-env-name") as HTMLInputElement).value = editingEnvironment.name;

  editingEnvironment.variables.forEach((variable, index) => {
    const row = document.createElement("div");
    row.className = "api-pair";

    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "api-enable";
    enabled.checked = variable.enabled !== false;
    enabled.addEventListener("change", () => {
      variable.enabled = enabled.checked;
    });

    const name = document.createElement("input");
    name.type = "text";
    name.className = "mono";
    name.placeholder = "name";
    name.value = variable.name;
    name.addEventListener("change", () => {
      variable.name = name.value;
    });

    const value = document.createElement("input");
    value.type = "text";
    value.className = "mono";
    value.placeholder = "value";
    value.value = variable.value;
    value.addEventListener("change", () => {
      variable.value = value.value;
    });

    // Marking a variable secret is Bruno's own flag; it travels with the
    // file and is why a token is distinguishable from a base URL at all.
    const secretLabel = document.createElement("label");
    secretLabel.className = "api-secret";
    const secret = document.createElement("input");
    secret.type = "checkbox";
    secret.checked = variable.secret === true;
    secret.addEventListener("change", () => {
      variable.secret = secret.checked;
    });
    const secretText = document.createElement("span");
    secretText.textContent = "secret";
    secretLabel.append(secret, secretText);

    const remove = document.createElement("span");
    remove.className = "api-pair-remove";
    remove.textContent = "×";
    remove.setAttribute("role", "button");
    remove.addEventListener("click", () => {
      if (editingEnvironment === undefined) return;
      editingEnvironment.variables = editingEnvironment.variables.filter(
        (_entry, i) => i !== index,
      );
      renderEnvironmentEditor();
    });

    row.append(enabled, name, value, secretLabel, remove);
    rows.append(row);
  });
}

function addEnvironmentVariable(): void {
  if (editingEnvironment === undefined) return;
  editingEnvironment.variables.push({ name: "", value: "", enabled: true, secret: false });
  renderEnvironmentEditor();
}

async function saveEnvironment(): Promise<void> {
  const project = state.project;
  if (project === undefined || editingEnvironment === undefined) return;
  const name = ($("api-env-name") as HTMLInputElement).value.trim();
  if (name === "") return;

  const result = await window.jarvis.saveApiEnvironment(
    project,
    state.collectionPath,
    name,
    // A variable with no name is a half-typed row, not a variable.
    editingEnvironment.variables.filter((variable) => variable.name.trim() !== ""),
  );
  if (!result.ok) return;
  editingEnvironment = undefined;
  await loadTree(state.collectionPath);
  // loadTree resets to the first environment; stay on the one just saved.
  state.environment = name;
  ($("api-environment") as HTMLSelectElement).value = name;
  renderEnvironmentEditor();
}

function toggleSidePanel(which: SidePanel): void {
  const panel = $("api-side-panel") as HTMLElement;
  // Clicking the drawer that is already open closes it, which is the only
  // way to get the editor's full height back.
  if (!panel.hidden && sidePanel === which) {
    panel.hidden = true;
    return;
  }
  sidePanel = which;
  panel.hidden = false;
  void refreshSideData();
}

async function refreshSideData(): Promise<void> {
  const project = state.project;
  if (project === undefined) return;

  if (sidePanel === "history") {
    const result = await window.jarvis.apiHistory(project);
    history = result.ok ? result.value : [];
  } else if (sidePanel === "cookies") {
    const result = await window.jarvis.apiCookies(project);
    cookies = result.ok ? result.value : [];
  } else {
    const result = await window.jarvis.apiSettings(project);
    if (result.ok) settings = result.value;
  }
  renderSidePanel();
}

function renderSidePanel(): void {
  const strip = $("api-side-tabs");
  strip.replaceChildren();
  for (const name of SIDE_PANELS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "api-tab";
    button.classList.toggle("api-tab--on", name === sidePanel);
    button.dataset["panel"] = name;
    button.textContent = name;
    button.addEventListener("click", () => toggleSidePanel(name));
    strip.append(button);
  }

  const body = $("api-side-body");
  body.replaceChildren();
  if (sidePanel === "history") body.append(historyView());
  else if (sidePanel === "cookies") body.append(cookiesView());
  else body.append(settingsView());
}

function historyView(): HTMLElement {
  const list = document.createElement("div");
  list.className = "api-history";

  const clear = document.createElement("button");
  clear.type = "button";
  clear.id = "api-history-clear";
  clear.className = "settings-add";
  clear.textContent = "clear";
  clear.addEventListener("click", () => {
    const project = state.project;
    if (project === undefined) return;
    void window.jarvis.clearApiHistory(project).then(() => {
      history = [];
      renderSidePanel();
    });
  });
  list.append(clear);

  if (history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "api-empty";
    empty.textContent = MESSAGES.apiNoHistory(PRIMARY_LANGUAGE);
    list.append(empty);
    return list;
  }

  for (const entry of history) {
    const row = document.createElement("div");
    row.className = "api-history-row";

    const status = document.createElement("span");
    status.className = "api-history-status";
    status.classList.toggle("api-history-status--bad", entry.status >= 400);
    status.textContent = String(entry.status);

    const method = document.createElement("span");
    method.className = `api-method-badge api-method-badge--${entry.method.toLowerCase()}`;
    method.textContent = entry.method;

    const url = document.createElement("span");
    url.className = "mono api-history-url";
    url.textContent = entry.url;

    const timing = document.createElement("span");
    timing.className = "api-history-time";
    timing.textContent = `${entry.timeMs}ms`;

    row.append(status, method, url, timing);
    list.append(row);
  }
  return list;
}

function cookiesView(): HTMLElement {
  const list = document.createElement("div");
  list.className = "api-cookies";

  const clear = document.createElement("button");
  clear.type = "button";
  clear.id = "api-cookies-clear";
  clear.className = "settings-add";
  clear.textContent = "clear";
  clear.addEventListener("click", () => {
    const project = state.project;
    if (project === undefined) return;
    void window.jarvis.clearApiCookies(project).then((result) => {
      cookies = result.ok ? result.value : [];
      renderSidePanel();
    });
  });
  list.append(clear);

  if (cookies.length === 0) {
    const empty = document.createElement("div");
    empty.className = "api-empty";
    empty.textContent = MESSAGES.apiNoCookies(PRIMARY_LANGUAGE);
    list.append(empty);
    return list;
  }

  for (const cookie of cookies) {
    const row = document.createElement("div");
    row.className = "api-cookie-row";

    const name = document.createElement("span");
    name.className = "mono";
    name.textContent = `${cookie.name}=${cookie.value}`;

    const scope = document.createElement("span");
    scope.className = "api-cookie-scope";
    // The flags are the reason a cookie is or is not being sent, so they
    // belong on the row rather than behind anything.
    const flags = [cookie.secure ? "secure" : "", cookie.httpOnly ? "httpOnly" : ""].filter(
      (flag) => flag !== "",
    );
    scope.textContent = `${cookie.domain}${cookie.path}${flags.length > 0 ? ` · ${flags.join(" ")}` : ""}`;

    const remove = document.createElement("span");
    remove.className = "api-pair-remove";
    remove.textContent = "×";
    remove.setAttribute("role", "button");
    remove.addEventListener("click", () => {
      const project = state.project;
      if (project === undefined) return;
      void window.jarvis
        .removeApiCookie(project, cookie.name, cookie.domain, cookie.path)
        .then((result) => {
          cookies = result.ok ? result.value : cookies;
          renderSidePanel();
        });
    });

    row.append(name, scope, remove);
    list.append(row);
  }
  return list;
}

function settingsView(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "api-panel-body";

  const proxy = document.createElement("input");
  proxy.type = "text";
  proxy.id = "api-setting-proxy";
  proxy.className = "mono";
  proxy.placeholder = "http://proxy:8080";
  proxy.value = settings.proxyUrl;
  proxy.addEventListener("change", () => void saveSettings({ proxyUrl: proxy.value }));

  const timeout = document.createElement("input");
  timeout.type = "text";
  timeout.id = "api-setting-timeout";
  timeout.className = "mono";
  timeout.value = String(settings.timeoutMs);
  timeout.addEventListener("change", () => {
    const value = Number(timeout.value);
    // A half-typed number must not become a zero-millisecond timeout, which
    // would fail every request instantly.
    if (Number.isFinite(value) && value >= 0) void saveSettings({ timeoutMs: value });
  });

  const verifyLabel = document.createElement("label");
  verifyLabel.className = "api-field";
  const verify = document.createElement("input");
  verify.type = "checkbox";
  verify.id = "api-setting-verify";
  verify.checked = settings.verifyCertificate;
  verify.addEventListener("change", () => void saveSettings({ verifyCertificate: verify.checked }));
  const verifyText = document.createElement("span");
  verifyText.className = "lbl";
  verifyText.textContent = "verify certificates";
  verifyLabel.append(verify, verifyText);

  panel.append(labelledField("proxy", proxy), labelledField("timeout (ms)", timeout), verifyLabel);
  return panel;
}

function labelledField(text: string, control: HTMLElement): HTMLElement {
  const label = document.createElement("label");
  label.className = "api-field";
  const span = document.createElement("span");
  span.className = "lbl";
  span.textContent = text;
  label.append(span, control);
  return label;
}

async function saveSettings(patch: Partial<ApiSettings>): Promise<void> {
  const project = state.project;
  if (project === undefined) return;
  const result = await window.jarvis.saveApiSettings(project, { ...settings, ...patch });
  if (result.ok) settings = result.value;
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

/** The sidebar's "+" menu. Static markup rather than a built list — its
 *  three items are fixed — so this only moves the hidden flag and keeps
 *  aria-expanded honest for anything reading the button. */
function toggleNewMenu(): void {
  const menu = $("api-new-menu");
  const open = menu.hidden;
  menu.hidden = !open;
  $("api-new").setAttribute("aria-expanded", String(open));
}

function closeNewMenu(): void {
  $("api-new-menu").hidden = true;
  $("api-new").setAttribute("aria-expanded", "false");
}
