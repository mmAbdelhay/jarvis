import { describe, expect, it } from "vitest";
import { gitChangesText, gitCommitText, gitDiffOpenedText, gitFailureText } from "./messages.js";
import type { GitFileDiff } from "./types.js";

describe("gitFailureText", () => {
  it("names the repository problem in both languages", () => {
    const failure = { code: "not-a-repo", detail: "/tmp/nope" } as const;
    expect(gitFailureText(failure, "en")).toBe("That folder isn't a git repository.");
    expect(gitFailureText(failure, "ar")).toBe("هذا المجلد ليس مستودع git.");
  });

  it("puts the raw git detail at the tail of the Arabic sentence", () => {
    const failure = { code: "failed", detail: "fatal: bad object" } as const;
    const arabic = gitFailureText(failure, "ar");
    expect(arabic.endsWith("fatal: bad object")).toBe(true);
  });

  it("covers every failure code in both languages", () => {
    const codes = ["not-a-repo", "nothing-staged", "empty-message", "conflict", "failed"] as const;
    for (const code of codes) {
      for (const language of ["ar", "en"] as const) {
        const text = gitFailureText({ code, detail: "d" }, language);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toContain("undefined");
      }
    }
  });
});

describe("gitChangesText", () => {
  const changes = {
    repoPath: "/p",
    branch: "feat/checkout-retry",
    detached: false,
    files: [],
    insertions: 128,
    deletions: 34,
  };

  it("reads as a label/value list so number agreement never breaks in Arabic", () => {
    expect(gitChangesText({ ...changes, files: [] }, 7, "ar")).toBe(
      "الملفات المعدّلة: 7، الإضافات: 128، المحذوفات: 34. الفرع: feat/checkout-retry.",
    );
    expect(gitChangesText({ ...changes, files: [] }, 7, "en")).toBe(
      "Changed files: 7, insertions: 128, deletions: 34. Branch: feat/checkout-retry.",
    );
  });

  it("puts the branch name at the tail of the Arabic sentence, not ahead of an em dash", () => {
    const arabic = gitChangesText({ ...changes, files: [] }, 7, "ar");
    expect(arabic.endsWith("الفرع: feat/checkout-retry.")).toBe(true);
    expect(arabic).not.toContain("—");
  });

  it("uses المحذوفات, not the non-standard الحذوفات", () => {
    const arabic = gitChangesText({ ...changes, files: [] }, 7, "ar");
    expect(arabic).toContain("المحذوفات");
    expect(arabic).not.toContain("الحذوفات:");
  });
});

describe("gitCommitText", () => {
  it("names the project and the file count so a wrong-repo or over-wide commit is audible", () => {
    expect(gitCommitText({ sha: "a1b2c3d", filesChanged: 7 }, "acme", "en")).toBe(
      "Committed: a1b2c3d. Project: acme. Files: 7.",
    );
    expect(gitCommitText({ sha: "a1b2c3d", filesChanged: 7 }, "acme", "ar")).toBe(
      "تم الكوميت: a1b2c3d. المشروع: acme. عدد الملفات: 7.",
    );
  });

  it("interpolates at the tail of each clause in Arabic", () => {
    const arabic = gitCommitText({ sha: "a1b2c3d", filesChanged: 7 }, "acme", "ar");
    expect(arabic).toContain("a1b2c3d.");
    expect(arabic.endsWith("عدد الملفات: 7.")).toBe(true);
  });

  it("uses الكوميت, not the calque الالتزام", () => {
    const arabic = gitCommitText({ sha: "a1b2c3d", filesChanged: 1 }, "p", "ar");
    expect(arabic).toContain("الكوميت");
    expect(arabic).not.toContain("الالتزام");
  });

  it("says nothing about untracked files when none were excluded", () => {
    const en = gitCommitText({ sha: "a1b2c3d", filesChanged: 1 }, "p", "en");
    const ar = gitCommitText({ sha: "a1b2c3d", filesChanged: 1 }, "p", "ar");
    expect(en).not.toContain("Untracked");
    expect(ar).not.toContain("غير متتبعة");
  });

  it("names the excluded-untracked count as a label/value clause, in both languages", () => {
    const en = gitCommitText({ sha: "a1b2c3d", filesChanged: 1 }, "p", "en", 2);
    const ar = gitCommitText({ sha: "a1b2c3d", filesChanged: 1 }, "p", "ar", 2);
    expect(en).toContain("Untracked files left out: 2.");
    expect(ar).toContain("ملفات غير متتبعة استُبعدت: 2.");
  });
});

describe("gitDiffOpenedText", () => {
  const base: GitFileDiff = { path: "app/خدمة.php", binary: false, hunks: [] };

  it("says the diff was opened for an ordinary text diff", () => {
    expect(gitDiffOpenedText(base, "ar").endsWith("app/خدمة.php.")).toBe(true);
    expect(gitDiffOpenedText(base, "en")).toBe("Opened the diff for app/خدمة.php.");
  });

  it("says the file is binary instead of claiming a diff opened", () => {
    const diff: GitFileDiff = { ...base, path: "logo.png", binary: true };
    const en = gitDiffOpenedText(diff, "en");
    const ar = gitDiffOpenedText(diff, "ar");
    expect(en).not.toContain("Opened the diff");
    expect(en).toContain("Binary");
    expect(en.endsWith("logo.png.")).toBe(true);
    expect(ar).not.toContain("فتحت الفروق");
    expect(ar).toContain("ثنائي");
    expect(ar.endsWith("logo.png.")).toBe(true);
  });

  it("says the file is too large instead of claiming a diff opened", () => {
    const diff: GitFileDiff = { ...base, path: "big.sql", binary: false, tooLarge: true };
    const en = gitDiffOpenedText(diff, "en");
    const ar = gitDiffOpenedText(diff, "ar");
    expect(en).not.toContain("Opened the diff");
    expect(en).toContain("Too large");
    expect(en.endsWith("big.sql.")).toBe(true);
    expect(ar).not.toContain("فتحت الفروق");
    expect(ar).toContain("كبير");
    expect(ar.endsWith("big.sql.")).toBe(true);
  });

  it("prefers tooLarge over binary when both would apply", () => {
    const diff: GitFileDiff = { ...base, path: "huge.bin", binary: true, tooLarge: true };
    expect(gitDiffOpenedText(diff, "en")).toContain("Too large");
  });
});
