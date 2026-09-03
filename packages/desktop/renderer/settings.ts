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

/** Called once, at app start (app.ts), same as initWorkspace — wires the
 *  static single-field controls and the three "+ Add" buttons. openSettings
 *  (below) only ever fetches and renders; it is called every time the
 *  Settings nav button is clicked, and must never re-attach listeners to
 *  elements that already have them. */
export function initSettings(): void {
  wireStaticFields();
}

export async function openSettings(): Promise<void> {
  clearSaveStatus();
  draft = await window.jarvis.getSettings();
  renderSettings();
  // Re-read every time rather than once: a voice installed in System
  // Settings while Jarvis is open should appear the next time this route is
  // opened, not the next time the app restarts. After the first render, so
  // the section appears immediately and fills in when the listing arrives.
  void loadVoices();
}

function renderSettings(): void {
  if (draft === undefined) return;
  renderAgents();
  renderRouting();
  renderProjects();
  renderDatabases();
  renderEditors();
  renderDocker();
  renderChat();
  renderBrain();
  renderVoice();
  renderWhisper();
}

function clearSaveStatus(): void {
  const status = $("settings-status");
  status.textContent = "";
  status.classList.remove("settings-status--error");
  ($("settings-restart") as HTMLElement).hidden = true;
}

/** One labelled text field, committing on change (blur/Enter), not on
 *  every keystroke. */
function fieldInput(labelText: string, value: string, onChange: (value: string) => void): HTMLElement {
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
  const commandField = fieldInput("command", agent.command, (value) => updateAgent(id, { command: value }));
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
    updateAgent(id, { vendor: vendorSelect.value === "" ? undefined : (vendorSelect.value as ProviderVendor) });
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
  (draft.registry.routing ?? []).forEach((rule, index) => container.append(renderRoutingRow(rule, index)));
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

  row.append(projectField, intentField, agentLabel, spacer(), removeControl(() => removeRoutingRule(index)));
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
  row.append(nameField, pathField, spacer(), removeControl(() => removeProject(name)));
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

function renderConnectionRow(project: string, index: number, connection: DbGateConnection): HTMLElement {
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
  const portField = fieldInput("port", connection.port === undefined ? "" : String(connection.port), (value) => {
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
  });
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

  row.append(projectField, nameField, pathField, spacer(), removeControl(() => removeEditorRoot(project, index)));
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
    const projectField = fieldSelect("project", entry.project, Object.keys(draft.projects), (value) => {
      entry.project = value;
    });
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
  ($("settings-chat-add") as HTMLButtonElement).disabled =
    Object.keys(draft.projects).length === 0;
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
let installedVoices: { name: string; language: string; upgraded: boolean; engine: "piper" | "say" }[] =
  [];

/** Which entry the English picker should be showing: the neural engine when
 *  it is selected, otherwise the configured `say` voice. The picker is the
 *  single control — choosing a voice is what chooses the engine. */
function selectedEnglishVoice(): string {
  if (draft === undefined) return "";
  if (draft.voice.engine === "piper") {
    return installedVoices.find((voice) => voice.engine === "piper")?.name ?? draft.voice.englishVoice;
  }
  return draft.voice.englishVoice;
}

function renderVoice(): void {
  if (draft === undefined) return;
  fillVoiceSelect("settings-voice-en", "en", selectedEnglishVoice());
  fillVoiceSelect("settings-voice-ar", "ar", draft.voice.arabicVoice);
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

// --------------------------------------------------------- Save / restart

async function saveSettings(): Promise<void> {
  if (draft === undefined) return;
  const result = await window.jarvis.saveSettings(draft);
  const status = $("settings-status");
  if (!result.ok) {
    status.textContent = `${result.text} ${result.detail}`;
    status.classList.add("settings-status--error");
    return;
  }
  status.textContent = MESSAGES.settingsSaved(PRIMARY_LANGUAGE);
  status.classList.remove("settings-status--error");
  ($("settings-restart") as HTMLElement).hidden = false;
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
  $("settings-voice-en-play").addEventListener("click", () => previewVoice("settings-voice-en", "en"));
  $("settings-voice-ar-play").addEventListener("click", () => previewVoice("settings-voice-ar", "ar"));
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
