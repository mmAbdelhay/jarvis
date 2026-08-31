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
// The user's primary language, shared by both the main process (which
// picks it for strings fired before any utterance is heard, or after the
// language signal itself is lost) and the renderer (which cannot import
// main.ts — that would pull Electron into a browser-side bundle). This is
// the one definition both sides read; do not duplicate it.
export const PRIMARY_LANGUAGE = "ar";

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
  // The renderer's history-panel badge (`${n} sessions`) — pulled through
  // here rather than left as an inline English template literal both for
  // the language-in/string-out pattern above and because English's
  // one/many split ("1 session" vs "2 sessions") doesn't carry over to
  // Arabic: MSA counted nouns have distinct singular (1), dual (2),
  // plural (3-10), and a reversion to singular for 11+.
  sessionsCount: (count: number, language: "ar" | "en"): string =>
    language === "ar" ? arabicSessionsCount(count) : `${count} ${count === 1 ? "session" : "sessions"}`,
  // sessionId is renderer-supplied and echoed straight into the sentence;
  // capped so a caller passing something unbounded (accidentally or not)
  // cannot blow up the size of a string that ends up rendered in the UI.
  unknownSession: (sessionId: string, language: "ar" | "en"): string => {
    const id = sessionId.length > 100 ? `${sessionId.slice(0, 100)}…` : sessionId;
    return language === "ar"
      ? `لا أعرف جلسة بهذا المعرّف: ${id}`
      : `I don't know a session with that id: ${id}`;
  },
  // Shown when an IPC call arrives with an argument of the wrong type (a
  // buggy renderer caller, not necessarily a malicious one) — never echoes
  // the bad value back, since its shape/type is exactly what's untrusted.
  invalidArgument: (language: "ar" | "en"): string =>
    language === "ar" ? "طلب غير صالح." : "Invalid request.",
  // Ruling P22: gitChanges() always reads the repository's current working
  // tree, never a per-session snapshot. For a session that has already
  // ended, showing that data under its name would repeat exactly the lie
  // ruling P21 removed from the session badge — so the Changes view says
  // so plainly instead of pretending the file list is that session's own
  // work. Task 16's per-session recorded git metadata retires this notice.
  changesShowCurrentState: (agentId: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `انتهت هذه الجلسة — ما يظهر أدناه هو الحالة الحالية للمستودع، وليس بالضرورة ما كتبه ${agentId}.`
      : `This session has ended — what's shown below is the repository's current state, not necessarily ${agentId}'s work.`,
  // GitFileDiff.binary: git itself (or a NUL-byte read) confirmed the file
  // is not text, so there is no line-by-line diff to draw at all.
  diffBinaryFile: (language: "ar" | "en"): string =>
    language === "ar" ? "ملف ثنائي — لا يوجد فرق نصي لعرضه." : "Binary file — no text diff to show.",
  // GitFileDiff.tooLarge (ruling P8): the file or its diff exceeded the
  // provider's size cap and was never read, so this is deliberately a
  // different sentence from diffBinaryFile — "too big to show" is not the
  // same fact as "not text", and conflating them was Task 14's first-draft
  // mistake this message exists to avoid repeating.
  diffTooLarge: (language: "ar" | "en"): string =>
    language === "ar"
      ? "الملف كبير جدًا لعرض الفرق."
      : "This file is too large to display a diff for.",
  // hunks.length === 0 with binary and tooLarge both false: a real diff
  // read that simply found nothing to show (e.g. a mode-only change, or
  // the file picked from the list has since gone back to matching HEAD).
  diffNoChanges: (language: "ar" | "en"): string =>
    language === "ar" ? "لا توجد تغييرات لعرضها." : "No changes to show.",
};

function arabicSessionsCount(count: number): string {
  if (count === 0) return "لا جلسات";
  if (count === 1) return "جلسة واحدة";
  if (count === 2) return "جلستان";
  if (count <= 10) return `${count} جلسات`;
  return `${count} جلسة`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
