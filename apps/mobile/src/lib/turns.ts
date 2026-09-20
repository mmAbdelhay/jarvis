// The orchestrator's turns, as the Voice screen sees them (M8 Task 7,
// ruling 10): the shape `turn:new` pushes and the read-only `turns:list`
// channel both carry, parsed defensively and merged into one bounded,
// ordered list. Same discipline as sessions-store.ts's `parseSessionList`
// — every value off the wire is `unknown` until validated field by field,
// and a row is rebuilt (never spread) so an extra wire field never rides
// through. See task-7-brief.md's "Behaviour, turns.ts".
import { TURN_ID_PATTERN, isSubscriptionKey } from "@jarvis/wire";
import type { Language } from "./i18n";

export type TurnView = {
  role: "user" | "assistant";
  text: string;
  language: Language;
  at: number;
  replyTo?: string;
  sessionId?: string;
};

export const MAX_TURNS_SHOWN = 50;

// Generous enough for a full turn's text, bounded so a malformed or
// hostile payload can't grow a string the phone will render without limit
// (mirrors @jarvis/wire voice.ts's own MAX_VOICE_TEXT_CHARS discipline).
const MAX_TURN_TEXT_CHARS = 65_536;

function isLanguage(value: unknown): value is Language {
  return value === "ar" || value === "en";
}

/**
 * One `turn:new` push, or one item of a `turns:list` answer — rebuilt
 * field by field from a validated `unknown`. `replyTo` is copied only when
 * it matches `TURN_ID_PATTERN`; `sessionId` only when it passes
 * `isSubscriptionKey`. Anything else, on any required field, answers
 * `undefined` for the whole turn rather than a partial one.
 */
export function parseTurn(payload: unknown): TurnView | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const raw = payload as Record<string, unknown>;

  const role = raw["role"];
  if (role !== "user" && role !== "assistant") return undefined;

  const text = raw["text"];
  if (typeof text !== "string" || text.length > MAX_TURN_TEXT_CHARS) return undefined;

  const language = raw["language"];
  if (!isLanguage(language)) return undefined;

  const at = raw["at"];
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;

  const turn: TurnView = { role, text, language, at };

  const replyTo = raw["replyTo"];
  if (typeof replyTo === "string" && TURN_ID_PATTERN.test(replyTo)) {
    turn.replyTo = replyTo;
  }

  const sessionId = raw["sessionId"];
  if (isSubscriptionKey(sessionId)) {
    turn.sessionId = sessionId;
  }

  return turn;
}

/** `turns:list`'s answer: array items go through {@link parseTurn},
 * invalid ones are skipped; a non-array answers `[]`. */
export function parseTurnList(value: unknown): TurnView[] {
  if (!Array.isArray(value)) return [];
  const turns: TurnView[] = [];
  for (const item of value) {
    const turn = parseTurn(item);
    if (turn !== undefined) turns.push(turn);
  }
  return turns;
}

/** A collision-safe dedup key for `(role, at, text, replyTo)`: `JSON.stringify`
 * escapes every field, so no separator character (a NUL, a pipe, …) could
 * ever be confused with content the fields themselves contain. */
function turnKey(turn: TurnView): string {
  return JSON.stringify([turn.role, turn.at, turn.text, turn.replyTo ?? ""]);
}

/**
 * The union of `current` and `incoming`, de-duplicated by
 * `(role, at, text, replyTo)` — an `incoming` entry replaces a `current`
 * one with the same key — sorted by `at` ascending (a stable sort: Array's
 * native `sort` has been spec-stable since ES2019), keeping only the last
 * {@link MAX_TURNS_SHOWN}.
 */
export function mergeTurns(
  current: readonly TurnView[],
  incoming: readonly TurnView[],
): TurnView[] {
  const byKey = new Map<string, TurnView>();
  for (const turn of current) byKey.set(turnKey(turn), turn);
  for (const turn of incoming) byKey.set(turnKey(turn), turn);
  const merged = [...byKey.values()].sort((a, b) => a.at - b.at);
  return merged.slice(Math.max(0, merged.length - MAX_TURNS_SHOWN));
}
