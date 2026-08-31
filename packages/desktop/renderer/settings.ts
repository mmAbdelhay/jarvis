import type { AgentConfig, ProviderVendor, RoutingRule } from "@jarvis/core";
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
}

function renderSettings(): void {
  if (draft === undefined) return;
  renderAgents();
  renderRouting();
  renderProjects();
  renderBrain();
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
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.addEventListener("change", () => {
    onChange(input.value);
    clearSaveStatus();
  });
  label.append(input);
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
  renderSettings();
}

function removeProject(name: string): void {
  if (draft === undefined) return;
  delete draft.projects[name];
}

function addProject(): void {
  if (draft === undefined) return;
  let n = 1;
  while (draft.projects[`new-project-${n}`] !== undefined) n += 1;
  draft.projects[`new-project-${n}`] = "";
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

  $("settings-save").addEventListener("click", () => void saveSettings());
  $("settings-restart").addEventListener("click", () => void window.jarvis.restartApp());
}
