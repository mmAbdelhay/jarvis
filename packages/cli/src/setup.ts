// `jarvis setup` (Rafiq M2.5 contracts §1, §5): the ordered provider list Jarvis
// fails over through, and the cloud-fallback switch. Keys are typed with no
// echo, kept only in this process until the save, and sent only for new
// providers (a draft without apiKey keeps that id's stored key, M1 §6 #10).
import { execFileSync } from "node:child_process";
import type { ControlClient } from "../../desktop/src/daemon/control/client.js";
import { terminalLine } from "./sanitize.js";
import type { Terminal } from "./terminal.js";
import { messageOf } from "./turn.js";

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DEFAULT_KINDS = ["anthropic", "openai-compatible", "ollama", "gemini"];
const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  anthropic: "https://api.anthropic.com",
  ollama: "http://127.0.0.1:11434",
  gemini: "https://generativelanguage.googleapis.com",
};
const KIND_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI-compatible server",
  ollama: "Ollama",
  gemini: "Gemini",
};

export type ProviderRow = {
  id: string;
  kind: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  apiKey?: string;
};
export type SetupState = {
  providers: ProviderRow[];
  allowCloudFallback: boolean;
  kinds: string[];
  dirty: boolean;
};
type Probe = { ok: boolean; supportsTools: boolean; models: string[]; error?: string };
type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseProviderList(value: unknown): SetupState {
  const state: SetupState = {
    providers: [],
    allowCloudFallback: false,
    kinds: DEFAULT_KINDS,
    dirty: false,
  };
  if (!isFields(value)) return state;
  if (Array.isArray(value.kinds)) {
    const kinds = value.kinds.filter((kind): kind is string => typeof kind === "string");
    if (kinds.length > 0) state.kinds = kinds;
  }
  state.allowCloudFallback = value.allowCloudFallback === true;
  if (Array.isArray(value.providers)) {
    for (const raw of value.providers) {
      if (!isFields(raw)) continue;
      const { id, kind, baseUrl, model, hasKey } = raw;
      if (typeof id !== "string" || typeof kind !== "string") continue;
      if (typeof baseUrl !== "string" || typeof model !== "string") continue;
      state.providers.push({ id, kind, baseUrl, model, hasKey: hasKey === true });
    }
  }
  return state;
}

export function savePayload(state: SetupState) {
  return {
    providers: state.providers.map(({ id, kind, baseUrl, model, apiKey }) => ({
      id,
      kind,
      baseUrl,
      model,
      ...(apiKey ? { apiKey } : {}),
    })),
    allowCloudFallback: state.allowCloudFallback,
  };
}

export function renderProviders(state: SetupState): string {
  const lines: string[] = [];
  if (state.providers.length === 0) lines.push("No providers yet. Type a to add one.");
  else lines.push("Jarvis tries these in order:");
  state.providers.forEach((row, index) => {
    const key = row.hasKey || row.apiKey ? " · key saved" : "";
    lines.push(
      `  ${index + 1}. ${terminalLine(row.id)} — ${terminalLine(row.kind)} · ${terminalLine(row.model)} · ${terminalLine(row.baseUrl)}${key}`,
    );
  });
  lines.push(
    `Cloud fallback from local or network providers: ${state.allowCloudFallback ? "on" : "off"}`,
  );
  if (state.dirty) lines.push("(not saved yet)");
  lines.push("Commands: a add · r N remove · u N move up · f fallback on/off · s save · q quit");
  return `${lines.join("\n")}\n`;
}

export function removeAt(
  state: SetupState,
  index: number,
): { state: SetupState; message?: string } {
  if (state.providers[index] === undefined) {
    return { state, message: "There is no provider with that number." };
  }
  if (state.providers.length === 1)
    return { state, message: "Jarvis needs at least one provider." };
  return {
    state: { ...state, providers: state.providers.filter((_, i) => i !== index), dirty: true },
  };
}

