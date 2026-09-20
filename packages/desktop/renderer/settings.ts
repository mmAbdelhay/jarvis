import { openSetup } from "./setup.js";
import type { AgentConfig, ProviderVendor, RoutingRule } from "@jarvis/core";
import type {
  ChatDriver,
  ChatEntry,
  ContainerFacts,
  DbGateConnection,
  DbGateEngine,
  DockerEntry,
  EditorRoot,
} from "@jarvis/platform";
import type { JarvisConfig } from "../src/config.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { PERSONAL_PROJECT } from "../src/personal.js";
import type { BindChoice, RemoteDeviceStatus, RemoteStatus } from "@jarvis/remote";
import { isMeshAddress, primaryBindChoices } from "./remote-bind.js";
import { latestRemoteStatus, onRemoteStatusChange, withNameInBdi } from "./remote-status.js";
import { encodeQr, qrToCanvas } from "./vendor/qr.js";
import { syncPrayerSettings } from "./prayer.js";

// Settings' own route. One in-memory draft, edited in place and re-rendered
// wholesale on every mutation — every field commits on "change" (blur or
// Enter), never on "input", so a full re-render never steals focus out from
// under a keystroke in progress. No innerHTML anywhere in this file, same
// discipline as every other renderer module: config values are locally
// authored, but there is no reason to be the one file that breaks the rule.

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

let draft: JarvisConfig | undefined;
let savedBaseline: JarvisConfig | undefined;

/** The bridge's own status, distinct from `draft.remote` (the config the
 *  user is editing): this is what it is actually doing right now — closed
 *  by default until either latestRemoteStatus() or a real remoteStatus()
 *  call supplies one. */
const DEFAULT_REMOTE_STATUS: RemoteStatus = {
  enabled: false,
  listening: undefined,
  pairing: { kind: "closed" },
  devices: [],
  problem: undefined,
  // M11 Task 2 minimal compile fix (Task 4 owns the real desktop wiring).
  sidecarProxy: "off",
};
let remoteStatusCache: RemoteStatus | undefined;

// The pairing QR: rendered at a small internal resolution and scaled up to
// its fixed 176px CSS box (styles.css, image-rendering: pixelated) rather
// than one canvas pixel per module — a version-10 code is 65 modules wide
// including the quiet zone, and 3px/module keeps the browser's upscaling
// crisp without a huge backing bitmap.
const QR_MODULE_PX = 3;
const QR_QUIET_ZONE_MODULES = 4;

/** The last 4 hex characters of the pairing link's `fp` (fingerprint)
 *  query parameter — the same value, computed the same way
 *  (`fingerprint.slice(-4)`), as the phone's own `fingerprintTail`
 *  (apps/mobile/src/lib/pair-flow.ts). Parsed from the link text with
 *  the browser's own `URLSearchParams` rather than `@jarvis/wire`'s
 *  `parsePairingUri`: the renderer may only ever `import type` from a
 *  workspace package (no-value-imports.test.ts) since it runs in a
 *  browser context that lacks the Node built-ins those packages use, so
 *  a value import of the real parser is not an option here — and the
 *  fingerprint is already in the same `status.pairing.uri` the link text
 *  and the QR both come from, so no new field or channel is needed
 *  either. Returns undefined for a URI that doesn't carry a well-formed
 *  `fp` param — the caller then shows nothing rather than a stray tail. */
function fingerprintTailFromUri(uri: string): string | undefined {
  const queryIndex = uri.indexOf("?");
  if (queryIndex === -1) return undefined;
  const fingerprint = new URLSearchParams(uri.slice(queryIndex + 1)).get("fp");
  if (fingerprint === null || fingerprint.length < 4) return undefined;
  return fingerprint.slice(-4);
}

/** Called once, at app start (app.ts), same as initWorkspace — wires the
 *  static single-field controls and the three "+ Add" buttons. openSettings
 *  (below) only ever fetches and renders; it is called every time the
 *  Settings nav button is clicked, and must never re-attach listeners to
 *  elements that already have them. */
/** The section nav (board 5): plain anchors, so a click still jumps the
 *  scroller with no JS at all if this never runs — this only adds the
 *  active-link highlight `:target` can't give the *link* (it matches the
 *  section, never the anchor that pointed at it). */
function wireSettingsNav(): void {
  const links = document.querySelectorAll<HTMLAnchorElement>(".settings-nav-link");
  for (const link of links) {
    link.addEventListener("click", () => {
      for (const other of links) other.classList.toggle("settings-nav-link--on", other === link);
    });
  }
}

export function initSettings(): void {
  wireStaticFields();
  wireSettingsNav();
  // Reopens the prerequisites screen. It shows itself on a first run and
  // when something required is missing; this is how a user reaches it the
  // rest of the time — after installing a tool, or to see what a tab wants.
  // Moved here from openSettings (M3 carry-over): openSettings runs on every
  // nav click, and a listener re-attached there would fire once per past
  // visit to the route.
  $("settings-tools").addEventListener("click", () => {
    void openSetup(window.jarvis);
  });
  // Attached once, for the app's lifetime — not per openSettings — so it
  // never stacks. It re-renders only the pair area and the device list:
  // a push can arrive while some other Settings field is mid-edit, and a
  // full renderSettings() would blow that away.
  onRemoteStatusChange((status) => {
    remoteStatusCache = status;
    renderRemotePairArea();
    renderPairedDevices();
  });
}

export async function openSettings(): Promise<void> {
  clearSaveStatus();
  otherBindPicked = false;
  // Whatever remote-status.ts already knows, shown immediately — the pair
  // area and device list do not wait on a fresh round trip to draw.
  remoteStatusCache = latestRemoteStatus();
  draft = await window.jarvis.getSettings();
  savedBaseline = structuredClone(draft);
  renderSettings();

  void loadVoices();
  void loadBindChoices();
  // Then refreshed: remoteStatus() is a pull, distinct from the onRemoteStatus
  // push above — a value paired or revoked from a phone while this window
  // was elsewhere is otherwise not visible until the next push.
  try {
    remoteStatusCache = await window.jarvis.remoteStatus();
  } catch {
    // The cached value (from latestRemoteStatus(), or default-closed) stands.
  }
  renderRemotePairArea();
  renderPairedDevices();
}

function renderSettings(): void {
  if (draft === undefined) return;
  syncPrayerSettings(draft.prayer);
  renderAgents();
  renderRouting();
  renderProjects();
  renderDatabases();
  renderEditors();
  renderDocker();
  renderChat();
  renderBrain();
  renderVoice();
  renderBrowser();
  renderWhisper();
  renderRemote();
}

function renderBrowser(): void {
  if (draft === undefined) return;
  ($("settings-allow-popups") as HTMLInputElement).checked = draft.browser.allowPopups;
  ($("settings-browser-homepage") as HTMLInputElement).value = draft.browser.homePage ?? "";
}

function clearSaveStatus(): void {
  const status = $("settings-status");
  status.textContent = "";
  status.classList.remove("settings-status--error");
  ($("settings-restart") as HTMLElement).hidden = true;
}

/** One labelled text field, committing on change (blur/Enter), not on
 *  every keystroke. */
function fieldInput(
  labelText: string,
  value: string,
  onChange: (value: string) => void,
): HTMLElement {
  const label = document.createElement("label");
  // The label carries the field name too, so the stylesheet can give a path
  // more width than a port without knowing anything about either.
  label.dataset["field"] = labelText;
  const caption = document.createElement("span");
  caption.textContent = labelText;
  label.append(caption);
  const input = document.createElement("input");
  input.type = "text";
  // A connection row carries nine of these; the label alone is not enough
  // to address one from a test or from the DOM.
  input.dataset["field"] = labelText;
  input.value = value;
  input.addEventListener("change", () => {
    onChange(input.value);
    clearSaveStatus();
  });
  label.append(input);
  return label;
}

/** One labelled `<select>`, committing on change — fieldInput's sibling. */
function fieldSelect(
  labelText: string,
  value: string,
  options: string[],
  onChange: (value: string) => void,
): HTMLElement {
  const label = document.createElement("label");
  label.dataset["field"] = labelText;
  const caption = document.createElement("span");
  caption.textContent = labelText;
  label.append(caption);
  const select = document.createElement("select");
  select.dataset["field"] = labelText;
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option;
    element.textContent = option;
    select.append(element);
  }
  select.value = value;
  select.addEventListener("change", () => {
    onChange(select.value);
    clearSaveStatus();
  });
  label.append(select);
  return label;
}

function removeControl(onClick: () => void): HTMLElement {
  const remove = document.createElement("span");
  remove.className = "settings-row-remove";
  remove.textContent = "×";
  remove.setAttribute("role", "button");
  remove.addEventListener("click", () => {
    onClick();
    clearSaveStatus();
    renderSettings();
  });
  return remove;
}

function spacer(): HTMLElement {
  const element = document.createElement("div");
  element.className = "settings-row-spacer";
  return element;
}

// ---------------------------------------------------------------- Agents

function renderAgents(): void {
  if (draft === undefined) return;
  const container = $("settings-agents");
  container.replaceChildren();
  for (const [id, agent] of Object.entries(draft.registry.agents)) {
    container.append(renderAgentRow(id, agent));
  }
}

const VENDORS: readonly ProviderVendor[] = ["anthropic", "github", "openai"];

function renderAgentRow(id: string, agent: Omit<AgentConfig, "id">): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-row";

  const idField = fieldInput("id", id, (value) => renameAgent(id, value));
  const commandField = fieldInput("command", agent.command, (value) =>
    updateAgent(id, { command: value }),
  );
  const argsField = fieldInput("args", (agent.args ?? []).join(" "), (value) => {
    const parts = value.trim();
    updateAgent(id, { args: parts === "" ? undefined : parts.split(/\s+/) });
  });
  const modelField = fieldInput("model", agent.model ?? "", (value) =>
    updateAgent(id, { model: value === "" ? undefined : value }),
  );
  const configDirField = fieldInput("configDir", agent.configDir ?? "", (value) =>
    updateAgent(id, { configDir: value === "" ? undefined : value }),
  );

  const defaultLabel = document.createElement("label");
  const defaultCheckbox = document.createElement("input");
  defaultCheckbox.type = "checkbox";
  defaultCheckbox.checked = agent.default === true;
  defaultCheckbox.addEventListener("change", () => {
    updateAgent(id, { default: defaultCheckbox.checked ? true : undefined });
    clearSaveStatus();
  });
  defaultLabel.append(defaultCheckbox, document.createTextNode("default"));

  const vendorLabel = document.createElement("label");
  vendorLabel.textContent = "vendor";
  const vendorSelect = document.createElement("select");
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "(none)";
  vendorSelect.append(noneOption);
  for (const vendor of VENDORS) {
    const option = document.createElement("option");
    option.value = vendor;
    option.textContent = vendor;
    vendorSelect.append(option);
  }
  vendorSelect.value = agent.vendor ?? "";
  vendorSelect.addEventListener("change", () => {
    updateAgent(id, {
      vendor: vendorSelect.value === "" ? undefined : (vendorSelect.value as ProviderVendor),
    });
    clearSaveStatus();
  });
  vendorLabel.append(vendorSelect);

  const testButton = document.createElement("button");
  testButton.type = "button";
  testButton.className = "settings-add";
  testButton.textContent = "Test";
  const testStatus = document.createElement("span");
  testStatus.className = "settings-test-status";
  testButton.addEventListener("click", () => void testAgentRow(id, testStatus));

  row.append(
    idField,
    commandField,
    argsField,
    modelField,
    configDirField,
    defaultLabel,
    vendorLabel,
    testButton,
    testStatus,
    spacer(),
    removeControl(() => removeAgent(id)),
  );
  return row;
}

