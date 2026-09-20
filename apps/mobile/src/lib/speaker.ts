// The pure decision layer behind on-device text-to-speech (M8 Task 6:
// `expo-speech`, ruling 7). `native-speaker.ts` is a thin wrapper over
// `Speech.speak`/`Speech.stop`/`Speech.getAvailableVoicesAsync` and the
// functions below — everything here is plain data and pure functions, so
// it is unit-tested without a simulator.
import type { Language } from "./i18n";

export type SpeakOutcome = "done" | "stopped" | "failed";

export type Speaker = {
  speak(text: string, language: Language): Promise<SpeakOutcome>;
  stop(): void;
  hasVoice(language: Language): Promise<boolean>;
};

export function speechLanguageTag(language: Language): "ar-SA" | "en-US" {
  return language === "ar" ? "ar-SA" : "en-US";
}

const SENTENCE_END_CHARS = new Set([".", "!", "?", "؟", "؛", "\n"]);

function isSentenceEnd(ch: string): boolean {
  return SENTENCE_END_CHARS.has(ch);
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/** The cut point (a length, 1..max) for the head of `s`, preferring the
 * last sentence end within `max`, then the last whitespace, then exactly
 * `max` — adjusted so it never falls inside a UTF-16 surrogate pair. */
function findCut(s: string, max: number): number {
  const windowEnd = Math.min(max, s.length);

  for (let i = windowEnd - 1; i >= 0; i--) {
    if (isSentenceEnd(s[i])) return i + 1;
  }
  for (let i = windowEnd - 1; i >= 0; i--) {
    if (isWhitespace(s[i])) return i;
  }

  let cut = windowEnd;
  if (cut > 0 && cut < s.length) {
    const code = s.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      // `cut - 1` is a high surrogate whose low surrogate is at `cut` —
      // back off one code unit so the pair stays together.
      cut -= 1;
    }
  }
  // Never 0: a `max === 1` back-off above can land here, and a cut of 0
  // would leave `rest` unchanged next iteration (`slice(0)` is the whole
  // string), looping forever. At `max === 1` there is no boundary that
  // both makes progress and keeps a surrogate pair whole, so progress
  // wins (fix round 1, Minor #1).
  return Math.max(1, cut);
}

export function splitForSpeech(text: string, max: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  // `max < 1` (including 0, negative, NaN) has no meaningful cut point —
  // return the whole text unsplit rather than loop forever computing one
  // (fix round 1, Minor #1).
  if (!(max >= 1) || trimmed.length <= max) return [trimmed];

  const segments: string[] = [];
  let rest = trimmed;
  while (rest.length > 0) {
    if (rest.length <= max) {
      const segment = rest.trim();
      if (segment.length > 0) segments.push(segment);
      break;
    }
    const cut = findCut(rest, max);
    const segment = rest.slice(0, cut).trim();
    if (segment.length > 0) segments.push(segment);
    rest = rest.slice(cut).trim();
  }
  return segments;
}

export function voiceMatches(voiceLanguage: string, language: Language): boolean {
  const tag = voiceLanguage.toLowerCase();
  return tag === language || tag.startsWith(`${language}-`) || tag.startsWith(`${language}_`);
}
