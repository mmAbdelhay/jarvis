// packages/platform/src/model/gemini-format.ts
// Pure mapping between the provider-neutral agent vocabulary and Gemini's
// generateContent wire format (M2 design §10). gemini.ts does the HTTP.
//
// Names: ToolRegistry already hands the model `pkg_install` for
// `pkg.install` (M1 contracts §6 #15). Gemini also needs a name to start
// with a letter or underscore, so anything else gets a `_` prefix here and
// geminiNameMap maps the answer back.
//
// Thought signatures: thinking models attach `thoughtSignature` to function
// calls and Gemini 3 refuses the next request without it. They are kept per
// call id (bounded) and re-attached; history this adapter did not produce
// gets Google's documented placeholder on newer models only.
import { isRecord, type ModelMessage, type ModelToolSpec } from "@jarvis/core";

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
export const GEMINI_DUMMY_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const GEMINI_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;

export function toGeminiName(name: string): string {
  if (GEMINI_NAME.test(name)) return name;
  return `_${name.replace(/[^A-Za-z0-9_.:-]/g, "_")}`.slice(0, 64);
}

export function geminiNameMap(tools: readonly ModelToolSpec[]): Map<string, string> {
  return new Map(tools.map((tool) => [toGeminiName(tool.name), tool.name]));
}

export function geminiApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v1(beta)?$/.test(trimmed) ? trimmed : `${trimmed}/v1beta`;
}

export function geminiModelPath(model: string): string {
  const path = model.includes("/") ? model : `models/${model}`;
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Gemini 1.x/2.x do not require signatures; anything newer does. */
export function needsThoughtSignatures(model: string): boolean {
  return !/^(models\/)?gemini-[12][.-]/.test(model);
}

export type ThoughtSignatures = {
  get(callId: string): string | undefined;
  set(callId: string, signature: string): void;
};

export function createThoughtSignatures(max = 256): ThoughtSignatures {
  const entries = new Map<string, string>();
  return {
    get: (callId) => entries.get(callId),
    set(callId, signature) {
      entries.delete(callId);
      entries.set(callId, signature);
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

export function toGeminiContents(
  messages: readonly ModelMessage[],
  signatures: ThoughtSignatures,
  options: { dummySignatures: boolean },
): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", parts: [{ text: message.text }] });
    } else if (message.role === "assistant") {
      const parts: unknown[] = [];
      if (message.text !== "") parts.push({ text: message.text });
      for (const [index, call] of message.toolCalls.entries()) {
        const part: Record<string, unknown> = {
          functionCall: {
            name: toGeminiName(call.name),
            args: isRecord(call.input) ? call.input : {},
          },
        };
        const signature =
          signatures.get(call.id) ??
          (index === 0 && options.dummySignatures ? GEMINI_DUMMY_THOUGHT_SIGNATURE : undefined);
        if (signature !== undefined) part["thoughtSignature"] = signature;
        parts.push(part);
      }
      // A turn with neither text nor calls has nothing Gemini accepts.
      if (parts.length > 0) out.push({ role: "model", parts });
    } else {
      out.push({
        role: "user",
        parts: message.results.map((result) => ({
          functionResponse: {
            name: toGeminiName(result.name),
            response: result.isError ? { error: result.content } : { output: result.content },
          },
        })),
      });
    }
  }
  return out;
}

export function toGeminiTools(tools: readonly ModelToolSpec[]): unknown[] {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const { $schema: _dropped, ...schema } = tool.inputSchema;
        return {
          name: toGeminiName(tool.name),
          description: tool.description,
          parametersJsonSchema: schema,
        };
      }),
    },
  ];
}