export function moveUp(state: SetupState, index: number): { state: SetupState; message?: string } {
  const moving = state.providers[index];
  if (moving === undefined) return { state, message: "There is no provider with that number." };
  const above = state.providers[index - 1];
  if (above === undefined) return { state, message: "That one is already first." };
  const providers = [...state.providers];
  providers[index - 1] = moving;
  providers[index] = above;
  return { state: { ...state, providers, dirty: true } };
}

export const ADMINS_GROUP = "jarvis-admins";
export const ADMINS_HINT = `To let Jarvis change this computer, run: sudo usermod -aG ${ADMINS_GROUP} $USER\nThen log out and back in.\n`;

// True when the current user already belongs to jarvis-admins (contracts §7.14).
// If the groups can't be read we stay quiet rather than print a wrong hint.
export function inAdminsGroup(): boolean {
  try {
    const groups = execFileSync("id", ["-Gn"], { encoding: "utf8", timeout: 2000 });
    return groups.split(/\s+/).includes(ADMINS_GROUP);
  } catch {
    return true;
  }
}

export async function setup(
  client: ControlClient,
  term: Terminal,
  isAdmin: () => boolean = inAdminsGroup,
): Promise<number> {
  if (!term.interactive) {
    term.write("jarvis setup needs an interactive terminal.\n");
    return 2;
  }
  let state = parseProviderList(await client.invoke("provider:list", []));
  term.write(renderProviders(state));
  if (!isAdmin()) term.write(ADMINS_HINT);
  for (;;) {
    const line = await term.readLine("setup › ");
    if (line === null) return 0;
    const [verb = "", arg = ""] = line.trim().toLowerCase().split(/\s+/);
    const index = Number(arg) - 1;
    let message: string | undefined;
    switch (verb) {
      case "":
        continue;
      case "a": {
        const added = await addProvider(client, term, state);
        if (added !== null) {
          state = { ...state, providers: [...state.providers, added], dirty: true };
        }
        break;
      }
      case "r":
        ({ state, message } = removeAt(state, index));
        break;
      case "u":
        ({ state, message } = moveUp(state, index));
        break;
      case "f":
        state = { ...state, allowCloudFallback: !state.allowCloudFallback, dirty: true };
        break;
      case "s":
        if (await save(client, term, state)) {
          state = parseProviderList(await client.invoke("provider:list", []));
        }
        break;
      case "q": {
        if (!state.dirty) return 0;
        const sure = await term.readLine("Quit without saving? [y/N] ");
        if (sure !== null && sure.trim().toLowerCase() === "y") return 0;
        break;
      }
      default:
        term.write("Type a, r N, u N, f, s or q.\n");
        continue;
    }
    if (message !== undefined) term.write(`${message}\n`);
    term.write(renderProviders(state));
  }
}

