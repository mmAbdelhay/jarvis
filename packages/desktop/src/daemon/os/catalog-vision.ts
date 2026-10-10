// packages/desktop/src/daemon/os/catalog-vision.ts
// Rafiq v1.1 contracts §3: the catalog's vision-capable local models.
// Missing catalog: none (cloud vision still works). Never throws.
//
// No electron here (core/no-electron.test.ts).
import { normalizeOllamaTag } from "@jarvis/core";

const OLLAMA_TAG = /^[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseVisionTags(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!isObject(raw) || !Array.isArray(raw["models"])) return out;
  for (const model of raw["models"]) {
    if (!isObject(model) || model["vision"] !== true) continue;
    const tag = model["ollamaTag"];
    if (typeof tag === "string" && OLLAMA_TAG.test(tag)) out.add(normalizeOllamaTag(tag));
  }
  return out;
}

export async function readVisionTags(
  path: string,
  readFile: (path: string) => Promise<string>,
  log: (line: string) => void,
): Promise<ReadonlySet<string>> {
  let text: string;
  try {
    text = await readFile(path);
  } catch (error) {
    if (!isObject(error) || error["code"] !== "ENOENT") {
      log(`[vision] ${path}: catalog unavailable`);
    }
    return new Set();
  }
  try {
    return parseVisionTags(JSON.parse(text));
  } catch {
    log(`[vision] ${path}: catalog unavailable; no local vision models`);
    return new Set();
  }
}

/** Section 4: Ollama names alone are not evidence of vision support. */
export async function readOllamaVision(
  baseUrl: string,
  model: string,
  fetcher: typeof fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const raw: unknown = await response.json();
    return (
      isObject(raw) && Array.isArray(raw["capabilities"]) && raw["capabilities"].includes("vision")
    );
  } catch {
    return false;
  }
}
