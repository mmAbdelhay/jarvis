// Short spoken or typed phrases ("yes", "نعم", "undo") are matched exactly,
// after folding the differences that carry no meaning: Unicode forms, case,
// punctuation, spacing, Arabic short-vowel marks, tatweel and alef forms.
// Pure.

const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const ALEF_FORMS = /[آأإٱ]/g;
const PUNCTUATION = /[\p{P}\p{S}]+/gu;

export function normalizePhrase(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(ARABIC_MARKS, "")
    .replace(ALEF_FORMS, "ا")
    .replace(PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** whisper.cpp writes non-speech as [BLANK_AUDIO], (music), [ Silence ]. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
