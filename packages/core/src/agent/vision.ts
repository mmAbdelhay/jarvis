// packages/core/src/agent/vision.ts
// Which configured models can see a screenshot (Rafiq v1.1 contracts §2:
// provider:list entries gain `vision`). Local models: the catalog's
// `vision: true` tags; Ollama /api/show evidence is injected by the daemon.
// Cloud models: a conservative name table — a false "true" would send images
// to a text-only model, a false "false" only greys the feature out. Pure.
import type { ProviderKind } from "./contract.js";

const ANTHROPIC_VISION = /^claude-(3|opus|sonnet|haiku|[4-9])/;
const ANTHROPIC_TEXT_ONLY = /^claude-3-5-haiku/;
const OPENAI_VISION =
  /(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|chatgpt-4o|(^|\/)o[134](-|$)|vision|[-_.]vl([-_.:]|$)|llava|pixtral|gemma-?3|llama-?4|qwen-vl|qvq|minicpm-v|internvl|grok-(2-vision|4))/;
const GEMINI_VISION = /(^|\/)gemini-(?!embedding)/;

export function normalizeOllamaTag(tag: string): string {
  const lower = tag.trim().toLowerCase();
  return lower.includes(":") ? lower : `${lower}:latest`;
}

export function modelSupportsVision(
  kind: ProviderKind,
  model: string,
  localVisionTags: ReadonlySet<string> = new Set(),
): boolean {
  const name = model.trim().toLowerCase();
  if (name === "") return false;
  switch (kind) {
    case "anthropic":
      return ANTHROPIC_VISION.test(name) && !ANTHROPIC_TEXT_ONLY.test(name);
    case "openai-compatible":
      return OPENAI_VISION.test(name);
    case "gemini":
      return GEMINI_VISION.test(name);
    case "ollama":
      return localVisionTags.has(normalizeOllamaTag(name));
  }
}
