import type { WorkspaceTab } from "@jarvis/core";
import type { ApiFailure, ApiResponse, BrunoCollection, BrunoFolder, BrunoTree } from "@jarvis/platform";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";

// The Workspace's API tab: a request builder and response viewer over the
// project's own Bruno collections.
//
// Like a Terminal tab this has no hosted view — the surface is drawn here,
// in the renderer's DOM, over the region a hosted page would occupy. Unlike
// a Terminal there is one tab per project: a collection tree is a view of
// the filesystem, not a session.
//
// Everything a .bru file contains is preserved. Jarvis edits a handful of
// fields and writes the whole parsed object back, so scripts, assertions and
// docs a request carries survive a save untouched — see bruno.ts.

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

type Pair = { name?: string; value?: string; enabled?: boolean; type?: string };

/** Everything the pane is showing. One object so a re-render is a pure
 *  function of it, rather than of a dozen scattered flags. */
type State = {
  project: string | undefined;
  collections: BrunoCollection[];
  tree: BrunoTree | undefined;
  /** The request being edited, as its whole parsed .bru object. */
  request: Record<string, unknown> | undefined;
  requestPath: string | undefined;
  dirty: boolean;
  sending: boolean;
  response: ApiResponse | ApiFailure | undefined;
  environment: string;
};

const state: State = {
  project: undefined,
  collections: [],
  tree: undefined,
  request: undefined,
  requestPath: undefined,
  dirty: false,
  sending: false,
  response: undefined,
  environment: "",
};

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const BODY_MODES = ["none", "json", "text", "xml", "formUrlEncoded"];

export function initApi(): void {
  ($("api-collection") as HTMLSelectElement).addEventListener("change", () => {
    void loadTree(($("api-collection") as HTMLSelectElement).value);
  });
  ($("api-environment") as HTMLSelectElement).addEventListener("change", () => {
    state.environment = ($("api-environment") as HTMLSelectElement).value;
  });
  ($("api-method") as HTMLSelectElement).addEventListener("change", () => {
    editHttp("method", ($("api-method") as HTMLSelectElement).value);
  });
  ($("api-url") as HTMLInputElement).addEventListener("change", () => {
    editHttp("url", ($("api-url") as HTMLInputElement).value);
  });
  ($("api-body-mode") as HTMLSelectElement).addEventListener("change", () => {
    editHttp("body", ($("api-body-mode") as HTMLSelectElement).value);
    renderEditor();
  });
  ($("api-body") as HTMLTextAreaElement).addEventListener("change", () => {
    editBody(($("api-body") as HTMLTextAreaElement).value);
  });
  $("api-send").addEventListener("click", () => void send());
  $("api-save").addEventListener("click", () => void save());
}

