// What a spoken utterance does (Rafiq M3 design §3.2 and its ruling): while a
// card is visible and the screen is unlocked, an exact short yes/no answers
// it; "stop" stops; anything else is an ordinary prompt. A voice "yes" never
// answers a card it cannot see (stale id), never a password-tier card, and
// never one that needs typed input. Pure.
import type { Card } from "./contract.js";
import { cleanTranscript, normalizePhrase } from "./phrases.js";

// Stored normalised (normalizePhrase).
export const VOICE_APPROVE_PHRASES: ReadonlySet<string> = new Set([
  "yes",
  "yes please",
  "approve",
  "approved",
  "confirm",
  "نعم",
  "موافق",
  "اوافق",
  "نعم موافق",
]);
export const VOICE_DENY_PHRASES: ReadonlySet<string> = new Set([
  "no",
  "no thanks",
  "deny",
  "cancel",
  "reject",
  "لا",
  "ارفض",
  "رفض",
  "لا شكرا",
]);
export const VOICE_STOP_PHRASES: ReadonlySet<string> = new Set([
  "stop",
  "stop talking",
  "be quiet",
  "توقف",
  "اسكت",
  "قف",
]);

export type VoiceIntent = "approve" | "deny" | "stop" | "other";

export function classifyUtterance(text: string): VoiceIntent {
  const phrase = normalizePhrase(text);
  if (VOICE_APPROVE_PHRASES.has(phrase)) return "approve";
  if (VOICE_DENY_PHRASES.has(phrase)) return "deny";
  if (VOICE_STOP_PHRASES.has(phrase)) return "stop";
  return "other";
}

export type VoiceDecision =
  | { action: "approve"; cardId: string; ticked: string[] }
  | { action: "deny"; cardId: string }
  | { action: "stop" }
  | { action: "prompt"; text: string }
  | {
      action: "ignored";
      reason: "empty" | "locked" | "no-card" | "password-card" | "card-needs-input";
    };

export function decideVoiceAction(input: {
  text: string;
  cardId?: string;
  ticked?: string[];
  card: Card | undefined;
  locked: boolean;
}): VoiceDecision {
  const text = cleanTranscript(input.text);
  if (text === "") return { action: "ignored", reason: "empty" };
  const intent = classifyUtterance(text);
  if (intent === "stop") return { action: "stop" };
  if (intent === "other" || input.cardId === undefined) return { action: "prompt", text };
  if (input.locked) return { action: "ignored", reason: "locked" };
  const card = input.card;
  if (card === undefined || card.cardId !== input.cardId)
    return { action: "ignored", reason: "no-card" };
  if (intent === "deny") return { action: "deny", cardId: card.cardId };
  if (card.items.some((item) => item.risk === "password")) {
    return { action: "ignored", reason: "password-card" };
  }
  if (card.items.some((item) => item.secretFields.length > 0)) {
    return { action: "ignored", reason: "card-needs-input" };
  }
  const onCard = new Set(card.items.map((item) => item.itemId));
  const ticked =
    input.ticked === undefined ? [...onCard] : input.ticked.filter((itemId) => onCard.has(itemId));
  if (ticked.length === 0) return { action: "ignored", reason: "card-needs-input" };
  return { action: "approve", cardId: card.cardId, ticked };
}
