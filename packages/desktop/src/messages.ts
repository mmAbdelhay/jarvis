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
  //
  // Ruling P25: the pane and the voice lane (core's gitDiffOpenedText,
  // packages/core/src/git/messages.ts) describe the same condition in the
  // same moment for the same file, so they use the same wording — this is
  // that sentence minus its trailing `: ${path}` clause, since the pane
  // already shows the filename in its own header and does not need it
  // repeated inside the note.
  diffBinaryFile: (language: "ar" | "en"): string =>
    language === "ar" ? "هذا ملف ثنائي ولا يمكن عرض فروقه." : "Binary file — no diff to show.",
  // GitFileDiff.tooLarge (ruling P8): the file or its diff exceeded the
  // provider's size cap and was never read, so this is deliberately a
  // different sentence from diffBinaryFile — "too big to show" is not the
  // same fact as "not text", and conflating them was Task 14's first-draft
  // mistake this message exists to avoid repeating. Wording reused from
  // core's gitDiffOpenedText per ruling P25, same as diffBinaryFile above.
  diffTooLarge: (language: "ar" | "en"): string =>
    language === "ar" ? "الملف كبير جدًا لعرض الفروق." : "Too large to show a diff for.",
  // hunks.length === 0 with binary and tooLarge both false: a real diff
  // read that simply found nothing to show (e.g. a mode-only change, or
  // the file picked from the list has since gone back to matching HEAD).
  diffNoChanges: (language: "ar" | "en"): string =>
    language === "ar" ? "لا توجد تغييرات لعرضها." : "No changes to show.",
  // I2: the Changes view shipped as an English-only lane in an
  // Arabic-primary app (Global Constraints names this exact defect — it was
  // a real phase-1 regression). Every string below routes through here
  // instead of a literal in changes.ts/index.html.
  //
  // "Commit N files" is the sharpest case: a counted noun, not a sentence
  // with a number dropped in — exactly what arabicSessionsCount above
  // exists for. It uses a table of its own (arabicFilesCount below), *not*
  // arabicSessionsCount's: see the comment on arabicFilesCount for why the
  // two must stay separate despite looking identical in shape.
  //
  // count === 0 is a case of its own rather than arabicFilesCount("لا ملفات"
  // etc.): "حفظ" (Save/Commit) is a transitive verbal noun, and "Save no
  // files" is not a grammatical verb-object phrase in Arabic any more than
  // it reads naturally in English — there is no noun for it to govern. The
  // button is disabled at zero anyway, so the bare verb is what's shown.
  commitButtonLabel: (count: number, language: "ar" | "en"): string =>
    language === "ar"
      ? count === 0
        ? "حفظ"
        : `حفظ ${arabicFilesCount(count)}`
      : `Commit ${count} ${count === 1 ? "file" : "files"}`,
  // `ago` is formatAgo()'s own already-localised output; this just joins it
  // to the agent id as one label/value pair, same shape as the rest of this
  // table.
  writtenBy: (agentId: string, ago: string, language: "ar" | "en"): string =>
    language === "ar" ? `بواسطة ${agentId} · ${ago}` : `written by ${agentId} · ${ago}`,
  navDashboard: (language: "ar" | "en"): string => (language === "ar" ? "اللوحة" : "Dashboard"),
  navChanges: (language: "ar" | "en"): string => (language === "ar" ? "التغييرات" : "Changes"),
  changedFilesLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "الملفات المعدّلة" : "CHANGED FILES",
  // The header's repo-path/branch separator ("~/projects/acme on
  // feat/checkout-retry"). Both neighbouring values are technical tokens
  // (a filesystem path, a git ref) that stay LTR regardless of language, so
  // this is the same preposition English uses, not a sentence to reorder.
  pathBranchSeparator: (language: "ar" | "en"): string => (language === "ar" ? "على" : "on"),
  sideBySideLabel: (language: "ar" | "en"): string => (language === "ar" ? "جنبًا إلى جنب" : "Side by side"),
  unifiedLabel: (language: "ar" | "en"): string => (language === "ar" ? "موحّد" : "Unified"),
  beforeColumnLabel: (language: "ar" | "en"): string => (language === "ar" ? "قبل" : "BEFORE"),
  afterColumnLabel: (language: "ar" | "en"): string => (language === "ar" ? "بعد" : "AFTER"),
  testsGroupLabel: (language: "ar" | "en"): string => (language === "ar" ? "الاختبارات" : "TESTS"),
  commitMessagePlaceholder: (language: "ar" | "en"): string =>
    language === "ar" ? "رسالة الحفظ…" : "Commit message…",
  stageFileLabel: (language: "ar" | "en"): string => (language === "ar" ? "تجهيز الملف" : "Stage file"),
  unstageFileLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "إلغاء تجهيز الملف" : "Unstage file",
  // Providers panel chrome (Task 9). The account-status *sentences*
  // (providerStatusLine et al.) belong to @jarvis/core's own messages.ts —
  // these are only the panel's own labels, same split as everywhere else
  // in this file (I2: no English-only lane beside a bilingual table).
  providersTitle: (language: "ar" | "en"): string =>
    language === "ar" ? "الحسابات" : "Providers",
  providersEmpty: (language: "ar" | "en"): string =>
    language === "ar" ? "لا توجد حسابات مُعرّفة." : "No providers are configured.",
  // The row's own label. "LEFT", not "USED": the System panel above shows
  // consumption, this shows headroom, and the label is what makes the
  // meter's direction unambiguous.
  capacityLeftLabel: (language: "ar" | "en"): string =>
    language === "ar" ? "المتبقي" : "LEFT",
  // Three different facts, never collapsed into one "unknown".
  capacityUnsupported: (language: "ar" | "en"): string =>
    language === "ar" ? "لا يوفّر قراءة للسعة" : "no capacity reading available",
  capacityUnavailable: (language: "ar" | "en"): string =>
    language === "ar" ? "تعذّرت قراءة السعة" : "capacity couldn't be read",
  capacityNeverRead: (language: "ar" | "en"): string =>
    language === "ar" ? "لم تُقرأ السعة بعد" : "capacity not checked yet",
  // `clock` is an already-formatted HH:MM value, interpolated at the tail.
  // Ruling P30: never "resets in 3 hours" — an absolute time needs no
  // counted noun in Arabic and stays true as the reading ages.
  capacityResetsAt: (clock: string, language: "ar" | "en"): string =>
    language === "ar" ? `يتجدد ${clock}` : `resets ${clock}`,
  capacityAsOf: (clock: string, language: "ar" | "en"): string =>
    language === "ar" ? `حتى ${clock}` : `as of ${clock}`,
  refreshProviders: (language: "ar" | "en"): string =>
    language === "ar" ? "تحديث حالة الحسابات" : "Refresh provider status",
  providerHealth: (state: "degraded" | "outage" | "unknown", language: "ar" | "en"): string => {
    if (state === "degraded") return language === "ar" ? "الخدمة متعثرة" : "service degraded";
    if (state === "outage") return language === "ar" ? "الخدمة متوقفة" : "service down";
    return language === "ar" ? "حالة الخدمة غير معروفة" : "service status unknown";
  },
};

