// The voice upload channel's own shapes (M8 Task 4, spec "voice"): the
// meta a phone attaches to its `blob` header for `remote:uploadAudio`, and
// the result the laptop answers with once the recording has been
// transcribed and routed. Pure, like every other file in this package —
// no node:*, no other workspace package (no-node-imports.test.ts).
//
// Both parsers rebuild their return value field by field from a validated
// `unknown`, never spreading the input — an extra key on the wire is
// dropped rather than carried through, and a malformed field anywhere
// answers `undefined` for the whole value rather than a partial result.
import { isSubscriptionKey } from "./protocol.js";

export const VOICE_UPLOAD_CHANNEL = "remote:uploadAudio";

export const MAX_VOICE_BYTES = 4_194_304;
export const MAX_VOICE_DURATION_MS = 120_000;
export const MIN_VOICE_DURATION_MS = 500;
export const TURN_ID_PATTERN = /^[0-9a-f]{32}$/;

// parseVoiceUploadResult's `transcript`/`text` cap — generous enough for a
// full turn's text, bounded so a malformed or hostile reply can't grow a
// string the phone will render without limit.
const MAX_VOICE_TEXT_CHARS = 16_384;

export type VoiceLanguage = "ar" | "en";

export type VoiceUploadMeta = {
  turnId: string;
  format: "m4a";
  durationMs: number;
  targetSessionId?: string;
};

export type VoiceUploadResult =
  | { kind: "heard"; route: "brain"; transcript: string; language: VoiceLanguage }
  | {
      kind: "heard";
      route: "session";
      sessionId: string;
      transcript: string;
      language: VoiceLanguage;
    }
  | { kind: "silence" | "busy" | "invalid" | "failed"; text: string; language: VoiceLanguage };

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_VOICE_TEXT_CHARS;
}

function isVoiceLanguage(value: unknown): value is VoiceLanguage {
  return value === "ar" || value === "en";
}

/**
 * The `blob` header's `a[0]` for `remote:uploadAudio`, validated before a
 * single byte of the upload is ever kept. Rebuilt with exactly its own
 * keys — `targetSessionId` present only when the input had one that passed
 * {@link isSubscriptionKey} — so an extra key on the wire never rides
 * along into `handleUtterance`.
 */
export function parseVoiceUploadMeta(value: unknown): VoiceUploadMeta | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  const turnId = raw["turnId"];
  if (typeof turnId !== "string" || !TURN_ID_PATTERN.test(turnId)) return undefined;

  if (raw["format"] !== "m4a") return undefined;

  const durationMs = raw["durationMs"];
  if (
    typeof durationMs !== "number" ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < MIN_VOICE_DURATION_MS ||
    durationMs > MAX_VOICE_DURATION_MS
  ) {
    return undefined;
  }

  const targetSessionId = raw["targetSessionId"];
  if (targetSessionId !== undefined && !isSubscriptionKey(targetSessionId)) return undefined;

  return {
    turnId,
    format: "m4a",
    durationMs,
    ...(targetSessionId !== undefined ? { targetSessionId } : {}),
  };
}

/**
 * `remote:uploadAudio`'s response, as the phone decodes it off the wire —
 * a field-by-field rebuild of the union, same discipline as
 * {@link parseVoiceUploadMeta}: an unknown `kind`/`route`, a `language`
 * that is not `ar`/`en`, a non-string field, an over-long `transcript`/
 * `text`, or a `sessionId` that fails {@link isSubscriptionKey} all answer
 * `undefined` for the whole value.
 */
export function parseVoiceUploadResult(value: unknown): VoiceUploadResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  const language = raw["language"];
  if (!isVoiceLanguage(language)) return undefined;

  const kind = raw["kind"];

  if (kind === "heard") {
    const transcript = raw["transcript"];
    if (!isBoundedText(transcript)) return undefined;
    const route = raw["route"];
    if (route === "brain") return { kind: "heard", route: "brain", transcript, language };
    if (route === "session") {
      const sessionId = raw["sessionId"];
      if (!isSubscriptionKey(sessionId)) return undefined;
      return { kind: "heard", route: "session", sessionId, transcript, language };
    }
    return undefined;
  }

  if (kind === "silence" || kind === "busy" || kind === "invalid" || kind === "failed") {
    const text = raw["text"];
    if (!isBoundedText(text)) return undefined;
    return { kind, text, language };
  }

  return undefined;
}
