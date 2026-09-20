// Expo push notification shapes (M10, spec "push"): the kinds a laptop can
// notify a phone about, the token shapes both sides register and validate,
// and the payload a phone decodes off `data`. Pure, like every other file
// in this package — no node:*, no other workspace package
// (no-node-imports.test.ts).
//
// Every parser here rebuilds its return value field by field from a
// validated `unknown`, never spreading the input — an extra key on the
// wire is dropped rather than carried through, and a malformed field
// anywhere answers `undefined` for the whole value rather than a partial
// result.
import { isSubscriptionKey } from "./protocol.js";

export const PUSH_KINDS = [
  "session-done",
  "session-failed",
  "session-waiting",
  "command-finished",
  "reply",
] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

// Expo's own token shapes: the current `ExponentPushToken[…]` and the
// older `ExpoPushToken[…]` a still-installed app may carry. The inner
// opaque id is bounded, not merely non-empty, so a hostile or malformed
// value can't grow a string this package carries around unbounded.
export const EXPO_PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,128}\]$/;

export const MAX_PUSH_PROJECT_CHARS = 64;

export const PUSH_REGISTER_CHANNEL = "remote:registerPush";
export const PUSH_UNREGISTER_CHANNEL = "remote:unregisterPush";

export type PushPlatform = "ios" | "android";
export type PushLanguage = "ar" | "en";

export type PushData = { kind: PushKind; sessionId?: string; project?: string };

export type PushRegistration = { token: string; platform: PushPlatform; language: PushLanguage };

export type PushRegisterResult =
  | { registered: true; laptopEnabled: boolean }
  | { registered: false; text: string; language: PushLanguage };

// parsePushRegisterResult's `text` cap — the laptop's own explanation of
// why registration didn't take, never a transcript, so a generous but
// bounded cap is enough.
const MAX_REGISTER_RESULT_TEXT_CHARS = 512;

/** True iff `value` is one of PUSH_KINDS — never coerced from any other type. */
export function isPushKind(value: unknown): value is PushKind {
  return typeof value === "string" && (PUSH_KINDS as readonly string[]).includes(value);
}

/** True iff `value` is a string matching EXPO_PUSH_TOKEN_PATTERN. */
export function isExpoPushToken(value: unknown): value is string {
  return typeof value === "string" && EXPO_PUSH_TOKEN_PATTERN.test(value);
}

function isPushLanguage(value: unknown): value is PushLanguage {
  return value === "ar" || value === "en";
}

function isValidPushProject(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > MAX_PUSH_PROJECT_CHARS) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check for control characters.
  return !/[\x00-\x1f\x7f]/.test(value);
}

/**
 * A push notification's `data` object, as a phone decodes it off a
 * received notification — field-by-field rebuild, same discipline as
 * every other parser here: an unknown `kind`, a `sessionId` that fails
 * {@link isSubscriptionKey}, or a `project` that isn't 1-{@link
 * MAX_PUSH_PROJECT_CHARS} control-character-free characters all answer
 * `undefined` for the whole value. Any other key on the input is dropped.
 */
export function parsePushData(value: unknown): PushData | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  const kind = raw["kind"];
  if (!isPushKind(kind)) return undefined;

  const sessionIdRaw = raw["sessionId"];
  let sessionId: string | undefined;
  if (sessionIdRaw !== undefined) {
    if (!isSubscriptionKey(sessionIdRaw)) return undefined;
    sessionId = sessionIdRaw;
  }

  const projectRaw = raw["project"];
  let project: string | undefined;
  if (projectRaw !== undefined) {
    if (!isValidPushProject(projectRaw)) return undefined;
    project = projectRaw;
  }

  return {
    kind,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(project !== undefined ? { project } : {}),
  };
}

/**
 * `remote:registerPush`'s argument, as the laptop decodes it off the
 * wire — a field-by-field rebuild: a `token` that fails {@link
 * isExpoPushToken}, an unknown `platform`, or an unknown `language` all
 * answer `undefined` for the whole value. Any other key on the input is
 * dropped.
 */
export function parsePushRegistration(value: unknown): PushRegistration | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  const token = raw["token"];
  if (!isExpoPushToken(token)) return undefined;

  const platform = raw["platform"];
  if (platform !== "ios" && platform !== "android") return undefined;

  const language = raw["language"];
  if (!isPushLanguage(language)) return undefined;

  return { token, platform, language };
}

/**
 * `remote:registerPush`'s result, as the phone decodes it off the wire —
 * same discipline as {@link parsePushRegistration}: a `registered` that
 * is neither `true` nor `false`, a missing/wrong-typed field for whichever
 * branch it claims, or a `text` over {@link MAX_REGISTER_RESULT_TEXT_CHARS}
 * characters all answer `undefined` for the whole value.
 */
export function parsePushRegisterResult(value: unknown): PushRegisterResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  const registered = raw["registered"];

  if (registered === true) {
    const laptopEnabled = raw["laptopEnabled"];
    if (typeof laptopEnabled !== "boolean") return undefined;
    return { registered: true, laptopEnabled };
  }

  if (registered === false) {
    const text = raw["text"];
    if (typeof text !== "string" || text.length > MAX_REGISTER_RESULT_TEXT_CHARS) return undefined;
    const language = raw["language"];
    if (!isPushLanguage(language)) return undefined;
    return { registered: false, text, language };
  }

  return undefined;
}
