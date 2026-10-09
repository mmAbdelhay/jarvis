import { describe, expect, it } from "vitest";
import { cleanTranscript, normalizePhrase } from "./phrases.js";

describe("normalizePhrase", () => {
  it("folds case, punctuation and spacing", () => {
    expect(normalizePhrase("  Yes!  ")).toBe("yes");
    expect(normalizePhrase("Undo, the LAST change.")).toBe("undo the last change");
  });
  it("folds Arabic diacritics, tatweel, alef forms and Arabic punctuation", () => {
    expect(normalizePhrase("نَعَم.")).toBe("نعم");
    expect(normalizePhrase("مـوافـق؟")).toBe("موافق");
    expect(normalizePhrase("تراجع عن آخر تغيير")).toBe("تراجع عن اخر تغيير");
    expect(normalizePhrase("أوافق")).toBe("اوافق");
  });
});

describe("cleanTranscript", () => {
  it("drops whisper's non-speech markers", () => {
    expect(cleanTranscript(" [BLANK_AUDIO] ")).toBe("");
    expect(cleanTranscript("(music) yes")).toBe("yes");
    expect(cleanTranscript("make the screen brighter")).toBe("make the screen brighter");
  });
});
