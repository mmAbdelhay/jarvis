// Important 9: main.ts previously invented its own English-only lane of
// user-facing strings beside @jarvis/core's bilingual MESSAGES table
// (orchestrator.ts). The user's primary language is Arabic, so every
// string a person can actually see or hear must follow the same
// language-in, string-out pattern core already uses — not duplicate an
// English-only one.
//
// None of these events carry a language signal of their own (a hotkey
// collision is discovered at startup, before any utterance; a broken
// recording or transcription pipeline means no language was ever
// detected), so callers pass the user's configured primary language.
export const MESSAGES = {
  hotkeyCollision: (combo: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `تعذر تسجيل اختصار ${combo} — يبدو أن تطبيقًا آخر يستخدمه بالفعل.`
      : `Could not register the ${combo} shortcut — another app is probably already using it.`,
  recordingFailed: (message: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `تعذر تسجيل الصوت: ${message}`
      : `Recording failed: ${message}`,
  transcriptionFailed: (message: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `فشل تحويل الصوت إلى نص: ${message}`
      : `Transcription failed: ${message}`,
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
