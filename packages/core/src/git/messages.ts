import type { GitChanges, GitCommitResult, GitFailure } from "./types.js";

type Language = "ar" | "en";

// Same language-in / string-out shape as orchestrator.ts's MESSAGES table.
// Raw git output (`detail`) is always placed at the tail of the sentence so
// nothing depends on the surrounding text's direction.
const FAILURES: Record<GitFailure["code"], Record<Language, (detail: string) => string>> = {
  "not-a-repo": {
    ar: () => "هذا المجلد ليس مستودع git.",
    en: () => "That folder isn't a git repository.",
  },
  "nothing-staged": {
    ar: () => "لا توجد تغييرات مجهّزة للحفظ.",
    en: () => "Nothing is staged to commit.",
  },
  "empty-message": {
    ar: () => "اكتب رسالة للحفظ أولًا.",
    en: () => "Write a commit message first.",
  },
  conflict: {
    ar: () => "هناك تعارض في الدمج يجب حلّه أولًا.",
    en: () => "There's a merge conflict to resolve first.",
  },
  failed: {
    ar: (detail) => `تعذر تنفيذ أمر git: ${detail}`,
    en: (detail) => `The git command failed: ${detail}`,
  },
};

export function gitFailureText(failure: GitFailure, language: Language): string {
  return FAILURES[failure.code][language](failure.detail);
}

// Deliberately a label/value list rather than a natural-language sentence:
// Arabic number agreement (ملف / ملفان / ملفات / ملفًا) changes with the
// count, and a template that inlines a number into a noun phrase is wrong for
// most counts. Labels sidestep it and stay readable in both languages.
export function gitChangesText(changes: GitChanges, fileCount: number, language: Language): string {
  return language === "ar"
    ? `الفرع ${changes.branch} — الملفات المعدّلة: ${fileCount}، الإضافات: ${changes.insertions}، الحذوفات: ${changes.deletions}.`
    : `Branch ${changes.branch} — changed files: ${fileCount}, insertions: ${changes.insertions}, deletions: ${changes.deletions}.`;
}

export function gitCommitText(result: GitCommitResult, language: Language): string {
  return language === "ar"
    ? `حفظت التغييرات في الالتزام ${result.sha}.`
    : `Committed as ${result.sha}.`;
}

export function gitDiffOpenedText(path: string, language: Language): string {
  return language === "ar" ? `فتحت الفروق لملف ${path}.` : `Opened the diff for ${path}.`;
}
