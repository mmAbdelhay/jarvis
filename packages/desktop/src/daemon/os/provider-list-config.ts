// jarvis.yaml's `os:` section (M2.5 contracts §1): an ordered provider list
// (first = preferred), the cloud-fallback opt-in and memory.enabled. The
// M1/M2 top-level `provider:` (still written by the M2 installer) migrates on
// read to one entry with id "default"; the first save writes `os.providers`
// and removes it. Keys are never here — they live in the keyring per id.
//
// No electron here (core/no-electron.test.ts).
import { type Lang, parseLang } from "@jarvis/core";
import { MAX_PROVIDERS, PROVIDER_ID_PATTERN, RESERVED_PROVIDER_IDS } from "@jarvis/wire";
import { isMap, isScalar, parse, parseDocument } from "yaml";
import {
  type ComputerUseSettings,
  computerUseNode,
  emptyComputerUse,
  parseComputerUse,
} from "./cu-config.js";
import { type ConfigIo, type ProviderSection, parseProviderSection } from "./provider-config.js";

export type ProviderEntry = ProviderSection & { id: string };
export type OsBrainConfig = {
  providers: ProviderEntry[];
  allowCloudFallback: boolean;
  memoryEnabled: boolean;
  language: Lang | null;
  /** v1.1 §2: per-provider computer-use enable and cloud consent. */
  computerUse: ComputerUseSettings;
  /** True when the providers came from the legacy top-level `provider:` key. */
  migratedFromLegacy: boolean;
};

export const LEGACY_PROVIDER_ID = "default";

