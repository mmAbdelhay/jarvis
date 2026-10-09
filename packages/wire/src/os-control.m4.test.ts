import { describe, expect, it } from "vitest";
import {
  OS_CONTROL_PUSHES,
  OS_CONTROL_REQUESTS,
  parseProviderDraft,
  parseProviderSave,
  parseUiSetLanguage,
  RESERVED_PROVIDER_IDS,
  UI_LANGUAGES,
} from "./os-control.js";

describe("Rafiq M4 language channels (contracts §3)", () => {
  it("names ui:setLanguage and ui:language exactly", () => {
    expect(OS_CONTROL_REQUESTS.uiSetLanguage).toBe("ui:setLanguage");
    expect(OS_CONTROL_PUSHES.uiLanguage).toBe("ui:language");
    expect(UI_LANGUAGES).toEqual(["en", "ar"]);
  });

  it("parses ui:setLanguage field by field", () => {
    expect(parseUiSetLanguage([{ lang: "ar" }])).toEqual({ ok: true, value: { lang: "ar" } });
    expect(parseUiSetLanguage([{ lang: "en", extra: 1 }])).toEqual({
      ok: true,
      value: { lang: "en" },
    });
    for (const bad of [
      [],
      [{}],
      [{ lang: "fr" }],
      [{ lang: "AR" }],
      [{ lang: "ar" }, {}],
      ["ar"],
    ]) {
      expect(parseUiSetLanguage(bad).ok).toBe(false);
    }
  });
});

describe("the backup provider id is reserved (contracts §1)", () => {
  const draft = { kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" };

  it("refuses id backup in provider:save and provider:probe", () => {
    expect(RESERVED_PROVIDER_IDS.has("backup")).toBe(true);
    expect(
      parseProviderSave([{ providers: [{ ...draft, id: "backup" }], allowCloudFallback: false }])
        .ok,
    ).toBe(false);
    expect(parseProviderDraft([{ ...draft, id: "backup" }]).ok).toBe(false);
  });

  it("still accepts ids that only start with backup", () => {
    expect(
      parseProviderSave([{ providers: [{ ...draft, id: "backup-2" }], allowCloudFallback: false }])
        .ok,
    ).toBe(true);
  });
});
