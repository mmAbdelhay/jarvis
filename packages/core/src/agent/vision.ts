// packages/core/src/agent/vision.ts
// Which configured models can see a screenshot (Rafiq v1.1 contracts §2:
// provider:list entries gain `vision`). Local models: the catalog's
// `vision: true` tags; Ollama /api/show evidence is injected by the daemon.
// Cloud models: a conservative name table — a false "true" would send images
// to a text-only model, a false "false" only greys the feature out. Pure.
import type { AccountId, ProviderKind } from "./contract.js";

const ANTHROPIC_VISION = /^claude-(?:[3-9]|(?:opus|sonnet|haiku)-[4-9])(?:[-.]|$)/;
const ANTHROPIC_TEXT_ONLY = /^claude-3-5-haiku(?:-|$)/;
// Match a family at the start of the model name, allowing registry namespaces.
// A generic "vision" label or a family substring is not capability evidence.
const OPENAI_VISION =
  /^(?:[^/]+\/)*(?:gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5(?:\.[0-9]+)?|chatgpt-4o|o[134]|qwen[0-9.]*-vl|qwen-vl|llava|pixtral|gemma-?3|llama-?4|qvq|minicpm-v|internvl[0-9.]*|grok-(?:2-vision|4))(?:[-_:]|$)/;
// These variants do not accept images despite sharing a vision-family prefix.
const OPENAI_NO_IMAGES =
  /^(?:[^/]+\/)*(?:o1-(?:mini|preview)|o3-mini|gpt-4o(?:-mini)?-(?:audio|realtime|transcribe|tts)|gemma-?3[-_:](?:1b|270m))(?:[-_:]|$)/;
const GEMINI_VISION = /^(?:models\/)?gemini-[0-9]+(?:[.-]|$)/;

export function normalizeOllamaTag(tag: string): string {
  const lower = tag.trim().toLowerCase();
  return lower.includes(":") ? lower : `${lower}:latest`;
}

export function modelSupportsVision(
  kind: ProviderKind,
  model: string,
  localVisionTags: ReadonlySet<string> = new Set(),
  account?: AccountId,
): boolean {
  const name = model.trim().toLowerCase();
  if (name === "") return false;
  switch (kind) {
    case "anthropic":
      return ANTHROPIC_VISION.test(name) && !ANTHROPIC_TEXT_ONLY.test(name);
    case "openai-compatible":
      return OPENAI_VISION.test(name) && !OPENAI_NO_IMAGES.test(name);
    case "gemini":
      return GEMINI_VISION.test(name);
    case "account":
      // Plan Y §5.8: only Claude accounts take images (stream-json base64,
      // never a file); the aliases name Claude 4+ models, all of which see.
      return (
        account === "claude" &&
        (name === "default" ||
          /^(sonnet|opus|haiku|fable)$/.test(name) ||
          ANTHROPIC_VISION.test(name))
      );
    case "ollama":
      return localVisionTags.has(normalizeOllamaTag(name));
  }
}
