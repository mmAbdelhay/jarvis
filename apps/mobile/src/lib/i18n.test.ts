import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Language, type MessageKey, STRINGS, isRtl, languageFromLocale, t } from "./i18n";

const LANGUAGES: Language[] = ["ar", "en"];

describe("STRINGS", () => {
  it("has every key present, non-empty, in both languages, with ar different from en", () => {
    for (const key of Object.keys(STRINGS) as MessageKey[]) {
      for (const language of LANGUAGES) {
        const value = STRINGS[key][language];
        expect(value, `${key}.${language} should be defined`).toBeDefined();
        expect(value.length, `${key}.${language} should be non-empty`).toBeGreaterThan(0);
      }
      expect(STRINGS[key].ar, `${key}: ar should differ from en`).not.toBe(STRINGS[key].en);
    }
  });

  // M12 Task 8, rule 12 — fix round 1 (Minor): pins a dead key's removal so
  // a later edit can't silently reintroduce it. `nav.voice` left this list
  // with the 2026-09-19 redesign: the Voice tab reads it through
  // `t(language, `nav.${name}`)` in app/(tabs)/_layout.tsx, so it is live.
  it("voice.targetSession stays removed", () => {
    const keys = Object.keys(STRINGS);
    expect(keys).not.toContain("voice.targetSession");
  });
});

describe("t", () => {
  it("returns the plain string for a key with no placeholders", () => {
    expect(t("en", "app.title")).toBe(STRINGS["app.title"].en);
    expect(t("ar", "app.title")).toBe(STRINGS["app.title"].ar);
  });

  it("substitutes a single {name}-style param", () => {
    const result = t("en", "settings.restartToApply", { app: "Jarvis", language: "Arabic" });
    expect(result).toContain("Jarvis");
    expect(result).toContain("Arabic");
    expect(result).not.toContain("{app}");
    expect(result).not.toContain("{language}");
  });

  it("substitutes both params of a two-placeholder template", () => {
    const en = t("en", "settings.restartToApply", { app: "Jarvis", language: "English" });
    const ar = t("ar", "settings.restartToApply", { app: "Jarvis", language: "العربية" });
    expect(en).toBe(
      STRINGS["settings.restartToApply"].en
        .replace("{app}", "Jarvis")
        .replace("{language}", "English"),
    );
    expect(ar).toBe(
      STRINGS["settings.restartToApply"].ar
        .replace("{app}", "Jarvis")
        .replace("{language}", "العربية"),
    );
  });

  it("leaves a missing param's placeholder in place", () => {
    const result = t("en", "settings.restartToApply", { app: "Jarvis" });
    expect(result).toContain("{language}");
  });

  it("leaves an unknown placeholder literal when no params are given at all", () => {
    const result = t("en", "settings.restartToApply");
    expect(result).toBe(STRINGS["settings.restartToApply"].en);
    expect(result).toContain("{app}");
    expect(result).toContain("{language}");
  });

  it("substitutes all three params of pair.confirm, in both languages", () => {
    const params = { host: "192.168.1.5", port: 4317, tail: "beef" };
    const en = t("en", "pair.confirm", params);
    const ar = t("ar", "pair.confirm", params);
    for (const result of [en, ar]) {
      expect(result).toContain("192.168.1.5");
      expect(result).toContain("4317");
      expect(result).toContain("beef");
      expect(result).not.toContain("{host}");
      expect(result).not.toContain("{port}");
      expect(result).not.toContain("{tail}");
    }
  });
});

describe("languageFromLocale", () => {
  it("maps ar to ar", () => {
    expect(languageFromLocale("ar")).toBe("ar");
  });

  it("maps ar-EG to ar", () => {
    expect(languageFromLocale("ar-EG")).toBe("ar");
  });

  it("maps ar_SA to ar", () => {
    expect(languageFromLocale("ar_SA")).toBe("ar");
  });

  it("maps en-US to en", () => {
    expect(languageFromLocale("en-US")).toBe("en");
  });

  it("maps fr to en", () => {
    expect(languageFromLocale("fr")).toBe("en");
  });

  it("maps an empty string to en", () => {
    expect(languageFromLocale("")).toBe("en");
  });
});

describe("isRtl", () => {
  it("is true for ar", () => {
    expect(isRtl("ar")).toBe(true);
  });

  it("is false for en", () => {
    expect(isRtl("en")).toBe(false);
  });
});

describe("t: single-{param} interpolation", () => {
  it("substitutes session.trimmed's one {amount} placeholder", () => {
    const en = t("en", "session.trimmed", { amount: "3 lines" });
    const ar = t("ar", "session.trimmed", { amount: "3 lines" });
    expect(en).toBe(STRINGS["session.trimmed"].en.replace("{amount}", "3 lines"));
    expect(ar).toBe(STRINGS["session.trimmed"].ar.replace("{amount}", "3 lines"));
    expect(en).not.toContain("{amount}");
    expect(ar).not.toContain("{amount}");
  });
});

// M12 Task 8, rule 12: `nav.voice` and `voice.targetSession` were defined
// but never referenced anywhere (a source scan proved it before removal —
// see task-8-report.md); the dedicated test right below this block asserts
// they stay gone. REQUIRED_KEYS is a *different* hygiene net: it matches
// only a literal `t(lang, "key")` call's second argument, so it proves a
// key some screen still calls `t()` with can never quietly lose its entry
// in `STRINGS` — fix round 1 correction: it does *not* reach a key used
// only through a dynamic table (e.g. a `NOTICE_KEYS: Record<string,
// MessageKey>` lookup elsewhere in the app), since those values never
// appear as a literal second argument to `t(`.
describe("REQUIRED_KEYS: every message key referenced by app/ or src/ source exists in both languages", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const MOBILE_ROOT = resolve(HERE, "../..");
  // Matches a `t(`'s literal second-argument key, dotted lower-case
  // segments only (the shape every real MessageKey has).
  const KEY_CALL =
    /\bt\(\s*[a-zA-Z0-9_.]+\s*,\s*["']([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)["']/g;

  function collectSourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        files.push(...collectSourceFiles(full));
        continue;
      }
      if (/\.tsx?$/.test(entry)) files.push(full);
    }
    return files;
  }

  function scanReferencedKeys(): Set<string> {
    const required = new Set<string>();
    for (const dir of [join(MOBILE_ROOT, "app"), join(MOBILE_ROOT, "src")]) {
      for (const file of collectSourceFiles(dir)) {
        if (file.endsWith(join("lib", "i18n.ts"))) continue;
        if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(KEY_CALL)) {
          const key = match[1];
          if (key !== undefined) required.add(key);
        }
      }
    }
    return required;
  }

  it("REQUIRED_KEYS is non-trivial and every entry is present, non-empty, in both languages", () => {
    const required = scanReferencedKeys();
    // Sanity: the scan itself actually found real usages — an empty or
    // near-empty set would mean the regex broke, not that nothing calls
    // t() anymore.
    expect(required.size).toBeGreaterThan(50);

    const missing: string[] = [];
    for (const key of required) {
      const entry = (STRINGS as Record<string, { en?: string; ar?: string }>)[key];
      if (entry === undefined || !entry.en || !entry.ar) missing.push(key);
    }
    expect(missing, `referenced but missing/empty in STRINGS: ${missing.join(", ")}`).toEqual([]);
  });
});
