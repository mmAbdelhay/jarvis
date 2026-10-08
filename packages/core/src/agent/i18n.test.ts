import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANG,
  detectPromptLang,
  hasArabic,
  langFromLocale,
  languageRule,
  parseLang,
  turnLanguage,
} from "./i18n.js";

describe("detectPromptLang (M4 §3)", () => {
  it("reads Arabic prompts as Arabic, even with Latin package names", () => {
    expect(detectPromptLang("ثبّت لي vlc")).toBe("ar");
    expect(detectPromptLang("الإنترنت لا يعمل")).toBe("ar");
    expect(detectPromptLang("شغّل bluetooth من فضلك")).toBe("ar");
  });

  it("reads Latin-only prompts as English", () => {
    expect(detectPromptLang("install vlc please")).toBe("en");
    expect(detectPromptLang("Wi-Fi is down")).toBe("en");
  });

  it("has no opinion on short text or a mostly-Latin sentence with one Arabic word", () => {
    expect(detectPromptLang("ok")).toBeUndefined();
    expect(detectPromptLang("👍 123")).toBeUndefined();
    expect(
      detectPromptLang("please install the package called مشغل for me now thanks"),
    ).toBeUndefined();
  });

  it("counts letters, not diacritics, tatweel or Arabic-Indic digits", () => {
    expect(detectPromptLang("نَعَم ١٢٣")).toBe("ar");
    expect(detectPromptLang("ـــ ١٢٣٤")).toBeUndefined();
  });
});

describe("turnLanguage", () => {
  it("is the UI language unless the prompt is clearly in the other one", () => {
    expect(turnLanguage("ar", "install vlc")).toBe("en");
    expect(turnLanguage("en", "ثبّت vlc")).toBe("ar");
    expect(turnLanguage("ar", "ok")).toBe("ar");
    expect(turnLanguage("en", "ok")).toBe("en");
  });
});

describe("langFromLocale", () => {
  it("uses LANGUAGE's first entry, then LANG", () => {
    expect(langFromLocale({ LANG: "ar_EG.UTF-8" })).toBe("ar");
    expect(langFromLocale({ LANGUAGE: "ar:en", LANG: "en_US.UTF-8" })).toBe("ar");
    expect(langFromLocale({ LANGUAGE: "en_GB:ar", LANG: "ar_EG.UTF-8" })).toBe("en");
    expect(langFromLocale({ LANGUAGE: "", LANG: "ar_SA.UTF-8@latin" })).toBe("ar");
  });

  it("falls back to English for C, unknown or similar-looking codes", () => {
    expect(langFromLocale({ LANG: "C.UTF-8" })).toBe("en");
    expect(langFromLocale({})).toBe(DEFAULT_LANG);
    expect(langFromLocale({ LANG: "arn_CL.UTF-8" })).toBe("en");
    expect(langFromLocale({ LANG: "fr_FR.UTF-8" })).toBe("en");
  });
});

describe("parseLang, hasArabic, languageRule", () => {
  it("parses exactly en and ar", () => {
    expect(parseLang("ar")).toBe("ar");
    expect(parseLang("en")).toBe("en");
    expect(parseLang("AR")).toBeUndefined();
    expect(parseLang(1)).toBeUndefined();
  });

  it("finds Arabic letters", () => {
    expect(hasArabic("abc")).toBe(false);
    expect(hasArabic("مرحبا")).toBe(true);
  });

  it("tells the model which language to answer in, in English", () => {
    expect(languageRule("ar")).toContain("Modern Standard Arabic");
    expect(languageRule("en")).toContain("English");
    expect(hasArabic(languageRule("ar"))).toBe(false);
  });
});
