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

describe("errorMessage", () => {
  it("extracts the message from an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error value", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(42)).toBe("42");
  });
});