async function askId(term: Terminal, state: SetupState): Promise<string | null> {
  for (;;) {
    const answer = await term.readLine("Name for this provider (e.g. home, work): ");
    if (answer === null) return null;
    const id = answer.trim();
    if (!PROVIDER_ID_PATTERN.test(id)) {
      term.write("Use lowercase letters, digits and dashes, up to 32 characters.\n");
      continue;
    }
    if (state.providers.some((row) => row.id === id)) {
      term.write(`${id} is already in the list.\n`);
      continue;
    }
    return id;
  }
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function probe(client: ControlClient, draft: Fields): Promise<Probe> {
  try {
    const result = await client.invoke("provider:probe", [draft]);
    if (!isFields(result))
      return { ok: false, supportsTools: false, models: [], error: "no answer" };
    const models = Array.isArray(result.models)
      ? result.models.filter((m): m is string => typeof m === "string" && m !== "")
      : [];
    return {
      ok: result.ok === true,
      supportsTools: result.supportsTools === true,
      models,
      ...(typeof result.error === "string" ? { error: result.error } : {}),
    };
  } catch (error) {
    return { ok: false, supportsTools: false, models: [], error: messageOf(error) };
  }
}

async function addProvider(
  client: ControlClient,
  term: Terminal,
  state: SetupState,
): Promise<ProviderRow | null> {
  const id = await askId(term, state);
  if (id === null) return null;
  term.write(
    `${state.kinds.map((kind, i) => `  ${i + 1}. ${KIND_LABELS[kind] ?? kind}`).join("\n")}\n`,
  );
  const kindAnswer = await term.readLine("Kind [1]: ");
  if (kindAnswer === null) return null;
  const kind = state.kinds[(kindAnswer.trim() === "" ? 1 : Number(kindAnswer.trim())) - 1];
  if (kind === undefined) {
    term.write("There is no kind with that number.\n");
    return null;
  }
  const suggested = DEFAULT_BASE_URLS[kind] ?? "";
  const urlAnswer = await term.readLine(suggested ? `Address [${suggested}]: ` : "Address: ");
  if (urlAnswer === null) return null;
  const baseUrl = urlAnswer.trim() || suggested;
  if (!isHttpUrl(baseUrl)) {
    term.write("That isn't an http:// or https:// address.\n");
    return null;
  }
  let apiKey: string | undefined;
  if (kind !== "ollama") {
    const key = await term.readSecret("API key (hidden; leave empty for none): ");
    if (key === null) return null;
    apiKey = key === "" ? undefined : key;
  }
  const withKey = apiKey ? { apiKey } : {};
  const listed = await probe(client, { kind, baseUrl, model: "", ...withKey });
  if (listed.models.length === 0 && listed.error) {
    term.write(`Couldn't list models: ${terminalLine(listed.error)}\n`);
  }
  if (listed.models.length > 0) {
    term.write(`${listed.models.map((m, i) => `  ${i + 1}. ${terminalLine(m)}`).join("\n")}\n`);
  }
  const modelAnswer = await term.readLine(
    listed.models.length > 0 ? "Model [1]: " : "Model name: ",
  );
  if (modelAnswer === null) return null;
  const picked = modelAnswer.trim();
  const model =
    picked === ""
      ? (listed.models[0] ?? "")
      : /^\d+$/.test(picked)
        ? (listed.models[Number(picked) - 1] ?? "")
        : picked;
  if (model === "") {
    term.write("No model chosen.\n");
    return null;
  }
  const checked = await probe(client, { kind, baseUrl, model, ...withKey });
  if (!checked.ok) {
    term.write(
      `Couldn't use ${terminalLine(model)}: ${terminalLine(checked.error ?? "unknown error")}\n`,
    );
    return null;
  }
  term.write(
    checked.supportsTools
      ? "Connected. Tool calling works.\n"
      : `Connected, but ${terminalLine(model)} can't call tools: Jarvis can chat but can't change this computer.\n`,
  );
  return { id, kind, baseUrl, model, hasKey: apiKey !== undefined, ...withKey };
}

async function save(client: ControlClient, term: Terminal, state: SetupState): Promise<boolean> {
  let result: unknown;
  try {
    result = await client.invoke("provider:save", [savePayload(state)]);
  } catch (error) {
    term.write(`Couldn't save: ${terminalLine(messageOf(error))}\n`);
    return false;
  }
  const ok = isFields(result) && result.ok === true;
  const results = isFields(result) && isFields(result.results) ? result.results : {};
  for (const row of state.providers) {
    const probed = results[row.id];
    if (!isFields(probed)) continue;
    const text =
      probed.ok === true
        ? probed.supportsTools === true
          ? "ok"
          : "ok, but no tool calling"
        : terminalLine(typeof probed.error === "string" ? probed.error : "failed");
    term.write(`  ${terminalLine(row.id)}: ${text}\n`);
  }
  term.write(ok ? "Saved. Jarvis tries these in order.\n" : "Nothing was saved.\n");
  return ok;
}
