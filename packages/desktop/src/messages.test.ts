import { describe, expect, it } from "vitest";
import { errorMessage, MESSAGES } from "./messages.js";

// Important 9: main.ts must not carry an English-only lane of user-facing
// strings beside @jarvis/core's bilingual MESSAGES table — every string a
// person can see or hear must survive Arabic.
describe("MESSAGES", () => {
  it("renders the hotkey collision message in English", () => {
    expect(MESSAGES.hotkeyCollision("Alt+Space", "en")).toContain("Alt+Space");
    expect(MESSAGES.hotkeyCollision("Alt+Space", "en")).toContain("shortcut");
  });

  it("renders the hotkey collision message in Arabic", () => {
    const text = MESSAGES.hotkeyCollision("Alt+Space", "ar");
    expect(text).toContain("Alt+Space");
    expect(text).toContain("اختصار");
  });

  it("renders the recording-failed message in both languages", () => {
    expect(MESSAGES.recordingFailed("spawn ffmpeg ENOENT", "en")).toContain("spawn ffmpeg ENOENT");
    expect(MESSAGES.recordingFailed("spawn ffmpeg ENOENT", "ar")).toContain("spawn ffmpeg ENOENT");
    expect(MESSAGES.recordingFailed("x", "ar")).toContain("تسجيل");
  });

  it("renders the transcription-failed message in both languages", () => {
    expect(MESSAGES.transcriptionFailed("whisper-cli exited with code 1", "en")).toContain(
      "whisper-cli exited with code 1",
    );
    expect(MESSAGES.transcriptionFailed("x", "ar")).toContain("تحويل الصوت");
  });

  // Cheap fix: app.ts's history-count badge previously read
  // `${sessions.length} sessions` unconditionally, printing "1 sessions".
  describe("sessionsCount", () => {
    it("uses the singular English noun for exactly one session", () => {
      expect(MESSAGES.sessionsCount(1, "en")).toBe("1 session");
    });

    it("uses the plural English noun for zero or more than one session", () => {
      expect(MESSAGES.sessionsCount(0, "en")).toBe("0 sessions");
      expect(MESSAGES.sessionsCount(2, "en")).toBe("2 sessions");
      expect(MESSAGES.sessionsCount(11, "en")).toBe("11 sessions");
    });

    // MSA counted nouns: 0 uses the plural noun with "no", 1 and 2 have
    // dedicated singular/dual forms, 3-10 take the plural noun, and 11+
    // reverts to the singular noun — none of which is English's simple
    // one/many split.
    it("follows Arabic's singular/dual/plural counted-noun forms", () => {
      expect(MESSAGES.sessionsCount(0, "ar")).toBe("لا جلسات");
      expect(MESSAGES.sessionsCount(1, "ar")).toBe("جلسة واحدة");
      expect(MESSAGES.sessionsCount(2, "ar")).toBe("جلستان");
      expect(MESSAGES.sessionsCount(5, "ar")).toBe("5 جلسات");
      expect(MESSAGES.sessionsCount(11, "ar")).toBe("11 جلسة");
    });
  });
});

// arabicFilesCount sits in a *governed* position (mudaf ilayhi of the verbal
// noun "حفظ", an iḍāfa) rather than arabicSessionsCount's standalone-label
// position, so it must not share arabicSessionsCount's table: the dual is
// genitive (ملفين), not nominative (ملفان). Every count is asserted here so
// a future re-merge of the two tables gets caught.
describe("commitButtonLabel", () => {
  it("uses the singular/plural English noun, including at zero", () => {
    expect(MESSAGES.commitButtonLabel(0, "en")).toBe("Commit 0 files");
    expect(MESSAGES.commitButtonLabel(1, "en")).toBe("Commit 1 file");
    expect(MESSAGES.commitButtonLabel(2, "en")).toBe("Commit 2 files");
  });

  it("says just the bare verb at zero, since there is no noun for it to govern", () => {
    expect(MESSAGES.commitButtonLabel(0, "ar")).toBe("حفظ");
  });

  it("uses the genitive dual (ملفين), not the nominative dual (ملفان)", () => {
    expect(MESSAGES.commitButtonLabel(2, "ar")).toBe("حفظ ملفين");
  });

  it("follows Arabic's singular/3-10-plural/11+ counted-noun forms for the rest", () => {
    expect(MESSAGES.commitButtonLabel(1, "ar")).toBe("حفظ ملف واحد");
    expect(MESSAGES.commitButtonLabel(3, "ar")).toBe("حفظ 3 ملفات");
    expect(MESSAGES.commitButtonLabel(11, "ar")).toBe("حفظ 11 ملفًا");
  });
});