/** Shows the pane for the active api tab, and reloads when it belongs to a
 *  different project than the one currently on screen. Driven entirely by
 *  workspace state, like the terminal panes. */
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
  state.tree = undefined;
  state.request = undefined;
  state.requestPath = undefined;
  state.response = undefined;

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
    renderTree();
    renderEditor();
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
  state.request = undefined;
  state.requestPath = undefined;
  state.response = undefined;
  state.environment = state.tree?.environments[0]?.name ?? "";

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

  renderTree();
  renderEditor();
  renderResponse();
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
    const label = document.createElement("div");
    label.className = "api-folder";
    // A folder name comes from the filesystem: text, like everything else
    // this file builds.
    label.textContent = folder.name;
    nodes.push(label);
  }

  for (const request of folder.requests) {
    const row = document.createElement("div");
    row.className = "api-request";
    row.classList.toggle("api-request--on", request.path === state.requestPath);
    row.addEventListener("click", () => void openRequest(request.path));

    const method = document.createElement("span");
    method.className = `api-method api-method--${request.method.toLowerCase()}`;
    method.textContent = request.method;
    const name = document.createElement("span");
    name.className = "api-request-name";
    name.textContent = request.name;

    row.append(method, name);
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

async function openRequest(path: string): Promise<void> {
  const project = state.project;
  if (project === undefined) return;
  // Switching away from unsaved edits would lose them silently, which is the
  // one thing a request editor must never do.
  if (state.dirty && !confirmDiscard()) return;

  const result = await window.jarvis.readApiRequest(project, path);
  if (!result.ok) return;
  state.request = result.value;
  state.requestPath = path;
  state.dirty = false;
  state.response = undefined;
  renderTree();
  renderEditor();
  renderResponse();
}

/** Overridable in tests; a bare confirm() is the right control here — the
 *  choice is binary and immediate. */
function confirmDiscard(): boolean {
  return window.confirm(MESSAGES.apiDiscardEdits(PRIMARY_LANGUAGE));
}

function http(): Record<string, unknown> {
  const existing = state.request?.["http"];
  return typeof existing === "object" && existing !== null
    ? (existing as Record<string, unknown>)
    : {};
}

function editHttp(field: string, value: string): void {
  if (state.request === undefined) return;
  state.request["http"] = { ...http(), [field]: value };
  markDirty();
}

function editBody(value: string): void {
  if (state.request === undefined) return;
  const mode = String(http()["body"] ?? "none");
  if (mode === "none") return;
  const body = (state.request["body"] ?? {}) as Record<string, unknown>;
  state.request["body"] = { ...body, [mode]: value };
  markDirty();
}

function editPair(kind: "headers" | "params", index: number, field: "name" | "value", value: string): void {
  if (state.request === undefined) return;
  const list = [...((state.request[kind] as Pair[] | undefined) ?? [])];
  const pair = list[index];
  if (pair === undefined) return;
  list[index] = { ...pair, [field]: value };
  state.request[kind] = list;
  markDirty();
}

function addPair(kind: "headers" | "params"): void {
  if (state.request === undefined) return;
  const list = [...((state.request[kind] as Pair[] | undefined) ?? [])];
  list.push(kind === "params" ? { name: "", value: "", type: "query", enabled: true } : { name: "", value: "", enabled: true });
  state.request[kind] = list;
  markDirty();
  renderEditor();
}

function removePair(kind: "headers" | "params", index: number): void {
  if (state.request === undefined) return;
  const list = ((state.request[kind] as Pair[] | undefined) ?? []).filter((_pair, i) => i !== index);
  state.request[kind] = list;
  markDirty();
  renderEditor();
}

function markDirty(): void {
  state.dirty = true;
  ($("api-save") as HTMLButtonElement).disabled = false;
}

function renderEditor(): void {
  const has = state.request !== undefined;
  ($("api-method") as HTMLSelectElement).disabled = !has;
  ($("api-url") as HTMLInputElement).disabled = !has;
  ($("api-send") as HTMLButtonElement).disabled = !has || state.sending;
  ($("api-save") as HTMLButtonElement).disabled = !has || !state.dirty;

  const method = $("api-method") as HTMLSelectElement;
  if (method.options.length === 0) {
    for (const name of METHODS) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name.toUpperCase();
      method.append(option);
    }
  }
  const modes = $("api-body-mode") as HTMLSelectElement;
  if (modes.options.length === 0) {
    for (const name of BODY_MODES) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      modes.append(option);
    }
  }

  method.value = String(http()["method"] ?? "get");
  ($("api-url") as HTMLInputElement).value = String(http()["url"] ?? "");
  const bodyMode = String(http()["body"] ?? "none");
  modes.value = bodyMode;

  const body = $("api-body") as HTMLTextAreaElement;
  body.hidden = bodyMode === "none" || bodyMode === "formUrlEncoded";
  const bodies = (state.request?.["body"] ?? {}) as Record<string, unknown>;
  body.value = bodyMode === "none" ? "" : String(bodies[bodyMode] ?? "");

  renderPairs("params");
  renderPairs("headers");
}

