import { describe, expect, it } from "vitest";
import { gitChangesText, gitCommitText, gitDiffOpenedText, gitFailureText } from "./messages.js";

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
      "الفرع feat/checkout-retry — الملفات المعدّلة: 7، الإضافات: 128، الحذوفات: 34.",
    );
    expect(gitChangesText({ ...changes, files: [] }, 7, "en")).toBe(
      "Branch feat/checkout-retry — changed files: 7, insertions: 128, deletions: 34.",
    );
  });
});

describe("gitCommitText and gitDiffOpenedText", () => {
  it("interpolates at the tail in Arabic", () => {
    expect(gitCommitText({ sha: "a1b2c3d", filesChanged: 7 }, "ar").endsWith("a1b2c3d.")).toBe(true);
    expect(gitDiffOpenedText("app/خدمة.php", "ar").endsWith("app/خدمة.php.")).toBe(true);
  });
});
