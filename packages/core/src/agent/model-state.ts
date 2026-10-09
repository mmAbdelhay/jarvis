// /var/lib/jarvis/model-state.json (M2 contracts §5), written by the
// installer backend and jarvis-model-fetch, read by jarvisd every snapshot.
// Pure: the daemon reads the file (model-state-reader.ts) and passes text.
// A file that does not parse is "no state" — never an error for the shell.
import type { ModelDownload, ModelDownloadState, ProviderKind } from "./contract.js";
import { isRecord } from "./types.js";

export type ModelState = {
  modelId: string;
  ollamaTag: string;
  state: ModelDownloadState;
  percent: number;
  message: string;
  updatedAt: string;
};

export const MAX_MODEL_STATE_CHARS = 65_536;
const STATES: readonly string[] = ["pending", "downloading", "ready", "failed"];
const LOOPBACK: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

export function parseModelState(text: string): ModelState | undefined {
  if (text.length > MAX_MODEL_STATE_CHARS) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  const { modelId, ollamaTag, state, percent, message, updatedAt } = raw;
  if (typeof modelId !== "string" || typeof ollamaTag !== "string" || ollamaTag === "") {
    return undefined;
  }
  if (typeof state !== "string" || !STATES.includes(state)) return undefined;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  return {
    modelId,
    ollamaTag,
    state: state as ModelDownloadState,
    percent: Math.min(100, Math.max(0, Math.round(percent))),
    message: typeof message === "string" ? message : "",
    updatedAt: typeof updatedAt === "string" ? updatedAt : "",
  };
}

const withTag = (tag: string) => (tag.includes(":") ? tag : `${tag}:latest`);

/** The download belongs to the configured model only when that model is the
 *  machine's own Ollama serving the same tag (M2 contracts §5, §6). */
export function modelDownloadFor(
  model: { kind: ProviderKind; baseUrl: string; model: string } | null,
  state: ModelState | null,
): ModelDownload | null {
  if (model === null || state === null || model.kind !== "ollama") return null;
  if (withTag(model.model) !== withTag(state.ollamaTag)) return null;
  let host: string;
  try {
    host = new URL(model.baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
  if (!LOOPBACK.has(host)) return null;
  return { state: state.state, percent: state.state === "ready" ? 100 : state.percent };
}