async function testAgentRow(id: string, status: HTMLElement): Promise<void> {
  if (draft === undefined) return;
  const agent = draft.registry.agents[id];
  if (agent === undefined) return;
  status.textContent = "…";
  status.classList.remove("settings-test-status--ok", "settings-test-status--fail");
  const health = await window.jarvis.testAgent({ id, ...agent });
  status.textContent = health.ok ? "✓" : "✗";
  status.title = health.detail;
  status.classList.toggle("settings-test-status--ok", health.ok);
  status.classList.toggle("settings-test-status--fail", !health.ok);
}

function updateAgent(id: string, patch: Partial<Omit<AgentConfig, "id">>): void {
  if (draft === undefined) return;
  const current = draft.registry.agents[id];
  if (current === undefined) return;
  draft.registry.agents[id] = { ...current, ...patch };
}

/** Renaming an agent's id (the map key) moves every field to the new key
 *  and, since a routing rule or brain.accountId may target the old id,
 *  updates those references too — the same "never leave a dangling
 *  reference" discipline removeAgent already has to apply. */
function renameAgent(oldId: string, newId: string): void {
  if (draft === undefined || newId === "" || newId === oldId) return;
  const agent = draft.registry.agents[oldId];
  if (agent === undefined) return;
  delete draft.registry.agents[oldId];
  draft.registry.agents[newId] = agent;

  for (const rule of draft.registry.routing ?? []) {
    if (rule.agent === oldId) rule.agent = newId;
  }
  if (draft.brain.accountId === oldId) draft.brain.accountId = newId;

  renderSettings();
}

function removeAgent(id: string): void {
  if (draft === undefined) return;
  delete draft.registry.agents[id];

  // Never leave a routing rule or brain.accountId pointing at an agent that
  // no longer exists — the moment the deleting edit happens, not as a
  // parseConfig error the user only sees after clicking Save.
  for (const rule of draft.registry.routing ?? []) {
    if (rule.agent === id) rule.agent = "";
  }
  if (draft.brain.accountId === id) {
    delete draft.brain.accountId;
    delete draft.brain.configDir;
  }
}

function addAgent(): void {
  if (draft === undefined) return;
  let n = 1;
  while (draft.registry.agents[`new-agent-${n}`] !== undefined) n += 1;
  draft.registry.agents[`new-agent-${n}`] = { command: "" };
  renderSettings();
}

// ---------------------------------------------------------------- Routing

function renderRouting(): void {
  if (draft === undefined) return;
  const container = $("settings-routing");
  container.replaceChildren();
  for (const [index, rule] of (draft.registry.routing ?? []).entries()) {
    container.append(renderRoutingRow(rule, index));
  }
}

function renderRoutingRow(rule: RoutingRule, index: number): HTMLElement {
  if (draft === undefined) throw new Error("unreachable: renderRoutingRow needs an open draft");
  const row = document.createElement("div");
  row.className = "settings-row";

  const projectField = fieldInput("project", rule.match.project ?? "", (value) =>
    updateRoutingMatch(index, "project", value),
  );
  const intentField = fieldInput("intent", rule.match.intent ?? "", (value) =>
    updateRoutingMatch(index, "intent", value),
  );

  const agentLabel = document.createElement("label");
  agentLabel.textContent = "agent";
  const agentSelect = document.createElement("select");
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "(select agent)";
  agentSelect.append(placeholder);
  for (const id of Object.keys(draft.registry.agents)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    agentSelect.append(option);
  }
  agentSelect.value = rule.agent;
  agentSelect.addEventListener("change", () => {
    updateRoutingAgent(index, agentSelect.value);
    clearSaveStatus();
  });
  agentLabel.append(agentSelect);

  row.append(
    projectField,
    intentField,
    agentLabel,
    spacer(),
    removeControl(() => removeRoutingRule(index)),
  );
  return row;
}

function updateRoutingMatch(index: number, key: "project" | "intent", value: string): void {
  if (draft === undefined) return;
  const rule = (draft.registry.routing ?? [])[index];
  if (rule === undefined) return;
  rule.match = { ...rule.match, [key]: value === "" ? undefined : value };
}

function updateRoutingAgent(index: number, agent: string): void {
  if (draft === undefined) return;
  const rule = (draft.registry.routing ?? [])[index];
  if (rule === undefined) return;
  rule.agent = agent;
}

function removeRoutingRule(index: number): void {
  if (draft === undefined) return;
  draft.registry.routing = (draft.registry.routing ?? []).filter((_rule, i) => i !== index);
}

function addRoutingRule(): void {
  if (draft === undefined) return;
  draft.registry.routing = [...(draft.registry.routing ?? []), { match: {}, agent: "" }];
  renderSettings();
}

// --------------------------------------------------------------- Projects

function renderProjects(): void {
  if (draft === undefined) return;
  const container = $("settings-projects");
  container.replaceChildren();
  for (const [name, path] of Object.entries(draft.projects)) {
    container.append(renderProjectRow(name, path));
  }
}

function renderProjectRow(name: string, path: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-row";
  const nameField = fieldInput("name", name, (value) => renameProject(name, value));
  const pathField = fieldInput("path", path, (value) => updateProject(name, value));
  row.append(
    nameField,
    pathField,
    spacer(),
    removeControl(() => removeProject(name)),
  );
  return row;
}

function updateProject(name: string, path: string): void {
  if (draft === undefined || draft.projects[name] === undefined) return;
  draft.projects[name] = path;
}

function renameProject(oldName: string, newName: string): void {
  if (draft === undefined || newName === "" || newName === oldName) return;
  const path = draft.projects[oldName];
  if (path === undefined) return;
  delete draft.projects[oldName];
  draft.projects[newName] = path;
  // `databases` is keyed by project name, and parseConfig rejects a key
  // naming no configured project — so the connections move with the rename
  // in the same mutation rather than being orphaned by it.
  const connections = draft.databases[oldName];
  if (connections !== undefined) {
    delete draft.databases[oldName];
    draft.databases[newName] = connections;
  }
  // `editors` is keyed by project name too, and parseConfig rejects a key
  // naming no configured project — so the roots move with the rename for
  // the same reason the connections above do.
  const roots = draft.editors[oldName];
  if (roots !== undefined) {
    delete draft.editors[oldName];
    draft.editors[newName] = roots;
  }
  // `docker` is keyed by project name too, and parseConfig rejects a key
  // naming no configured project — so the entries move with the rename for
  // the same reason the connections and roots above do.
  const containers = draft.docker[oldName];
  if (containers !== undefined) {
    delete draft.docker[oldName];
    draft.docker[newName] = containers;
  }
  renderSettings();
}

function removeProject(name: string): void {
  if (draft === undefined) return;
  delete draft.projects[name];
  // Same reason as the rename above: a connection list — or a root list, or
  // a container list — keyed to a project that no longer exists is a config
  // parseConfig would refuse to load.
  delete draft.databases[name];
  delete draft.editors[name];
  delete draft.docker[name];
}

function addProject(): void {
  if (draft === undefined) return;
  let n = 1;
  while (draft.projects[`new-project-${n}`] !== undefined) n += 1;
  draft.projects[`new-project-${n}`] = "";
  renderSettings();
}

// -------------------------------------------------------------- Databases

// The same four engines @jarvis/platform's DB_GATE_ENGINES lists, restated
// here rather than imported: a *type* import from another workspace package
// is erased at compile time and costs nothing, but a value import is a bare
// specifier that is runtime-fatal in the bundled renderer — the same reason
// workspace.ts restates the Bookmark type instead of importing it. The
// DbGateEngine annotation is what keeps the two lists from drifting: drop an
// engine from platform's union and this stops compiling.
const ENGINE_OPTIONS: readonly DbGateEngine[] = ["mysql", "mariadb", "postgres", "sqlite"];

/** Every connection across every project, flattened into rows. Each row
 *  names its own project, so moving a connection is a select change rather
 *  than a delete and a re-add. */
function renderDatabases(): void {
  if (draft === undefined) return;
  const container = $("settings-databases");
  container.replaceChildren();
  for (const [project, connections] of Object.entries(draft.databases)) {
    connections.forEach((connection, index) => {
      container.append(renderConnectionRow(project, index, connection));
    });
  }
  // parseConfig rejects a connection keyed to a project that does not
  // exist, so with no projects there is no valid row to add — the UI must
  // not be able to produce a draft that cannot be saved.
  ($("settings-database-add") as HTMLButtonElement).disabled =
    Object.keys(draft.projects).length === 0;
}

function renderConnectionRow(
  project: string,
  index: number,
  connection: DbGateConnection,
): HTMLElement {
  if (draft === undefined) return document.createElement("div");
  const row = document.createElement("div");
  row.className = "settings-row";

  const projectField = fieldSelect("project", project, Object.keys(draft.projects), (value) =>
    moveConnection(project, index, value),
  );
  const idField = fieldInput("id", connection.id, (value) => {
    if (value !== "") updateConnection(project, index, { id: value });
  });
  const labelField = fieldInput("label", connection.label ?? "", (value) =>
    updateConnection(project, index, { label: value === "" ? undefined : value }),
  );
  const engineField = fieldSelect("engine", connection.engine, [...ENGINE_OPTIONS], (value) =>
    updateConnection(project, index, { engine: value as DbGateEngine }),
  );
  const hostField = fieldInput("host", connection.host ?? "", (value) =>
    updateConnection(project, index, { host: value === "" ? undefined : value }),
  );
  const portField = fieldInput(
    "port",
    connection.port === undefined ? "" : String(connection.port),
    (value) => {
      if (value === "") {
        updateConnection(project, index, { port: undefined });
        return;
      }
      // A half-typed port is not a reason to write NaN into the draft, which
      // parseConfig would then reject with a message about a field the user
      // thinks they filled in correctly. An unparseable value is simply not
      // committed; the field re-renders with the last good one.
      const port = Number(value);
      if (Number.isFinite(port)) updateConnection(project, index, { port });
    },
  );
  const userField = fieldInput("user", connection.user ?? "", (value) =>
    updateConnection(project, index, { user: value === "" ? undefined : value }),
  );
  const databaseField = fieldInput("database", connection.database ?? "", (value) =>
    updateConnection(project, index, { database: value === "" ? undefined : value }),
  );
  // The *name* of an environment variable, never a password: jarvis.yaml is
  // rewritten on every save and holds no secrets. Left empty, DbGate asks
  // for the password itself and keeps it in that project's own workspace.
  const passwordField = fieldInput("passwordEnv", connection.passwordEnv ?? "", (value) =>
    updateConnection(project, index, { passwordEnv: value === "" ? undefined : value }),
  );

  row.append(
    projectField,
    idField,
    labelField,
    engineField,
    hostField,
    portField,
    userField,
    databaseField,
    passwordField,
    spacer(),
    removeControl(() => removeConnection(project, index)),
  );
  return row;
}

