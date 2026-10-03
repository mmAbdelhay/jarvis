import type { GitChanges, GitCommitResult, GitFailure, GitFileDiff } from "./types.js";

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
  "invalid-branch": {
    ar: (detail) => `لا يصلح هذا اسمًا لفرع: ${detail}`,
    en: (detail) => `That can't be a branch name: ${detail}`,
  },
  "no-upstream": {
    ar: () => "هذا الفرع لا يتتبّع فرعًا بعيدًا بعد. ادفعه أولًا.",
    en: () => "This branch doesn't track a remote branch yet. Push it first.",
  },
  "no-remote": {
    ar: () => "لا يوجد مستودع بعيد مضاف لهذا المستودع.",
    en: () => "This repository has no remote to push to.",
  },
  diverged: {
    ar: () => "تفرّع هذا الفرع عن البعيد، ولا يمكن تقديمه دون دمج. اسحب من الطرفية.",
    en: () =>
      "This branch and its remote have diverged; it can't fast-forward. Pull from the terminal.",
  },
  rejected: {
    ar: () => "رفض البعيد الدفع: فيه تعديلات ليست هنا. اسحب أولًا.",
    en: () => "The remote rejected the push: it has commits you don't. Pull first.",
  },
  detached: {
    ar: () => "لا يوجد فرع مسحوب حاليًا (HEAD منفصل).",
    en: () => "No branch is checked out (detached HEAD).",
  },
  "not-a-worktree": {
    ar: () => "هذه الجلسة لا تعمل في worktree خاصة بها.",
    en: () => "This session isn't running in a worktree of its own.",
  },
  "base-dirty": {
    ar: (detail) => `في النسخة الرئيسية تعديلات غير محفوظة، فلن أدمج فوقها: ${detail}`,
    en: (detail) =>
      `The main checkout has uncommitted changes, so I won't merge into it: ${detail}`,
  },
  "worktree-dirty": {
    ar: () => "في الـ worktree تعديلات غير محفوظة. احفظها أولًا.",
    en: () => "The worktree has uncommitted changes. Commit them first.",
  },
  "no-gh": {
    ar: (detail) => `يلزم GitHub CLI (gh) مسجّلًا للدخول لفتح طلب سحب: ${detail}`,
    en: (detail) => `Opening a pull request needs the GitHub CLI (gh), signed in: ${detail}`,
  },
};

export function gitFailureText(failure: GitFailure, language: Language): string {
  return FAILURES[failure.code][language](failure.detail);
}

// Deliberately a label/value list rather than a natural-language sentence:
// Arabic number agreement (ملف / ملفان / ملفات / ملفًا) changes with the
// count, and a template that inlines a number into a noun phrase is wrong for
// most counts. Labels sidestep it and stay readable in both languages.
//
// The branch name is interpolated as its own tail-anchored sentence, not
// spliced mid-string ahead of an em dash: an ASCII/Latin branch name sitting
// inside an RTL run before a "—" is a bidi reordering risk in a transcript
// (ruling P14). Every interpolated value here ends its own clause.
export function gitChangesText(changes: GitChanges, fileCount: number, language: Language): string {
  return language === "ar"
    ? `الملفات المعدّلة: ${fileCount}، الإضافات: ${changes.insertions}، المحذوفات: ${changes.deletions}. الفرع: ${changes.branch}.`
    : `Changed files: ${fileCount}, insertions: ${changes.insertions}, deletions: ${changes.deletions}. Branch: ${changes.branch}.`;
}

// Names the project and the file count so a wrong-repo or unexpectedly-wide
// commit is audible (ruling P13): a model that resolves the wrong sessionId
// still commits the right-looking sha, but the project name and file count
// make that mistake catchable by ear. Label/value form again, for the same
// Arabic-agreement reason as gitChangesText, and every value sits at the
// tail of its own clause for the same bidi reason.
// `excludedUntracked` (ruling P27): voice commit stages only what the user
// already staged by hand, falling back to tracked-modified files when
// nothing was staged — it never auto-stages untracked files. When that
// leaves untracked files out of the commit, this says so as one more
// label/value clause (same Arabic-agreement-sidestepping shape as the rest
// of this function) rather than letting the user assume "commit" swept up
// everything git status showed.
export function gitCommitText(
  result: GitCommitResult,
  project: string,
  language: Language,
  excludedUntracked = 0,
): string {
  const base =
    language === "ar"
      ? `تم الكوميت: ${result.sha}. المشروع: ${project}. عدد الملفات: ${result.filesChanged}.`
      : `Committed: ${result.sha}. Project: ${project}. Files: ${result.filesChanged}.`;
  if (excludedUntracked <= 0) return base;
  const excluded =
    language === "ar"
      ? ` ملفات غير متتبعة استُبعدت: ${excludedUntracked}.`
      : ` Untracked files left out: ${excludedUntracked}.`;
  return base + excluded;
}

// Branches on both `binary` and `tooLarge` (ruling P8's flag) so a file the
// pane cannot actually show is never announced as an opened diff — a
// "$ok:true" outcome with `hunks: []` looks identical to a real empty diff
// unless the caller checks these two flags explicitly (ruling P12).
export function gitDiffOpenedText(diff: GitFileDiff, language: Language): string {
  if (diff.tooLarge) {
    return language === "ar"
      ? `الملف كبير جدًا لعرض الفروق: ${diff.path}.`
      : `Too large to show a diff for: ${diff.path}.`;
  }
  if (diff.binary) {
    return language === "ar"
      ? `هذا ملف ثنائي ولا يمكن عرض فروقه: ${diff.path}.`
      : `Binary file — no diff to show: ${diff.path}.`;
  }
  return language === "ar" ? `فتحت الفروق لملف ${diff.path}.` : `Opened the diff for ${diff.path}.`;
}
