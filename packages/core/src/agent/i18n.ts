// Rafiq M4 contracts §3: the two languages jarvisd speaks, the session's
// default from LANGUAGE/LANG, and a turn's language from its prompt. Pure.
import type { UiLanguage } from "./contract.js";

export type Lang = UiLanguage;
/** One value per language; tsc makes both columns present. */
export type Localized<T> = Readonly<Record<Lang, T>>;

export const LANGS: readonly Lang[] = ["en", "ar"];
export const DEFAULT_LANG: Lang = "en";

/** Arabic letters only: no diacritics (U+064B–U+065F), no tatweel (U+0640),
 *  no Arabic-Indic digits. */
const ARABIC_LETTERS = /[ء-غف-يٱ-ۓۺ-ۼݐ-ݿࢠ-ࣉﭐ-ﷻﹰ-ﻼ]/gu;
const LATIN_LETTERS = /[A-Za-zÀ-ɏ]/g;

/** Fewer letters than this say nothing about the language ("ok", "👍"). */
export const MIN_DETECT_LETTERS = 3;
/** Arabic prompts often carry Latin names (vlc, bluetooth): this share of
 *  Arabic letters is enough. */
export const ARABIC_SHARE = 0.3;

export function parseLang(value: unknown): Lang | undefined {
  return value === "en" || value === "ar" ? value : undefined;
}

export function hasArabic(text: string): boolean {
  return text.match(ARABIC_LETTERS) !== null;
}

/** gettext order for messages: LANGUAGE's first entry, then LANG. */
export function langFromLocale(env: {
  LANG?: string | undefined;
  LANGUAGE?: string | undefined;
}): Lang {
  for (const value of [env.LANGUAGE?.split(":")[0], env.LANG]) {
    if (value === undefined || value === "") continue;
    const code = value.split(/[_.@]/)[0]?.toLowerCase();
    return code === "ar" ? "ar" : "en";
  }
  return DEFAULT_LANG;
}

export function detectPromptLang(text: string): Lang | undefined {
  const arabic = text.match(ARABIC_LETTERS)?.length ?? 0;
  const latin = text.match(LATIN_LETTERS)?.length ?? 0;
  if (arabic + latin < MIN_DETECT_LETTERS) return undefined;
  if (arabic / (arabic + latin) >= ARABIC_SHARE) return "ar";
  return arabic === 0 ? "en" : undefined;
}

/** M4 §3: os.language, or the prompt's language when the user writes in the other one. */
export function turnLanguage(uiLanguage: Lang, prompt: string): Lang {
  return detectPromptLang(prompt) ?? uiLanguage;
}

/** Model-facing (English, like every instruction to the model). */
export function languageRule(lang: Lang): string {
  return lang === "ar"
    ? "Reply in Modern Standard Arabic unless the user asks for another language. Keep tool names, commands, file paths and package names in their original Latin form."
    : "Reply in English unless the user asks for another language.";
}