function updateConnection(project: string, index: number, patch: Partial<DbGateConnection>): void {
  if (draft === undefined) return;
  const connection = draft.databases[project]?.[index];
  if (connection === undefined) return;
  Object.assign(connection, patch);
  // An explicit `undefined` in the patch means "cleared", and a key whose
  // value is undefined must not survive into the YAML.
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (connection as Record<string, unknown>)[key];
  }
}

function moveConnection(project: string, index: number, toProject: string): void {
  if (draft === undefined || toProject === project) return;
  const connections = draft.databases[project];
  const connection = connections?.[index];
  if (connections === undefined || connection === undefined) return;
  if (draft.projects[toProject] === undefined) return;

  const remaining = connections.filter((_entry, i) => i !== index);
  if (remaining.length === 0) delete draft.databases[project];
  else draft.databases[project] = remaining;
  draft.databases[toProject] = [...(draft.databases[toProject] ?? []), connection];
  renderSettings();
}

function removeConnection(project: string, index: number): void {
  if (draft === undefined) return;
  const connections = draft.databases[project];
  if (connections === undefined) return;
  const remaining = connections.filter((_entry, i) => i !== index);
  if (remaining.length === 0) delete draft.databases[project];
  else draft.databases[project] = remaining;
}

function addConnection(): void {
  if (draft === undefined) return;
  const project = Object.keys(draft.projects)[0];
  if (project === undefined) return;
  const existing = draft.databases[project] ?? [];
  // Ids are unique within a project (parseConfig enforces it) and end up in
  // environment variable names, so the generated one stays in [A-Za-z0-9_].
  let n = 1;
  while (existing.some((connection) => connection.id === `connection_${n}`)) n += 1;
  draft.databases[project] = [...existing, { id: `connection_${n}`, engine: "mysql" }];
  renderSettings();
}

// ----------------------------------------------------------- Editor roots

/** Every editor root across every project, flattened into rows — the same
 *  shape the databases section above uses, and for the same reason: a row
 *  names its own project, so moving a root is a select change rather than a
 *  delete and a re-add. */
function renderEditors(): void {
  if (draft === undefined) return;
  const container = $("settings-editors");
  container.replaceChildren();
  for (const [project, roots] of Object.entries(draft.editors)) {
    roots.forEach((root, index) => {
      container.append(renderEditorRootRow(project, index, root));
    });
  }
  // parseConfig rejects a root keyed to a project that does not exist, so
  // with no projects there is no valid row to add.
  ($("settings-editor-add") as HTMLButtonElement).disabled =
    Object.keys(draft.projects).length === 0;
}

function renderEditorRootRow(project: string, index: number, root: EditorRoot): HTMLElement {
  if (draft === undefined) return document.createElement("div");
  const row = document.createElement("div");
  row.className = "settings-row";

  const projectField = fieldSelect("project", project, Object.keys(draft.projects), (value) =>
    moveEditorRoot(project, index, value),
  );
  const nameField = fieldInput("name", root.name, (value) => {
    if (value !== "") updateEditorRoot(project, index, { name: value });
  });
  // Relative to the project directory, always — parseConfig refuses an
  // absolute or climbing path, so a draft with one cannot be saved.
  const pathField = fieldInput("path", root.path, (value) => {
    if (value !== "") updateEditorRoot(project, index, { path: value });
  });

  row.append(
    projectField,
    nameField,
    pathField,
    spacer(),
    removeControl(() => removeEditorRoot(project, index)),
  );
  return row;
}

function updateEditorRoot(project: string, index: number, patch: Partial<EditorRoot>): void {
  if (draft === undefined) return;
  const root = draft.editors[project]?.[index];
  if (root === undefined) return;
  Object.assign(root, patch);
}

function moveEditorRoot(project: string, index: number, toProject: string): void {
  if (draft === undefined || toProject === project) return;
  const roots = draft.editors[project];
  const root = roots?.[index];
  if (roots === undefined || root === undefined) return;
  if (draft.projects[toProject] === undefined) return;

  const remaining = roots.filter((_entry, i) => i !== index);
  if (remaining.length === 0) delete draft.editors[project];
  else draft.editors[project] = remaining;
  draft.editors[toProject] = [...(draft.editors[toProject] ?? []), root];
  renderSettings();
}

function removeEditorRoot(project: string, index: number): void {
  if (draft === undefined) return;
  const roots = draft.editors[project];
  if (roots === undefined) return;
  const remaining = roots.filter((_entry, i) => i !== index);
  if (remaining.length === 0) delete draft.editors[project];
  else draft.editors[project] = remaining;
}

function addEditorRoot(): void {
  if (draft === undefined) return;
  const project = Object.keys(draft.projects)[0];
  if (project === undefined) return;
  const existing = draft.editors[project] ?? [];
  // Names are unique within a project (parseConfig enforces it), and the
  // generated path is "." — the project itself, which is always valid, so a
  // freshly added row can be saved before it is filled in.
  let n = 1;
  while (existing.some((root) => root.name === `root-${n}`)) n += 1;
  draft.editors[project] = [...existing, { name: `root-${n}`, path: "." }];
  renderSettings();
}

// ------------------------------------------------------------------ Docker

/** Every configured container across every project, flattened into rows —
 *  the same shape the databases and editor-roots sections above use, and
 *  for the same reason: a row names its own project, so moving a container
 *  is a select change rather than a delete and a re-add. */
function renderDocker(): void {
  if (draft === undefined) return;
  const container = $("settings-docker");
  container.replaceChildren();
  for (const [project, entries] of Object.entries(draft.docker)) {
    entries.forEach((entry, index) => {
      container.append(renderDockerRow(project, index, entry));
    });
  }
  // parseConfig rejects a container keyed to a project that does not exist,
  // so with no projects there is no valid row to add.
  ($("settings-docker-add") as HTMLButtonElement).disabled =
    Object.keys(draft.projects).length === 0;
  renderDockerPicker();
}

function renderDockerRow(project: string, index: number, entry: DockerEntry): HTMLElement {
  if (draft === undefined) return document.createElement("div");
  const row = document.createElement("div");
  row.className = "settings-row";

  const projectField = fieldSelect("project", project, Object.keys(draft.projects), (value) =>
    moveDockerEntry(project, index, value),
  );
  const nameField = fieldInput("name", entry.name, (value) => {
    if (value !== "") updateDockerEntry(project, index, { name: value });
  });
  const containerField = fieldInput("container", entry.container, (value) => {
    if (value !== "") updateDockerEntry(project, index, { container: value });
  });

  row.append(
    projectField,
    nameField,
    containerField,
    spacer(),
    removeControl(() => removeDockerEntry(project, index)),
  );
  return row;
}

function updateDockerEntry(project: string, index: number, patch: Partial<DockerEntry>): void {
  if (draft === undefined) return;
  const entry = draft.docker[project]?.[index];
  if (entry === undefined) return;
  Object.assign(entry, patch);
}

function moveDockerEntry(project: string, index: number, toProject: string): void {
  if (draft === undefined || toProject === project) return;
  const entries = draft.docker[project];
  const entry = entries?.[index];
  if (entries === undefined || entry === undefined) return;
  if (draft.projects[toProject] === undefined) return;

  const remaining = entries.filter((_entry, i) => i !== index);
  if (remaining.length === 0) delete draft.docker[project];
  else draft.docker[project] = remaining;
  draft.docker[toProject] = [...(draft.docker[toProject] ?? []), entry];
  renderSettings();
}

function removeDockerEntry(project: string, index: number): void {
  if (draft === undefined) return;
  const entries = draft.docker[project];
  if (entries === undefined) return;
  const remaining = entries.filter((_entry, i) => i !== index);
  if (remaining.length === 0) delete draft.docker[project];
  else draft.docker[project] = remaining;
}

function addDockerEntry(): void {
  if (draft === undefined) return;
  const project = Object.keys(draft.projects)[0];
  if (project === undefined) return;
  const existing = draft.docker[project] ?? [];
  // Names are unique within a project (parseConfig enforces it), same as
  // addEditorRoot's generated name.
  let n = 1;
  while (existing.some((entry) => entry.name === `container-${n}`)) n += 1;
  // `container` is seeded with the same placeholder rather than left empty,
  // for the reason addEditorRoot seeds `path: "."`: parseConfig rejects an
  // empty `docker.<p>[i].container`, so a freshly added row must already be
  // saveable before the user has filled in the real container name.
  draft.docker[project] = [...existing, { name: `container-${n}`, container: `container-${n}` }];
  renderSettings();
}

/** A display name no other entry in this project already uses — `app`,
 *  `app-2`, … — because parseConfig rejects duplicate names within a
 *  project, and two compose stacks filed under one project can each have an
 *  `app` service. The same rule addDockerEntry follows for its own generated
 *  names. */