function renderPairs(kind: "headers" | "params"): void {
  const container = $(`api-${kind}`);
  container.replaceChildren();
  const list = (state.request?.[kind] as Pair[] | undefined) ?? [];

  list.forEach((pair, index) => {
    const row = document.createElement("div");
    row.className = "api-pair";

    const name = document.createElement("input");
    name.type = "text";
    name.className = "mono";
    name.dataset["field"] = "name";
    name.value = pair.name ?? "";
    name.addEventListener("change", () => editPair(kind, index, "name", name.value));

    const value = document.createElement("input");
    value.type = "text";
    value.className = "mono";
    value.dataset["field"] = "value";
    value.value = pair.value ?? "";
    value.addEventListener("change", () => editPair(kind, index, "value", value.value));

    const remove = document.createElement("span");
    remove.className = "api-pair-remove";
    remove.textContent = "×";
    remove.setAttribute("role", "button");
    remove.addEventListener("click", () => removePair(kind, index));

    row.append(name, value, remove);
    container.append(row);
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "settings-add";
  add.textContent = kind === "params" ? "+ param" : "+ header";
  add.addEventListener("click", () => addPair(kind));
  container.append(add);
}

async function save(): Promise<void> {
  const { project, requestPath, request } = state;
  if (project === undefined || requestPath === undefined || request === undefined) return;

  const result = await window.jarvis.saveApiRequest(project, requestPath, request);
  if (!result.ok) return;
  state.dirty = false;
  ($("api-save") as HTMLButtonElement).disabled = true;
  // A saved request may have changed method, name or seq, all of which the
  // tree shows.
  const collection = ($("api-collection") as HTMLSelectElement).value;
  if (collection !== "") await loadTreePreservingSelection(collection);
}

async function loadTreePreservingSelection(collectionPath: string): Promise<void> {
  const keptPath = state.requestPath;
  const keptRequest = state.request;
  await loadTree(collectionPath);
  state.requestPath = keptPath;
  state.request = keptRequest;
  renderTree();
  renderEditor();
}

/** The variables a request is sent with: the selected environment's, in
 *  file order. Secrets are included here because they are needed to make the
 *  call — they are only never written back to disk. */
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
  ($("api-send") as HTMLButtonElement).disabled = true;
  const result = await window.jarvis.sendApiRequest(project, request, variables());
  state.sending = false;
  ($("api-send") as HTMLButtonElement).disabled = false;

  state.response = result.ok ? result.value : { failed: true, detail: result.text, timeMs: 0 };
  renderResponse();
}

function renderResponse(): void {
  const container = $("api-response");
  container.replaceChildren();
  const response = state.response;
  if (response === undefined) return;

  const head = document.createElement("div");
  head.className = "api-response-head";

  if ("failed" in response) {
    head.classList.add("api-response-head--failed");
    head.textContent = response.detail;
    container.append(head);
    return;
  }

  head.classList.toggle("api-response-head--bad", response.status >= 400);
  // HTTP/2 has no status text at all, so joining unconditionally leaves a
  // double space — "200  · 12ms" — which reads as a missing word.
  const status = [String(response.status), response.statusText].filter((part) => part !== "").join(" ");
  head.textContent = `${status} · ${response.timeMs}ms · ${response.bytes} B`;
  container.append(head);

  if (response.unresolved.length > 0) {
    const note = document.createElement("div");
    note.className = "api-note";
    note.textContent = MESSAGES.apiUnresolved(response.unresolved.join(", "), PRIMARY_LANGUAGE);
    container.append(note);
  }

  // Scripts and assertions are preserved on save but never run here, so a
  // request that carries one behaves differently than it would under
  // `bru run`. Saying so beats letting someone trust a green result.
  if (state.request?.["script"] !== undefined || state.request?.["tests"] !== undefined) {
    const note = document.createElement("div");
    note.className = "api-note";
    note.textContent = MESSAGES.apiScriptsNotRun(PRIMARY_LANGUAGE);
    container.append(note);
  }

  const body = document.createElement("pre");
  body.className = "api-response-body mono";
  body.textContent = prettify(response.body);
  container.append(body);
}

/** Pretty-prints JSON, and leaves everything else exactly as it came. */
function prettify(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
