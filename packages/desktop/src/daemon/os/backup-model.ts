// Rafiq M4 contracts §1: which model is the backup (the catalog's one
// role "backup" entry) and the provider that talks to it. The URL is the
// fixed loopback Ollama, never anything from jarvis.yaml.
//
// No electron here (core/no-electron.test.ts).
import { BACKUP_BASE_URL, type ModelProvider, ProviderError } from "@jarvis/core";
import type { ProviderSection } from "./provider-config.js";

const OLLAMA_TAG = /^[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function parseBackupTag(raw: unknown): string | null {
  if (!isObject(raw) || !Array.isArray(raw["models"])) return null;
  const backups = raw["models"].filter(
    (model): model is Record<string, unknown> => isObject(model) && model["role"] === "backup",
  );
  const only = backups.length === 1 ? backups[0] : undefined;
  if (only === undefined || only["toolCalling"] !== "verified") return null;
  const tag = only["ollamaTag"];
  return typeof tag === "string" && OLLAMA_TAG.test(tag) ? tag : null;
}

export async function readBackupTag(
  path: string,
  readFile: (path: string) => Promise<string>,
  log: (line: string) => void,
): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT")
      log(`[backup] ${path}: ${describe(error)}`);
    return null;
  }
  try {
    const tag = parseBackupTag(JSON.parse(text));
    if (tag === null) log(`[backup] ${path} names no single tool-calling backup model; no backup`);
    return tag;
  } catch (error) {
    log(`[backup] ${path}: ${describe(error)}; no backup`);
    return null;
  }
}

export function sameOllamaTag(a: string, b: string): boolean {
  const norm = (tag: string) => (tag.includes(":") ? tag : `${tag}:latest`);
  return norm(a) === norm(b);
}

export function createBackupProvider(options: {
  tag: string;
  make(section: ProviderSection): ModelProvider;
}): ModelProvider {
  const inner = options.make({
    kind: "ollama",
    baseUrl: BACKUP_BASE_URL,
    model: options.tag,
    auth: "api-key",
    supportsTools: true,
  });
  // Unreachable unless Ollama has the model: then the doctor stays on offer.
  const listModels = async (signal?: AbortSignal) => {
    const models = await inner.listModels(signal);
    if (!models.some((model) => sameOllamaTag(model, options.tag))) {
      throw new ProviderError("network", `the backup model ${options.tag} is not installed`);
    }
    return models;
  };
  return {
    chat: (request) => inner.chat(request),
    probe: () => inner.probe(),
    listModels,
    async reachable(signal) {
      try {
        await listModels(signal);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },
  };
}