export function emptyBrain(): OsBrainConfig {
  return {
    providers: [],
    allowCloudFallback: false,
    memoryEnabled: true,
    language: null,
    computerUse: emptyComputerUse(),
    migratedFromLegacy: false,
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isMissing = (error: unknown) => (error as { code?: unknown }).code === "ENOENT";
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

function parseEntry(raw: unknown, index: number, seen: Set<string>): ProviderEntry {
  const where = `Config \`os.providers[${index}]\``;
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  const { id, ...rest } = raw;
  if (typeof id !== "string" || !PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(
      `Config \`os.providers[${index}].id\` must be a-z, 0-9 and -, up to 32 characters`,
    );
  }
  if (RESERVED_PROVIDER_IDS.has(id))
    throw new Error(`${where}.id "${id}" is reserved for the backup model`);
  if (seen.has(id)) throw new Error(`${where}: provider ids must be unique ("${id}" repeats)`);
  seen.add(id);
  let section: ProviderSection | null;
  try {
    section = parseProviderSection(rest);
  } catch (error) {
    throw new Error(`${where}: ${describe(error)}`);
  }
  if (section === null) throw new Error(`${where} must be an object`);
  return { id, ...section };
}

export function parseOsBrainConfig(root: unknown): OsBrainConfig {
  if (!isObject(root)) return emptyBrain();
  const os = root["os"];
  if (os !== undefined && os !== null && !isObject(os))
    throw new Error("Config `os` must be an object");
  const section = isObject(os) ? os : {};
  const allow = section["allowCloudFallback"];
  if (allow !== undefined && typeof allow !== "boolean") {
    throw new Error("Config `os.allowCloudFallback` must be true or false");
  }
  const memory = section["memory"];
  let memoryEnabled = true;
  if (memory !== undefined && memory !== null) {
    if (!isObject(memory)) throw new Error("Config `os.memory` must be an object");
    const enabled = memory["enabled"];
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw new Error("Config `os.memory.enabled` must be true or false");
    }
    memoryEnabled = enabled !== false;
  }
  const base = {
    allowCloudFallback: allow === true,
    memoryEnabled,
    language: parseLang(section["language"]) ?? null,
    computerUse: parseComputerUse(section["computerUse"]),
  };
  const list = section["providers"];
  if (list !== undefined && list !== null) {
    if (!Array.isArray(list)) throw new Error("Config `os.providers` must be a list");
    if (list.length > MAX_PROVIDERS) {
      throw new Error(`Config \`os.providers\` may hold at most ${MAX_PROVIDERS} providers`);
    }
    const seen = new Set<string>();
    return {
      ...base,
      providers: list.map((raw, index) => parseEntry(raw, index, seen)),
      migratedFromLegacy: false,
    };
  }
  const legacy = parseProviderSection(root["provider"]);
  return {
    ...base,
    providers: legacy === null ? [] : [{ id: LEGACY_PROVIDER_ID, ...legacy }],
    migratedFromLegacy: legacy !== null,
  };
}

export async function readOsBrainConfig(path: string, io: ConfigIo): Promise<OsBrainConfig> {
  let text: string;
  try {
    text = await io.readFile(path);
  } catch (error) {
    if (isMissing(error)) return emptyBrain();
    throw error;
  }
  return parseOsBrainConfig(parse(text));
}

function entryValue(entry: ProviderEntry): Record<string, unknown> {
  const value: Record<string, unknown> = {
    id: entry.id,
    kind: entry.kind,
    baseUrl: entry.baseUrl,
    model: entry.model,
  };
  if (entry.kind === "account" && entry.account !== undefined) value["account"] = entry.account;

  if (!entry.supportsTools) value["tools"] = false;
  if (entry.auth === "subscription") value["auth"] = "subscription";
  return value;
}

export async function writeOsProviders(
  path: string,
  value: {
    providers: readonly ProviderEntry[];
    allowCloudFallback: boolean;
    computerUse?: ComputerUseSettings;
  },
  io: ConfigIo,
): Promise<void> {
  let text = "";
  try {
    text = await io.readFile(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new Error(`jarvis.yaml does not parse: ${document.errors[0]?.message ?? "unknown"}`);
  }
  if (!isMap(document.get("os", true))) document.set("os", document.createNode({}));
  document.setIn(["os", "providers"], document.createNode(value.providers.map(entryValue)));
  document.setIn(["os", "allowCloudFallback"], value.allowCloudFallback);
  // v1.1: pruned in the same write as the providers, so a changed endpoint
  // never keeps the old endpoint's consent, even for a moment.
  if (value.computerUse !== undefined) {
    document.setIn(["os", "computerUse"], document.createNode(computerUseNode(value.computerUse)));
  }
  if (document.has("provider")) {
    // A leading comment is attached to the first key; keep it when that key goes.
    const first = isMap(document.contents) ? document.contents.items[0] : undefined;
    const key = first !== undefined && isScalar(first.key) ? first.key : undefined;
    if (key?.value === "provider" && key.commentBefore && !document.commentBefore) {
      document.commentBefore = key.commentBefore;
    }
    document.delete("provider");
  }
  await io.writeFile(path, document.toString());
}

/** Persist os.memory.enabled (contracts §7 #9), keeping the rest of the file. */
export async function writeOsMemoryEnabled(
  path: string,
  enabled: boolean,
  io: ConfigIo,
): Promise<void> {
  let text = "";
  try {
    text = await io.readFile(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new Error(`jarvis.yaml does not parse: ${document.errors[0]?.message ?? "unknown"}`);
  }
  if (!isMap(document.get("os", true))) document.set("os", document.createNode({}));
  document.setIn(["os", "memory", "enabled"], enabled);
  await io.writeFile(path, document.toString());
}

/** Persist os.language (Rafiq M4 §3), keeping the rest of the file. */
export async function writeOsLanguage(path: string, lang: Lang, io: ConfigIo): Promise<void> {
  let text = "";
  try {
    text = await io.readFile(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new Error(`jarvis.yaml does not parse: ${document.errors[0]?.message ?? "unknown"}`);
  }
  if (!isMap(document.get("os", true))) document.set("os", document.createNode({}));
  document.setIn(["os", "language"], lang);
  await io.writeFile(path, document.toString());
}