// NOT the same table as arabicSessionsCount below, even though the two
// started out identical (that copy-paste is exactly the bug this comment
// exists to prevent someone re-introducing). The two counted nouns sit in
// grammatically different positions:
//   - arabicSessionsCount's output is a standalone label value ("عدد
//     الجلسات: جلستان") — a bare counted noun, nominative, same as it would
//     be as the subject of a sentence.
//   - arabicFilesCount's output is always the mudaf ilayhi of "حفظ" (an
//     iḍāfa: "حفظ ملفين" = "the committing of two files"), which the masdar
//     "حفظ" governs into the *genitive* — not nominative.
// That only actually shows up at count === 2, where the genitive dual
// (ملفين) differs in spelling from the nominative dual (ملفان) that
// arabicSessionsCount's shape would produce. Every other count (1, 3-10,
// 11+) is spelled the same in both cases once diacritics are dropped, which
// is exactly how the wrong table went unnoticed here. If this file's
// counted noun ever needs to appear standalone too, give it its own
// function rather than reusing this one — don't merge the two tables back
// together.
function arabicFilesCount(count: number): string {
  if (count === 1) return "ملف واحد";
  if (count === 2) return "ملفين"; // genitive dual (not ملفان — see comment above)
  if (count <= 10) return `${count} ملفات`;
  return `${count} ملفًا`;
}

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