function uniqueDockerName(existing: readonly DockerEntry[], base: string): string {
  if (!existing.some((entry) => entry.name === base)) return base;
  let n = 2;
  while (existing.some((entry) => entry.name === `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** One container offered by Auto-populate, paired with the project it would
 *  be filed under if ticked. */
type DockerPickerEntry = { facts: ContainerFacts; project: string; checked: boolean };

let dockerPicker: DockerPickerEntry[] | undefined;

/** True when `dir` is `base` itself or a path under it — a trailing-
 *  separator-aware prefix test, so "/p/acme-old" does not match
 *  "/p/acme". */
function isInsideProject(dir: string, base: string): boolean {
  if (base === "") return false;
  return dir === base || dir.startsWith(base.endsWith("/") ? base : `${base}/`);
}

/** The first configured project whose directory contains this container's
 *  compose working directory, if any. */
function projectForContainer(facts: ContainerFacts): string | undefined {
  if (draft === undefined || facts.composeWorkingDir === undefined) return undefined;
  for (const [project, path] of Object.entries(draft.projects)) {
    if (isInsideProject(facts.composeWorkingDir, path)) return project;
  }
  return undefined;
}

/** Fetches every container on the machine and opens the checklist, ticking
 *  the ones that live inside a configured project's directory. Changes
 *  nothing until the checklist is confirmed. */
async function autopopulateDocker(): Promise<void> {
  const result = await window.jarvis.dockerContainers();
  if (!result.ok) {
    const status = $("settings-status");
    status.textContent = result.text;
    status.classList.add("settings-status--error");
    return;
  }
  if (draft === undefined) return;
  dockerPicker = result.value.map((facts) => {
    const matched = projectForContainer(facts);
    return {
      facts,
      project: matched ?? Object.keys(draft?.projects ?? {})[0] ?? "",
      checked: matched !== undefined,
    };
  });
  renderDockerPicker();
}

function renderDockerPicker(): void {
  if (draft === undefined) return;
  const container = $("settings-docker-picker");
  container.replaceChildren();
  if (dockerPicker === undefined) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  for (const entry of dockerPicker) {
    // A plain row, not a <label>: the project <select> below must not be
    // nested inside a control whose implicit click target is the checkbox.
    const row = document.createElement("div");
    row.className = "settings-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = entry.checked;
    checkbox.addEventListener("change", () => {
      entry.checked = checkbox.checked;
    });
    const name = document.createElement("span");
    name.textContent = entry.facts.name;
    // Visible and editable, never a silent default: a container with no
    // matching project directory still needs a project the user picked,
    // not one guessed on their behalf.
    const projectField = fieldSelect(
      "project",
      entry.project,
      Object.keys(draft.projects),
      (value) => {
        entry.project = value;
      },
    );
    row.append(checkbox, name, projectField);
    container.append(row);
  }

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.id = "settings-docker-confirm";
  confirm.className = "settings-add";
  confirm.textContent = "Confirm";
  confirm.addEventListener("click", () => confirmDockerPicker());
  container.append(confirm);
}

/** Replaces each ticked container's project entry with the union of what
 *  was already configured and the newly ticked containers, defaulting a new
 *  entry's name to its compose service label and falling back to the
 *  container name — suffixed if that name is already taken in the project,
 *  since two stacks can each have an `app`. A container already configured
 *  is left exactly as it was — an existing custom name is never
 *  overwritten. */
function confirmDockerPicker(): void {
  if (draft === undefined || dockerPicker === undefined) return;
  for (const entry of dockerPicker) {
    if (!entry.checked) continue;
    if (entry.project === "" || draft.projects[entry.project] === undefined) continue;
    const existing = draft.docker[entry.project] ?? [];
    if (existing.some((row) => row.container === entry.facts.name)) continue;
    const name = uniqueDockerName(existing, entry.facts.composeService ?? entry.facts.name);
    draft.docker[entry.project] = [...existing, { name, container: entry.facts.name }];
  }
  dockerPicker = undefined;
  clearSaveStatus();
  renderSettings();
}

// -------------------------------------------------------------------- Chat

// The drivers @jarvis/platform's CHAT_DRIVERS declares, restated here for
// the same reason ENGINE_OPTIONS is: a value import from a workspace
// package is runtime-fatal in the renderer bundle, and only the type may
// cross. The `satisfies` is what keeps the two from drifting, and it is
// stricter than ENGINE_OPTIONS' annotation — this one fails to compile when
// a driver is *added* to the union as well as when one is removed, which is
// the direction that would otherwise leave a driver unpickable in Settings.
const DRIVER_OPTIONS = Object.keys({
  slack: true,
  teams: true,
} satisfies Record<ChatDriver, true>) as ChatDriver[];

/** Every chat across every project, flattened into rows — the same shape
 *  the sections above use, and for the same reason: a row names its own
 *  project, so moving a chat is a select change rather than a delete and a
 *  re-add. */
function renderChat(): void {
  if (draft === undefined) return;
  const container = $("settings-chat");
  container.replaceChildren();
  for (const [project, entries] of Object.entries(draft.chat)) {
    entries.forEach((entry, index) => {
      container.append(renderChatRow(project, index, entry));
    });
  }
  // parseConfig rejects a chat keyed to a project that does not exist, so
  // with no projects there is no valid row to add.
  ($("settings-chat-add") as HTMLButtonElement).disabled = Object.keys(draft.projects).length === 0;
}

function renderChatRow(project: string, index: number, entry: ChatEntry): HTMLElement {
  if (draft === undefined) return document.createElement("div");
  const row = document.createElement("div");
  row.className = "settings-row";

  const projectField = fieldSelect("project", project, Object.keys(draft.projects), (value) =>
    moveChatEntry(project, index, value),
  );
  const nameField = fieldInput("name", entry.name, (value) => {
    if (value !== "") updateChatEntry(project, index, { name: value });
  });
  const driverField = fieldSelect("driver", entry.driver, DRIVER_OPTIONS, (value) => {
    if (isDriverOption(value)) updateChatEntry(project, index, { driver: value });
  });
  // Which org's Slack or Teams, and optional: an emptied field means the
  // provider's own picker, so it drops the key rather than saving
  // `account: ""` — which parseConfig refuses, and would otherwise make a
  // config Settings itself wrote unloadable.
  const accountField = fieldInput("account", entry.account ?? "", (value) => {
    updateChatAccount(project, index, value);
  });

  row.append(
    projectField,
    nameField,
    driverField,
    accountField,
    spacer(),
    removeControl(() => removeChatEntry(project, index)),
  );
  return row;
}

function isDriverOption(value: string): value is ChatDriver {
  return (DRIVER_OPTIONS as string[]).includes(value);
}

function updateChatEntry(project: string, index: number, patch: Partial<ChatEntry>): void {
  if (draft === undefined) return;
  const entry = draft.chat[project]?.[index];
  if (entry === undefined) return;
  Object.assign(entry, patch);
}

/** Kept apart from updateChatEntry because clearing this field must delete
 *  the key, and Object.assign with `undefined` leaves it present. */
function updateChatAccount(project: string, index: number, value: string): void {
  if (draft === undefined) return;
  const entry = draft.chat[project]?.[index];
  if (entry === undefined) return;
  if (value === "") delete entry.account;
  else entry.account = value;
}

function moveChatEntry(project: string, index: number, toProject: string): void {
  if (draft === undefined || toProject === project) return;
  const entries = draft.chat[project];
  const entry = entries?.[index];
  if (entries === undefined || entry === undefined) return;
  if (draft.projects[toProject] === undefined) return;

  const remaining = entries.filter((_entry, i) => i !== index);
  if (remaining.length === 0) delete draft.chat[project];
  else draft.chat[project] = remaining;
  draft.chat[toProject] = [...(draft.chat[toProject] ?? []), entry];
  renderSettings();
}

function removeChatEntry(project: string, index: number): void {
  if (draft === undefined) return;
  const entries = draft.chat[project];
  if (entries === undefined) return;
  const remaining = entries.filter((_entry, i) => i !== index);
  if (remaining.length === 0) delete draft.chat[project];
  else draft.chat[project] = remaining;
}

function addChatEntry(): void {
  if (draft === undefined) return;
  const project = Object.keys(draft.projects)[0];
  if (project === undefined) return;
  const existing = draft.chat[project] ?? [];
  // Names are unique within a project (parseConfig enforces it), and a row
  // with no account is already valid — so a freshly added row can be saved
  // before it is filled in, exactly as addEditorRoot's can.
  let n = 1;
  while (existing.some((entry) => entry.name === `chat-${n}`)) n += 1;
  draft.chat[project] = [...existing, { name: `chat-${n}`, driver: "slack" }];
  renderSettings();
}

// ------------------------------------------------------------------ Brain

function renderBrain(): void {
  if (draft === undefined) return;
  ($("settings-brain-cwd") as HTMLInputElement).value = draft.brain.cwd;
  ($("settings-brain-prompt") as HTMLTextAreaElement).value = draft.brain.systemPrompt;

  const select = $("settings-brain-account") as HTMLSelectElement;
  select.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "(none)";
  select.append(none);
  // Mirrors parseConfig's own requirement: only an agent that declares a
  // configDir can ever be brain.accountId, so an agent with none is not
  // offered here at all — the UI cannot produce a draft parseConfig would
  // reject for this reason.
  for (const [id, agent] of Object.entries(draft.registry.agents)) {
    if (agent.configDir === undefined || agent.configDir === "") continue;
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    select.append(option);
  }
  select.value = draft.brain.accountId ?? "";
}

// ------------------------------------------------------------------ Voice

/** Every installed voice, read once when Settings first opens. */
let installedVoices: {
  name: string;
  language: string;
  upgraded: boolean;
  engine: "piper" | "say";
}[] = [];

/** Which entry the English picker should be showing: the neural engine when
 *  it is selected, otherwise the configured `say` voice. The picker is the
 *  single control — choosing a voice is what chooses the engine. */
function selectedEnglishVoice(): string {
  if (draft === undefined) return "";
  if (draft.voice.engine === "piper") {
    return (
      installedVoices.find((voice) => voice.engine === "piper")?.name ?? draft.voice.englishVoice
    );
  }
  return draft.voice.englishVoice;
}

function renderVoice(): void {
  if (draft === undefined) return;
  fillVoiceSelect("settings-voice-en", "en", selectedEnglishVoice());
  fillVoiceSelect("settings-voice-ar", "ar", draft.voice.arabicVoice);
  ($("settings-speak-greeting") as HTMLInputElement).checked = draft.voice.speakGreeting;
  ($("settings-greeting-en") as HTMLTextAreaElement).value = draft.voice.greeting.en;
  ($("settings-greeting-ar") as HTMLTextAreaElement).value = draft.voice.greeting.ar;
  renderVoiceNote();
}

/**
 * macOS ships every voice in a compact form and offers Enhanced and Premium
 * downloads for many of them; the compact ones are the robotic-sounding
 * originals. Saying so here is the difference between a user who thinks the
 * app sounds bad and one who knows there is a better voice a download away.
 */
function renderVoiceNote(): void {
  const note = $("settings-voice-note");
  note.replaceChildren();
  // The advice below names a macOS preference pane. Elsewhere every voice on
  // the list is a Piper model, which has no compact and enhanced versions to
  // choose between, and the note would be directions to a screen that does
  // not exist.
  if (window.jarvis.platform !== "darwin") return;
  if (installedVoices.length === 0) return;
  if (installedVoices.some((voice) => voice.upgraded)) return;

  note.textContent =
    "Every installed voice is the compact version, which is why they sound synthetic. " +
    "System Settings → Accessibility → Spoken Content → System Voice → Manage Voices " +
    "downloads the Enhanced ones; Jarvis picks the better version up on its own.";
}

/** The voices worth offering for a language: its own, then everything else,
 *  since a name that is not in the list at all cannot be chosen back. */
function fillVoiceSelect(id: string, language: "ar" | "en", current: string): void {
  const select = $(id) as HTMLSelectElement;
  const prefix = language === "ar" ? "ar" : "en";

  const matching = installedVoices.filter((voice) => voice.language.startsWith(prefix));
  const names = matching.map((voice) => voice.name);
  // A configured voice that is not installed still has to be selectable, or
  // opening Settings would silently rewrite it to whatever came first.
  if (current !== "" && !names.includes(current)) names.unshift(current);

  select.replaceChildren();
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    const voice = matching.find((entry) => entry.name === name);
    option.textContent =
      voice === undefined ? `${name} (not installed)` : `${name} · ${voice.language}`;
    select.append(option);
  }
  select.value = current;
}

async function loadVoices(): Promise<void> {
  try {
    installedVoices = await window.jarvis.listVoices();
  } catch {
    // Without a listing the selects still hold the configured names; the
    // section degrades to what it was before rather than breaking.
    installedVoices = [];
  }
  renderVoice();
}

function previewVoice(id: string, language: "ar" | "en"): void {
  const name = ($(id) as HTMLSelectElement).value;
  if (name === "") return;
  void window.jarvis.previewVoice(name, language);
}

// ---------------------------------------------------------------- Whisper

function renderWhisper(): void {
  if (draft === undefined) return;
  ($("settings-whisper-binary") as HTMLInputElement).value = draft.whisper.binaryPath;
  ($("settings-whisper-model") as HTMLInputElement).value = draft.whisper.modelPath;
}

// ---------------------------------------------------------- Remote access

/** This machine's addresses, re-read every time Settings opens — a VPN
 *  brought up while Jarvis runs should be in the list the next time. */
let bindChoiceList: BindChoice[] = [];

/** Whether "Other…" is the picked radio. Held apart from the draft: picking
 *  it changes nothing until an address is typed, and the re-render in
 *  between must not snap the selection back to the listed address. */
let otherBindPicked = false;

/** config.ts's DEFAULT_REMOTE.bindAddress, restated: that module pulls in
 *  node:net (isIP) and cannot be imported by value here (no-value-imports),
 *  and the address itself is loopback's own fixed literal, not a value that
 *  could drift out from under a hand-copied string. */
const DEFAULT_BIND_ADDRESS = "127.0.0.1";

function renderRemote(): void {
  if (draft === undefined) return;
  const remote = draft.remote;
  const language = PRIMARY_LANGUAGE;

  $("settings-remote-title").textContent = MESSAGES.remoteTitle(language);
  // The section nav's own label for this section (board 5) — the section
  // itself is bilingual, so the link pointing at it has to be too. Looked
  // up separately from the throwing `$()` above: settings.test.ts's harness
  // lays down the section's own fields without the nav around them, and
  // that harness's coverage of this section must not need the nav too.
  const navLabel = document.getElementById("settings-nav-remote");
  if (navLabel) navLabel.textContent = MESSAGES.remoteTitle(language);
  $("settings-remote-enabled-label").textContent = MESSAGES.remoteEnabledLabel(language);
  $("settings-remote-reachable-label").textContent = MESSAGES.remoteReachableOn(language);
  $("settings-remote-port-label").textContent = MESSAGES.remotePortLabel(language);
  $("settings-remote-port-note").textContent = MESSAGES.remotePortNote(language);
  $("settings-remote-proxy-label").textContent = MESSAGES.remoteProxyLabel(language);
  $("settings-remote-proxy-note").textContent = MESSAGES.remoteProxyNote(language);
  $("settings-remote-push-label").textContent = MESSAGES.remotePushLabel(language);
  $("settings-remote-push-note").textContent = MESSAGES.remotePushNote(language);
  $("settings-remote-idle-label").textContent = MESSAGES.remoteIdleLabel(language);
  $("settings-remote-idle-note").textContent = MESSAGES.remoteIdleNote(language);
  $("settings-remote-push-projects-label").textContent = MESSAGES.remotePushProjectsLabel(language);
  $("settings-remote-push-projects-note").textContent = MESSAGES.remotePushProjectsNote(language);
  $("settings-remote-pair-title").textContent = MESSAGES.remotePairTitle(language);
  $("settings-remote-devices-title").textContent = MESSAGES.remoteDevicesTitle(language);
  $("settings-remote-warning").textContent = MESSAGES.remoteWarning(language);
  $("settings-remote-no-credential").textContent = MESSAGES.remoteNoCredential(language);
  ($("settings-remote-pair-cancel") as HTMLButtonElement).textContent =
    MESSAGES.remotePairCancel(language);

  ($("settings-remote-enabled") as HTMLInputElement).checked = remote.enabled;
  $("settings-remote-state").textContent = MESSAGES.remoteState(remote.enabled, language);
  ($("settings-remote-port") as HTMLInputElement).value = String(remote.port);
  ($("settings-remote-proxy") as HTMLInputElement).checked = remote.sidecarProxy;
  certBusy = false;
  clearRemoteCertError();
  renderRemoteCertRow();
  ($("settings-remote-push") as HTMLInputElement).checked = remote.push.enabled;
  ($("settings-remote-idle") as HTMLInputElement).value = String(remote.idleDisableMinutes);
  ($("settings-remote-push-projects") as HTMLInputElement).checked =
    remote.push.includeProjectNames;

  $("settings-remote-new-code").textContent = MESSAGES.remoteNewCode(language);

  renderBindChoices();
  renderRemotePairArea();
  renderPairedDevices();
}

/** The 1s countdown on an open pairing window's expiry — at most one timer
 *  running at a time, stopped on any non-open status. */
let expiryTimer: ReturnType<typeof setInterval> | undefined;

function stopExpiryTimer(): void {
  if (expiryTimer !== undefined) clearInterval(expiryTimer);
  expiryTimer = undefined;
}

function updateExpiryText(expiresAt: number): void {
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  $("settings-remote-pair-expiry").textContent = MESSAGES.remotePairExpires(
    seconds,
    PRIMARY_LANGUAGE,
  );
}

function startExpiryTimer(expiresAt: number): void {
  stopExpiryTimer();
  updateExpiryText(expiresAt);
  expiryTimer = setInterval(() => updateExpiryText(expiresAt), 1000);
}

function renderRemotePairArea(): void {
  const language = PRIMARY_LANGUAGE;
  const status = remoteStatusCache ?? DEFAULT_REMOTE_STATUS;

  const newCode = $("settings-remote-new-code") as HTMLButtonElement;
  newCode.disabled = !(
    status.enabled &&
    status.problem !== "devices-unreadable" &&
    status.pairing.kind === "closed"
  );

  const codeEl = $("settings-remote-pair-code");
  const cancelBtn = $("settings-remote-pair-cancel") as HTMLButtonElement;
  const note = $("settings-remote-pair-note");
  const qrCanvas = $("remote-pair-qr") as HTMLCanvasElement;
  const fingerprintEl = $("settings-remote-pair-fingerprint");

  stopExpiryTimer();

  if (status.pairing.kind === "open") {
    codeEl.textContent = status.pairing.uri;
    startExpiryTimer(status.pairing.expiresAt);
    cancelBtn.hidden = false;
    note.textContent = MESSAGES.remotePairInstructions(language);
    // The QR encodes the same secret-bearing link already shown as text
    // above — drawn only here, only from this remote:update-fed status, and
    // never toDataURL'd, saved or logged (M4 ruling 34's fallback stays the
    // link text, for a QR the phone's camera can't read).
    qrToCanvas(qrCanvas, encodeQr(status.pairing.uri), QR_MODULE_PX, QR_QUIET_ZONE_MODULES);
    qrCanvas.hidden = false;
    // Only the tail, never the fingerprint or the secret — see
    // fingerprintTailFromUri's own comment for why it doesn't import the
    // real parser.
    const tail = fingerprintTailFromUri(status.pairing.uri);
    fingerprintEl.textContent =
      tail === undefined ? "" : MESSAGES.remotePairFingerprintTail(tail, language);
  } else {
    codeEl.textContent = "";
    $("settings-remote-pair-expiry").textContent = "";
    cancelBtn.hidden = true;
    qrCanvas.getContext("2d")?.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
    qrCanvas.hidden = true;
    fingerprintEl.textContent = "";
    if (status.pairing.kind === "confirming") {
      const parts = MESSAGES.remotePairWaitingParts(language);
      note.replaceChildren(withNameInBdi(parts.before, status.pairing.deviceName, parts.after));
    } else if (!status.enabled) {
      note.textContent = MESSAGES.remotePairSaveFirst(language);
    } else {
      note.textContent = "";
    }
  }

  const problem = $("settings-remote-problem");
  problem.hidden = status.problem === undefined;
  if (status.problem !== undefined) {
    problem.textContent = MESSAGES.remoteProblem(status.problem, language);
  }

  renderRemoteCertificateNote(status);
  renderRemoteIdleState(status);
}

/** Task 4 rule 4: the bridge's own idle-timer status (RemoteStatus.idle,
 *  M12 Task 1) — rendered from `status` only, same reason
 *  renderRemoteCertificateNote is: what the bridge is doing right now, not
 *  what an unsaved draft asks for.
 *
 *  Ruling 5's draft flip lives here rather than in a separate effect: the
 *  bridge closed its own listener before this status ever arrived (M12
 *  global constraint — "off stays off, and off-by-itself is honest"), so
 *  the panel's job is only to catch the draft and the enabled switch up to
 *  a fact that already happened. It never calls renderSettings() or
 *  renderRemote() — only the two elements it touches directly — so a
 *  status that keeps reporting "disabled" (the record persists until the
 *  next `enabled: true` apply, per bridge.ts) can never loop: the `if
 *  (draft.remote.enabled)` guard makes the second and every later call a
 *  no-op once the draft already agrees. */
function renderRemoteIdleState(status: RemoteStatus): void {
  const language = PRIMARY_LANGUAGE;
  const state = $("settings-remote-idle-state");
  const idle = status.idle;

  if (idle === undefined) {
    state.textContent = "";
    state.hidden = true;
    return;
  }

  if (idle.kind === "armed") {
    state.textContent = MESSAGES.remoteIdleArmed(idle.disableAt, language);
    state.hidden = false;
    return;
  }

  state.textContent = MESSAGES.remoteIdleDisabled(idle.at, idle.afterMinutes, language);
  state.hidden = false;

  if (draft?.remote.enabled) {
    draft.remote.enabled = false;
    ($("settings-remote-enabled") as HTMLInputElement).checked = false;
    $("settings-remote-state").textContent = MESSAGES.remoteState(false, language);
  }
}

/** Task 4 rule 5: the sidecar proxy's certificate state, under its toggle.
 *  Rendered from `status` only, never from the draft — a config change
 *  the user hasn't saved yet says nothing about what the bridge is
 *  actually serving right now.
 *
 *  `status.listening === undefined` is checked FIRST, before
 *  `sidecarProxy === "needs-certificate"` (review round 1, Important #1):
 *  the bridge reports `needs-certificate` for the whole time the toggle is
 *  on and it simply is not listening yet (disabled, or enabled with zero
 *  paired devices) — bridge.ts's own gate, not only for a live self-signed
 *  or no-SAN certificate. Testing the warning first would assert "the
 *  certificate is self-signed or has no DNS name" about a certificate
 *  nobody is serving. Once `listening` is defined, `needs-certificate`
 *  takes priority over the plain certificate description: it is the more
 *  actionable fact (those tabs are unavailable) and already names the same
 *  certificate problem a self-signed/no-SAN note would. */
function renderRemoteCertificateNote(status: RemoteStatus): void {
  const language = PRIMARY_LANGUAGE;
  const note = $("settings-remote-certificate");

  if (status.listening === undefined) {
    note.textContent = "";
    note.className = "settings-note";
    note.hidden = true;
    return;
  }

  if (status.sidecarProxy === "needs-certificate") {
    note.textContent = MESSAGES.remoteProxyNeedsCertificate(language);
    note.className = "settings-note settings-note--warning";
    note.hidden = false;
    return;
  }

  const { certificate } = status.listening;
  note.textContent =
    certificate.source === "configured" && certificate.hostname !== undefined
      ? MESSAGES.remoteCertificateReal(certificate.hostname, language)
      : MESSAGES.remoteCertificateSelfSigned(language);
  note.className = "settings-note";
  note.hidden = false;
}

// ------------------------------------------------------- Tailscale cert row

// Opened through the existing external-link path (workspace.ts/
// session-view.ts's own openLink handlers): a Workspace tab under the
// reserved personal-browser project, never window.open — the main window's
// webContents denies every window.open/target=_blank outright
// (main.ts's setWindowOpenHandler), so a real anchor or window.open here
// would silently do nothing.
const TAILSCALE_ADMIN_URL = "https://login.tailscale.com/admin/dns";

/** True while a Get/Renew click is in flight — disables the button and
 *  swaps its label, same discipline testAgentRow's "…" state and the
 *  revoke button's disable-for-the-round-trip use elsewhere in this file. */
let certBusy = false;

/** The certificate's own name, read back from the path this module's own
 *  `remote:tailscaleCert` channel writes (tailscale-cert.ts's
 *  `<dir>/tls/<name>.crt`) — undefined for anything else (a hand-configured
 *  path, or no certificate at all), which falls back to showing the raw
 *  path instead. A pure string parse: no filesystem access, so it still
 *  works after Settings has been reopened and the draft is all that is left. */
function tailscaleCertNameFromPath(certPath: string): string | undefined {
  const parts = certPath.split(/[/\\]/);
  const file = parts[parts.length - 1];
  const dir = parts[parts.length - 2];
  if (dir !== "tls" || file === undefined || !file.endsWith(".crt")) return undefined;
  const name = file.slice(0, -".crt".length);
  return name === "" ? undefined : name;
}

/** The status text and Get/Renew button under the sidecar proxy switch,
 *  plus the Tailscale hint beneath it — all read from `draft.remote`, the
 *  same status-not-live-bridge discipline the port/idle/push fields above
 *  already follow (unlike renderRemoteCertificateNote, which describes what
 *  the bridge is actually serving right now). */
function renderRemoteCertRow(): void {
  if (draft === undefined) return;
  const language = PRIMARY_LANGUAGE;
  const { tls, bindAddress } = draft.remote;
  const hasCert = tls.certPath !== undefined && tls.keyPath !== undefined;

  const status = $("settings-remote-cert-status");
  if (!hasCert) {
    status.textContent = MESSAGES.remoteCertNone(language);
  } else {
    const certPath = tls.certPath as string;
    const name = tailscaleCertNameFromPath(certPath);
    status.textContent =
      name !== undefined
        ? MESSAGES.remoteCertNamed(name, language)
        : MESSAGES.remoteCertPath(certPath, language);
  }

  const button = $("settings-remote-cert-button") as HTMLButtonElement;
  button.disabled = certBusy;
  if (!certBusy) {
    button.textContent = hasCert
      ? MESSAGES.remoteCertRenewButton(language)
      : MESSAGES.remoteCertGetButton(language);
  }

  const hint = $("settings-remote-cert-hint");
  const showHint = !hasCert && isMeshAddress(bindAddress);
  hint.hidden = !showHint;
  hint.textContent = showHint ? MESSAGES.remoteCertHint(language) : "";
}

/** Renders `remote:tailscaleCert`'s failure into the error row beneath the
 *  button — a plain sentence for every kind except https-disabled, whose
 *  middle clause becomes a clickable control that opens the Tailscale admin
 *  console the same way every other in-app link does. */
function renderRemoteCertError(
  result: Extract<Awaited<ReturnType<typeof window.jarvis.tailscaleCert>>, { ok: false }>,
): void {
  const language = PRIMARY_LANGUAGE;
  const error = $("settings-remote-cert-error");
  error.hidden = false;

  if (result.kind === "no-tailscale") {
    error.textContent = MESSAGES.remoteCertNoTailscale(language);
    return;
  }
  if (result.kind === "not-connected") {
    error.textContent = MESSAGES.remoteCertNotConnected(language);
    return;
  }
  if (result.kind === "https-disabled") {
    const parts = MESSAGES.remoteCertHttpsDisabled(language);
    const link = document.createElement("button");
    link.type = "button";
    link.className = "settings-link-button";
    link.textContent = parts.link;
    link.addEventListener("click", () => {
      void window.jarvis.openTab(PERSONAL_PROJECT, TAILSCALE_ADMIN_URL);
    });
    error.replaceChildren(
      document.createTextNode(parts.before),
      link,
      document.createTextNode(parts.after),
    );
    return;
  }
  error.textContent = `${MESSAGES.remoteCertFailed(language)} ${result.detail}`;
}

function clearRemoteCertError(): void {
  const error = $("settings-remote-cert-error");
  error.replaceChildren();
  error.hidden = true;
}

/** Round 3: the saved address still being the config default means nobody
 *  has ever picked one, so the picker proposes the best one rather than
 *  making a first-time user hunt for Tailscale/Wi-Fi behind Advanced… —
 *  Tailscale first, Wi-Fi when this machine has no tailnet address. Called
 *  only once per open, right after a fresh bindChoiceList arrives (see
 *  loadBindChoices): re-running it on every render would fight a later,
 *  deliberate pick of "This machine only" back to loopback's own literal
 *  address, since that pick is indistinguishable on disk from "never
 *  touched". Nothing here reaches jarvis.yaml on its own — like every other
 *  field in this file, it only changes what Save would write. */
function applyDefaultBindSelection(): void {
  if (draft === undefined || draft.remote.bindAddress !== DEFAULT_BIND_ADDRESS) return;
  const { tailscale, wifi } = primaryBindChoices(bindChoiceList);
  const preferred = tailscale ?? wifi;
  if (preferred !== undefined) draft.remote.bindAddress = preferred.address;
}

function renderBindChoices(): void {
  if (draft === undefined) return;
  const address = draft.remote.bindAddress;
  const container = $("settings-remote-choices");
  // Arrow-key navigation drives this group one radio at a time; each change
  // rebuilds it from scratch, so without this the second arrow press has
  // nothing to move because focus already fell to <body>. Scoped to an
  // actual radio (M3 Minor A): `container.contains(activeElement)` used to
  // be true for the "Other…" text field too (it lives inside this same
  // container), which stole focus away from that field back onto a radio
  // the instant it rebuilt — see the sibling check below for that field.
  const activeElement = document.activeElement;
  const hadFocusInGroup =
    activeElement instanceof HTMLInputElement &&
    activeElement.type === "radio" &&
    container.contains(activeElement);
  const hadFocusInOtherField =
    activeElement instanceof HTMLInputElement &&
    activeElement.dataset["field"] === "bindAddress" &&
    container.contains(activeElement);
  container.replaceChildren();

  const { tailscale, wifi, rest } = primaryBindChoices(bindChoiceList);
  const listed = bindChoiceList.some((choice) => choice.address === address);
  const otherChecked = otherBindPicked || !listed;

  const tailscaleChecked =
    !otherChecked && tailscale !== undefined && tailscale.address === address;
  const wifiChecked = !otherChecked && wifi !== undefined && wifi.address === address;

  const tailscaleRadio = bindRadio(
    MESSAGES.remoteTailscaleLabel(PRIMARY_LANGUAGE),
    tailscale?.address ?? "",
    tailscaleChecked,
    () => {
      if (draft === undefined || tailscale === undefined) return;
      otherBindPicked = false;
      draft.remote.bindAddress = tailscale.address;
    },
    { disabled: tailscale === undefined, dataChoice: "tailscale" },
  );
  tailscaleRadio.classList.add("settings-remote-choice--primary");
  container.append(tailscaleRadio);
  if (tailscale === undefined) {
    const missing = document.createElement("div");
    missing.className = "settings-note";
    missing.id = "settings-remote-tailscale-missing";
    missing.textContent = MESSAGES.remoteTailscaleMissing(PRIMARY_LANGUAGE);
    container.append(missing);
  }

  const wifiRadio = bindRadio(
    MESSAGES.remoteWifiLabel(PRIMARY_LANGUAGE),
    wifi?.address ?? "",
    wifiChecked,
    () => {
      if (draft === undefined || wifi === undefined) return;
      otherBindPicked = false;
      draft.remote.bindAddress = wifi.address;
    },
    { disabled: wifi === undefined, dataChoice: "wifi" },
  );
  wifiRadio.classList.add("settings-remote-choice--primary");
  container.append(wifiRadio);

  // Everything else — loopback, IPv6, a second interface, Other… — behind
  // one disclosure, open by itself only when the saved address is one of
  // these rather than a primary: a custom or less-common choice should be
  // visible the moment the panel opens, not hunted for.
  const advanced = document.createElement("details");
  advanced.id = "settings-remote-advanced";
  advanced.className = "settings-remote-advanced";
  advanced.open = !tailscaleChecked && !wifiChecked;
  const summary = document.createElement("summary");
  summary.textContent = MESSAGES.remoteAdvancedLabel(PRIMARY_LANGUAGE);
  advanced.append(summary);

  const advancedBody = document.createElement("div");
  advancedBody.className = "settings-remote-advanced-body";

  for (const choice of rest) {
    advancedBody.append(
      bindRadio(
        bindChoiceCaption(choice, PRIMARY_LANGUAGE),
        choice.address,
        !otherChecked && choice.address === address,
        () => {
          if (draft === undefined) return;
          otherBindPicked = false;
          draft.remote.bindAddress = choice.address;
        },
      ),
    );
  }

  // A plain wrapper, not a <label> around both: the address field must not
  // sit inside a label whose implicit click target is the radio — the same
  // reason the Docker picker keeps its <select> out of one.
  const other = document.createElement("div");
  other.className = "settings-remote-other";
  const otherLabel = bindRadio(
    MESSAGES.remoteOtherAddress(PRIMARY_LANGUAGE),
    "",
    otherChecked,
    () => {
      otherBindPicked = true;
    },
    { dataChoice: "other" },
  );

  const field = document.createElement("input");
  field.type = "text";
  field.className = "mono";
  field.autocomplete = "off";
  field.dataset["field"] = "bindAddress";
  field.placeholder = MESSAGES.remoteOtherPlaceholder(PRIMARY_LANGUAGE);
  // The radio beside it is the only labelled control in this row — its own
  // accessible name is "Other…", not "the address", so this field needs one
  // of its own rather than inheriting the radio's.
  field.setAttribute("aria-label", MESSAGES.remoteOtherAddress(PRIMARY_LANGUAGE));
  // An IP literal reads left-to-right regardless of the panel's own
  // direction, same reason the listed choices' address span gets this below.
  field.dir = "ltr";
  field.value = otherChecked ? address : "";
  field.disabled = !otherChecked;
  field.addEventListener("change", () => {
    if (draft === undefined) return;
    const typed = field.value.trim();
    // An emptied field is not an address, so the last one stands — and the
    // field must show that, the same snap-back the port field does, so the
    // panel never displays an address different from the one it will save.
    // A hostname is committed and refused by Save's one validation pass,
    // with the reason — parseConfig owns the IP-literal rule, not this field.
    if (typed === "") {
      field.value = draft.remote.bindAddress;
      return;
    }
    draft.remote.bindAddress = typed;
    clearSaveStatus();
    renderBindChoices();
  });
  other.append(otherLabel, field);
  advancedBody.append(other);
  advanced.append(advancedBody);
  container.append(advanced);

  if (hadFocusInGroup) {
    container.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  } else if (hadFocusInOtherField) {
    field.focus();
  }

  const allNote = $("settings-remote-all-note");
  allNote.textContent = MESSAGES.remoteAllInterfaces(PRIMARY_LANGUAGE);
  allNote.hidden = !isEveryInterfaceAddress(address);

  // The Tailscale hint depends on bindAddress, which this function just
  // possibly changed — kept live as the picker is used, not only at open.
  renderRemoteCertRow();
}

/** One radio in the picker, with its label and (for a listed choice) the
 *  address itself, which is the thing a user actually recognises. `caption`
 *  is a string for a plain label (the two primaries, "Other…") or a Node for
 *  a listed choice in Advanced…, whose caption isolates the OS-given
 *  interface name (bindChoiceCaption). */
function bindRadio(
  caption: string | Node,
  address: string,
  checked: boolean,
  onPick: () => void,
  options?: { disabled?: boolean; dataChoice?: string },
): HTMLElement {
  const label = document.createElement("label");
  label.className = "settings-remote-choice";
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "settings-remote-bind";
  radio.value = address;
  radio.checked = checked;
  radio.disabled = options?.disabled ?? false;
  if (options?.dataChoice !== undefined) radio.dataset["choice"] = options.dataChoice;
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    onPick();
    clearSaveStatus();
    renderBindChoices();
  });
  const text = document.createElement("span");
  if (typeof caption === "string") text.textContent = caption;
  else text.append(caption);
  label.append(radio, text);
  if (address !== "") {
    const shown = document.createElement("span");
    shown.className = "mono";
    // An IPv6 literal is long and reads left-to-right; without this an
    // Arabic label around it can reorder it visually.
    shown.dir = "ltr";
    shown.textContent = address;
    label.append(shown);
  }
  return label;
}

/** A choice's caption, with its OS-given interface name bidi-isolated: a
 *  Latin adapter name ("vEthernet (WSL)") that ends in digits or punctuation
 *  can otherwise reorder visually inside the Arabic label around it. Built
 *  from `remoteBindChoiceLabel(kind, "", language)` (the name alone) plus the
 *  same " — iface" join messages.ts uses, so the combined text matches
 *  MESSAGES.remoteBindChoiceLabel(kind, iface, language) exactly. */
function bindChoiceCaption(choice: BindChoice, language: "ar" | "en"): Node {
  // remoteBindChoiceLabel ignores iface entirely for "loopback" (always
  // "This machine only"/"هذا الجهاز فقط"), so there is no iface name to
  // isolate — matching that here keeps the reconstructed text identical to
  // calling remoteBindChoiceLabel(kind, iface, language) directly.
  if (choice.kind === "loopback" || choice.iface === "") {
    return document.createTextNode(
      MESSAGES.remoteBindChoiceLabel(choice.kind, choice.iface, language),
    );
  }
  const fragment = document.createDocumentFragment();
  fragment.append(
    document.createTextNode(`${MESSAGES.remoteBindChoiceLabel(choice.kind, "", language)} — `),
  );
  const iface = document.createElement("bdi");
  iface.textContent = choice.iface;
  fragment.append(iface);
  return fragment;
}

/** Devices are milestone 4's devices.json, and deliberately not jarvis.yaml
 *  (a Settings save rewrites that file wholesale) — RemoteStatus.devices is
 *  the only source for this list. */
function renderPairedDevices(): void {
  const status = remoteStatusCache ?? DEFAULT_REMOTE_STATUS;
  const container = $("settings-remote-devices");

  if (status.devices.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-note";
    empty.textContent = MESSAGES.remoteNoDevices(PRIMARY_LANGUAGE);
    container.replaceChildren(empty);
    return;
  }

  container.replaceChildren(...status.devices.map((device) => deviceRow(device)));
}

function deviceRow(device: RemoteDeviceStatus): HTMLElement {
  const language = PRIMARY_LANGUAGE;
  const row = document.createElement("div");
  row.className = "settings-row";

  const name = document.createElement("bdi");
  name.textContent = device.name;
  row.append(name);

  const state = document.createElement("span");
  state.className = "settings-note";
  state.textContent = device.connected
    ? MESSAGES.remoteDeviceConnected(language)
    : device.lastSeenAt !== undefined
      ? MESSAGES.remoteDeviceLastSeen(device.lastSeenAt, language)
      : MESSAGES.remoteDeviceNeverSeen(language);
  row.append(state);

  // Ruling h: a third note, only when this device has actually registered
  // for push — never an empty node for one that hasn't (platform-only,
  // mirroring RemoteDeviceStatus.push; the token itself never reaches here).
  if (device.push !== undefined) {
    const push = document.createElement("span");
    push.className = "settings-note";
    push.textContent = MESSAGES.remoteDevicePush(device.push, language);
    row.append(push);
  }

  const failure = document.createElement("span");
  failure.className = "settings-note settings-note--warning";

  const revoke = document.createElement("button");
  revoke.type = "button";
  // Danger, not the neutral "+ Add" styling every other .settings-add
  // button carries — board 5's PAIRED DEVICES card draws this one outlined
  // in the danger colour, since unlike an add it cannot be undone.
  revoke.className = "settings-add settings-add--danger";
  revoke.textContent = MESSAGES.remoteRevoke(language);
  revoke.addEventListener("click", () => {
    // Disabled for the round trip: a second click before the first
    // resolves would revoke the same device twice (harmless on the bridge
    // side, but a stray double-request over IPC for no reason).
    revoke.disabled = true;
    void window.jarvis
      .revokeRemoteDevice(device.id)
      .then((result) => {
        if (!result.ok) {
          failure.textContent = result.text;
          revoke.disabled = false;
        }
        // A success re-renders via the next RemoteStatus push (the device
        // drops out of the list), so the button is left disabled rather
        // than re-enabled on a row that is about to disappear.
      })
      .catch((error: unknown) => {
        console.error(`settings: revokeRemoteDevice failed: ${String(error)}`);
        revoke.disabled = false;
      });
  });
  row.append(revoke, failure);

  return row;
}

async function loadBindChoices(): Promise<void> {
  try {
    bindChoiceList = await window.jarvis.remoteBindChoices();
  } catch {
    // Without a listing the configured address still shows, under "Other…":
    // the picker degrades rather than the route breaking.
    bindChoiceList = [];
  }
  applyDefaultBindSelection();
  renderBindChoices();
}

// "Every interface" — the many spellings meaning "listen on all of them",
// which net.isIP accepts (0.0.0.0, ::, ::ffff:0.0.0.0, a fully spelled
// 0:0:0:0:0:0:0:0, and less common ones such as ::0.0.0.0 or
// 0:0:0:0:0:ffff:0.0.0.0 among them). The renderer can't import node:net
// (renderer/no-value-imports.test.ts bars a value import from any workspace
// package that wraps it, and this is Node core besides), so the spellings
// that matter are recognised by hand from a normalised address.
function isEveryInterfaceAddress(address: string): boolean {
  const bare = address.split("%")[0] ?? ""; // a zone id names the interface, not the address
  if (isZeroIPv4(bare)) return true;
  const groups = expandIPv6(bare);
  if (groups === undefined) return false;
  if (groups.every((group) => group === 0)) return true;
  // The IPv4-mapped unspecified address, ::ffff:0.0.0.0 and its equivalent
  // spellings: the mapping marker (0xffff) in group 5 is deliberately
  // non-zero, so it needs its own check rather than falling out of the
  // plain "every group is zero" one above.
  return (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff &&
    groups[6] === 0 &&
    groups[7] === 0
  );
}

function isZeroIPv4(address: string): boolean {
  const octets = address.split(".");
  return (
    octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) === 0)
  );
}

/** The address's eight 16-bit groups if it is IPv6-shaped, expanding a "::"
 *  run into position and a trailing IPv4-mapped dotted quad (as in
 *  "::ffff:0.0.0.0" or "0:0:0:0:0:0:0.0.0.0") into its two 16-bit halves;
 *  undefined for anything else, including malformed input — this never
 *  throws. Unlike an "is every group zero" check, the IPv4-mapped check
 *  above cares which group is which, so — unlike an earlier version of this
 *  function — the zero-fill for "::" is spliced into its real position,
 *  not merely appended. */
function expandIPv6(address: string): number[] | undefined {
  if (!address.includes(":")) return undefined;
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const compressed = halves.length === 2;

  const splitHex = (part: string | undefined): string[] =>
    part === undefined || part === "" ? [] : part.split(":");
  const head = splitHex(halves[0]);
  const tail = splitHex(halves[1]);

  // A mapped IPv4 dotted quad is always the address's final token, so it is
  // the last token of whichever half is written last: tail when compressed
  // (and non-empty), head otherwise.
  const dest = tail.length > 0 ? tail : head;
  const lastToken = dest.at(-1);
  if (lastToken?.includes(".")) {
    const mapped = ipv4ToHextets(lastToken);
    if (mapped === undefined) return undefined;
    dest.splice(dest.length - 1, 1, ...mapped);
  }

  if (![...head, ...tail].every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return undefined;
  const missing = 8 - head.length - tail.length;
  if (compressed ? missing < 1 : missing !== 0) return undefined;
  const zeros = Array<string>(compressed ? missing : 0).fill("0");
  return [...head, ...zeros, ...tail].map((group) => Number.parseInt(group, 16));
}

/** A dotted IPv4 quad's two 16-bit words, or undefined if it is not one. */
function ipv4ToHextets(dotted: string): [string, string] | undefined {
  const octets = dotted.split(".");
  if (
    octets.length !== 4 ||
    !octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  ) {
    return undefined;
  }
  const [a = 0, b = 0, c = 0, d = 0] = octets.map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

// --------------------------------------------------------- Save / restart

export async function saveSettings(): Promise<void> {
  if (draft === undefined) return;
  // These services are constructed at startup. Their running instances cannot
  // safely be swapped by mutating the config object, so keep the restart
  // affordance only when one of their inputs actually changed.
  const restartKeys = [
    "brain",
    "voice",
    "whisper",
    "terminal",
    "performance",
    "sessions",
    "headlamp",
  ] as const;
  const baseline = savedBaseline;
  const restartRequired =
    baseline !== undefined &&
    restartKeys.some((key) => JSON.stringify(baseline[key]) !== JSON.stringify(draft?.[key]));
  const result = await window.jarvis.saveSettings(draft);
  const status = $("settings-status");
  if (!result.ok) {
    status.textContent = `${result.text} ${result.detail}`;
    status.classList.add("settings-status--error");
    return;
  }
  status.textContent = restartRequired
    ? MESSAGES.settingsSavedRestart(PRIMARY_LANGUAGE)
    : MESSAGES.settingsSavedLive(PRIMARY_LANGUAGE);
  status.classList.remove("settings-status--error");
  ($("settings-restart") as HTMLElement).hidden = !restartRequired;
  savedBaseline = structuredClone(draft);
  window.dispatchEvent(new Event("jarvis:settings-saved"));
}

export async function savePrayerSettings(prayer: JarvisConfig["prayer"]): Promise<void> {
  if (draft === undefined) return;
  draft.prayer = prayer;
  clearSaveStatus();
}

// Wired once, the first time Settings is ever opened — these are static
// single fields and the section's own add buttons, not rebuilt per render
// the way each section's rows are.
function wireStaticFields(): void {
  $("settings-brain-cwd").addEventListener("change", () => {
    if (draft === undefined) return;
    draft.brain.cwd = ($("settings-brain-cwd") as HTMLInputElement).value;
    clearSaveStatus();
  });
  $("settings-brain-prompt").addEventListener("change", () => {
    if (draft === undefined) return;
    draft.brain.systemPrompt = ($("settings-brain-prompt") as HTMLTextAreaElement).value;
    clearSaveStatus();
  });
  $("settings-brain-account").addEventListener("change", () => {
    if (draft === undefined) return;
    const value = ($("settings-brain-account") as HTMLSelectElement).value;
    if (value === "") {
      delete draft.brain.accountId;
      delete draft.brain.configDir;
    } else {
      draft.brain.accountId = value;
      draft.brain.configDir = draft.registry.agents[value]?.configDir;
    }
    clearSaveStatus();
  });

  $("settings-whisper-binary").addEventListener("change", () => {
    if (draft === undefined) return;
    draft.whisper.binaryPath = ($("settings-whisper-binary") as HTMLInputElement).value;
    clearSaveStatus();
  });
  $("settings-whisper-model").addEventListener("change", () => {
    if (draft === undefined) return;
    draft.whisper.modelPath = ($("settings-whisper-model") as HTMLInputElement).value;
    clearSaveStatus();
  });

  $("settings-voice-en").addEventListener("change", () => {
    if (draft === undefined) return;
    const chosen = ($("settings-voice-en") as HTMLSelectElement).value;
    const voice = installedVoices.find((entry) => entry.name === chosen);
    // Choosing a voice is what chooses the engine; there is no second switch
    // to get out of step with the name on screen.
    draft.voice.engine = voice?.engine ?? "say";
    if (draft.voice.engine === "say") draft.voice.englishVoice = chosen;
    clearSaveStatus();
  });
  $("settings-voice-ar").addEventListener("change", () => {
    if (draft === undefined) return;
    draft.voice.arabicVoice = ($("settings-voice-ar") as HTMLSelectElement).value;
    clearSaveStatus();
  });
  $("settings-voice-en-play").addEventListener("click", () =>
    previewVoice("settings-voice-en", "en"),
  );
  $("settings-voice-ar-play").addEventListener("click", () =>
    previewVoice("settings-voice-ar", "ar"),
  );
  $("settings-allow-popups").addEventListener("change", () => {
    if (draft === undefined) return;
    draft.browser.allowPopups = ($("settings-allow-popups") as HTMLInputElement).checked;
    clearSaveStatus();
  });
  $("settings-browser-homepage").addEventListener("change", () => {
    if (draft === undefined) return;
    const value = ($("settings-browser-homepage") as HTMLInputElement).value.trim();
    if (value === "") delete draft.browser.homePage;
    else draft.browser.homePage = value;
    clearSaveStatus();
  });
  $("settings-speak-greeting").addEventListener("change", () => {
    if (draft === undefined) return;
    draft.voice.speakGreeting = ($("settings-speak-greeting") as HTMLInputElement).checked;
    clearSaveStatus();
  });
  $("settings-greeting-en").addEventListener("change", () => {
    if (draft === undefined) return;
    draft.voice.greeting.en = ($("settings-greeting-en") as HTMLTextAreaElement).value;
    clearSaveStatus();
  });
  $("settings-greeting-ar").addEventListener("change", () => {
    if (draft === undefined) return;
    draft.voice.greeting.ar = ($("settings-greeting-ar") as HTMLTextAreaElement).value;
    clearSaveStatus();
  });

  $("settings-remote-enabled").addEventListener("change", () => {
    if (draft === undefined) return;
    draft.remote.enabled = ($("settings-remote-enabled") as HTMLInputElement).checked;
    $("settings-remote-state").textContent = MESSAGES.remoteState(
      draft.remote.enabled,
      PRIMARY_LANGUAGE,
    );
    clearSaveStatus();
  });
  $("settings-remote-port").addEventListener("change", () => {
    if (draft === undefined) return;
    const field = $("settings-remote-port") as HTMLInputElement;
    const typed = field.value.trim();
    const port = Number(typed);
    // A database row's port follows the same rule: a half-typed value is not
    // written into the draft as NaN. A number out of range is committed and
    // refused by Save's validation, which names the allowed range.
    if (typed !== "" && Number.isFinite(port)) draft.remote.port = port;
    field.value = String(draft.remote.port);
    clearSaveStatus();
  });
  $("settings-remote-proxy").addEventListener("change", () => {
    if (draft === undefined) return;
    draft.remote.sidecarProxy = ($("settings-remote-proxy") as HTMLInputElement).checked;
    clearSaveStatus();
  });
  $("settings-remote-cert-button").addEventListener("click", () => {
    if (draft === undefined || certBusy) return;
    const isRenew = draft.remote.tls.certPath !== undefined;
    certBusy = true;
    clearRemoteCertError();
    const button = $("settings-remote-cert-button") as HTMLButtonElement;
    button.disabled = true;
    button.textContent = MESSAGES.remoteCertBusy(isRenew ? "renew" : "get", PRIMARY_LANGUAGE);
    void window.jarvis
      .tailscaleCert()
      .then(async (result) => {
        certBusy = false;
        if (result.ok) {
          // The channel already wrote remote.tls and remote.sidecarProxy
          // to disk (dispatch.ts) — the draft in memory here is now stale
          // for exactly those two fields, so it is replaced wholesale from
          // the file rather than patched, the same freshness rule every
          // other cross-process write in this app (a Settings save itself)
          // already follows.
          draft = await window.jarvis.getSettings();
          savedBaseline = structuredClone(draft);
          renderRemote();
          return;
        }
        renderRemoteCertError(result);
        renderRemoteCertRow();
      })
      .catch((error: unknown) => {
        console.error(`settings: tailscaleCert failed: ${String(error)}`);
        certBusy = false;
        renderRemoteCertRow();
      });
  });
  $("settings-remote-push").addEventListener("change", () => {
    if (draft === undefined) return;
    draft.remote.push.enabled = ($("settings-remote-push") as HTMLInputElement).checked;
    clearSaveStatus();
  });
  $("settings-remote-idle").addEventListener("change", () => {
    if (draft === undefined) return;
    const field = $("settings-remote-idle") as HTMLInputElement;
    const typed = field.value.trim();
    const minutes = Number(typed);
    // Same rule as the port field: a half-typed value never becomes NaN in
    // the draft. Range and integer-ness are Save's own validation, whose
    // message names the allowed range (0 to IDLE_DISABLE_MAX_MINUTES).
    if (typed !== "" && Number.isFinite(minutes)) draft.remote.idleDisableMinutes = minutes;
    field.value = String(draft.remote.idleDisableMinutes);
    clearSaveStatus();
  });
  // Ruling b: left enabled even while push itself is off — the note beside
  // it (remotePushProjectsNote) explains that an off setting still means
  // nothing, since no notification is sent for it to affect.
  $("settings-remote-push-projects").addEventListener("change", () => {
    if (draft === undefined) return;
    draft.remote.push.includeProjectNames = (
      $("settings-remote-push-projects") as HTMLInputElement
    ).checked;
    clearSaveStatus();
  });
  $("settings-remote-new-code").addEventListener("click", () => {
    void window.jarvis
      .openRemotePairing()
      .then((result) => {
        if (!result.ok) $("settings-remote-pair-note").textContent = result.text;
      })
      .catch((error: unknown) => {
        console.error(`settings: openRemotePairing failed: ${String(error)}`);
      });
  });
  $("settings-remote-pair-cancel").addEventListener("click", () => {
    void window.jarvis.cancelRemotePairing().catch((error: unknown) => {
      console.error(`settings: cancelRemotePairing failed: ${String(error)}`);
    });
  });

  $("settings-agent-add").addEventListener("click", () => {
    addAgent();
    clearSaveStatus();
  });
  $("settings-routing-add").addEventListener("click", () => {
    addRoutingRule();
    clearSaveStatus();
  });
  $("settings-project-add").addEventListener("click", () => {
    addProject();
    clearSaveStatus();
  });
  $("settings-database-add").addEventListener("click", () => {
    addConnection();
    clearSaveStatus();
  });
  $("settings-editor-add").addEventListener("click", () => {
    addEditorRoot();
    clearSaveStatus();
  });
  $("settings-docker-add").addEventListener("click", () => {
    addDockerEntry();
    clearSaveStatus();
  });
  $("settings-docker-autopopulate").addEventListener("click", () => void autopopulateDocker());
  $("settings-chat-add").addEventListener("click", () => {
    addChatEntry();
    clearSaveStatus();
  });

  $("settings-save").addEventListener("click", () => void saveSettings());
  $("settings-restart").addEventListener("click", () => void window.jarvis.restartApp());
}