describe("pathBranchSeparator", () => {
  it("renders in both languages", () => {
    expect(MESSAGES.pathBranchSeparator("en")).toBe("on");
    expect(MESSAGES.pathBranchSeparator("ar")).toBe("على");
  });
});

describe("unknownSession", () => {
  it("names the session id at the tail in both languages", () => {
    expect(MESSAGES.unknownSession("s1", "ar").endsWith("s1")).toBe(true);
    expect(MESSAGES.unknownSession("s1", "en").endsWith("s1")).toBe(true);
  });

  // MINOR finding on Task 10's review: sessionId is renderer-supplied and
  // was echoed back unbounded.
  it("caps an unbounded sessionId instead of echoing it in full", () => {
    const huge = "x".repeat(10_000);
    const text = MESSAGES.unknownSession(huge, "en");
    expect(text.length).toBeLessThan(200);
    expect(text).not.toContain(huge);
  });
});

describe("invalidArgument", () => {
  it("renders in both languages without echoing anything back", () => {
    expect(MESSAGES.invalidArgument("en").length).toBeGreaterThan(0);
    expect(MESSAGES.invalidArgument("ar").length).toBeGreaterThan(0);
  });
});

describe("changesShowCurrentState", () => {
  it("names the agent and states the caveat in both languages", () => {
    expect(MESSAGES.changesShowCurrentState("claude-acme", "en")).toBe(
      "This session has ended — what's shown below is the repository's current state, not necessarily claude-acme's work.",
    );
    expect(MESSAGES.changesShowCurrentState("claude-acme", "ar")).toBe(
      "انتهت هذه الجلسة — ما يظهر أدناه هو الحالة الحالية للمستودع، وليس بالضرورة ما كتبه claude-acme.",
    );
  });
});

// Ruling P25: these three notices and core's gitDiffOpenedText
// (packages/core/src/git/messages.ts) describe the same GitFileDiff
// conditions for the same file at the same moment, so diffBinaryFile and
// diffTooLarge reuse gitDiffOpenedText's own wording rather than a second
// vocabulary — asserted here by pinning the exact strings.
describe("diffBinaryFile", () => {
  it("renders in both languages, matching core's gitDiffOpenedText wording", () => {
    expect(MESSAGES.diffBinaryFile("en")).toBe("Binary file — no diff to show.");
    expect(MESSAGES.diffBinaryFile("ar")).toBe("هذا ملف ثنائي ولا يمكن عرض فروقه.");
  });
});

describe("diffTooLarge", () => {
  it("renders in both languages, matching core's gitDiffOpenedText wording", () => {
    expect(MESSAGES.diffTooLarge("en")).toBe("Too large to show a diff for.");
    expect(MESSAGES.diffTooLarge("ar")).toBe("الملف كبير جدًا لعرض الفروق.");
  });

  // Ruling P8: tooLarge and binary describe different facts (never read at
  // all, vs. confirmed not text) and must not share wording.
  it("is worded distinctly from diffBinaryFile in both languages", () => {
    expect(MESSAGES.diffTooLarge("en")).not.toBe(MESSAGES.diffBinaryFile("en"));
    expect(MESSAGES.diffTooLarge("ar")).not.toBe(MESSAGES.diffBinaryFile("ar"));
  });
});

describe("diffNoChanges", () => {
  it("renders in both languages", () => {
    expect(MESSAGES.diffNoChanges("en")).toBe("No changes to show.");
    expect(MESSAGES.diffNoChanges("ar")).toBe("لا توجد تغييرات لعرضها.");
  });
});

describe("errorMessage", () => {
  it("extracts the message from an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error value", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(42)).toBe("42");
  });
});
