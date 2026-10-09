// Rafiq v1.1 Plan Y §2.1, §2.4: the account provider kind and channels.
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_BASE_URLS,
  ACCOUNT_IDS,
  ACCOUNT_PHASES,
  OS_CONTROL_PUSHES,
  OS_CONTROL_REQUESTS,
  PROVIDER_KINDS,
  parseAccountRequest,
  parseProviderDraft,
  parseProviderSave,
} from "./os-control.js";

describe("Plan Y account contract", () => {
  it("names the kind, accounts and channels exactly", () => {
    expect(PROVIDER_KINDS).toContain("account");
    expect(ACCOUNT_IDS).toEqual(["claude", "chatgpt", "gemini", "copilot"]);
    expect(OS_CONTROL_REQUESTS.accountStatus).toBe("account:status");
    expect(OS_CONTROL_REQUESTS.accountInstall).toBe("account:install");
    expect(OS_CONTROL_REQUESTS.accountLogin).toBe("account:login");
    expect(OS_CONTROL_REQUESTS.accountLogout).toBe("account:logout");
    expect(OS_CONTROL_REQUESTS.accountUninstall).toBe("account:uninstall");
    expect(OS_CONTROL_PUSHES.accountState).toBe("account:state");
    expect(ACCOUNT_PHASES).toEqual([
      "installing",
      "installed",
      "failed",
      "awaiting-browser",
      "signed-in",
    ]);
  });

  it("parses account requests field by field", () => {
    expect(parseAccountRequest([{ account: "gemini" }])).toEqual({
      ok: true,
      value: { account: "gemini" },
    });
    expect(parseAccountRequest([{ account: "bard" }]).ok).toBe(false);
    expect(parseAccountRequest([{ account: "claude", extra: 1 }])).toEqual({
      ok: true,
      value: { account: "claude" },
    });
    expect(parseAccountRequest([]).ok).toBe(false);
    expect(parseAccountRequest([JSON.parse('{"__proto__": {"account": "claude"}}')]).ok).toBe(
      false,
    );
  });

  it("forces the display base URL and refuses a key for an account draft", () => {
    const parsed = parseProviderDraft([{ kind: "account", account: "chatgpt", model: "default" }]);
    expect(parsed).toEqual({
      ok: true,
      value: {
        kind: "account",
        account: "chatgpt",
        baseUrl: ACCOUNT_BASE_URLS.chatgpt,
        model: "default",
      },
    });
    const sneaky = parseProviderDraft([
      { kind: "account", account: "claude", baseUrl: "http://evil.example", model: "default" },
    ]);
    expect(sneaky.ok && sneaky.value.baseUrl).toBe("https://claude.ai");
    expect(
      parseProviderDraft([{ kind: "account", account: "claude", model: "x", apiKey: "sk" }]).ok,
    ).toBe(false);
    expect(parseProviderDraft([{ kind: "account", model: "x" }]).ok).toBe(false);
    expect(
      parseProviderDraft([
        { kind: "anthropic", account: "claude", baseUrl: "https://api.anthropic.com", model: "m" },
      ]).ok,
    ).toBe(false);
  });

  it("saves account providers with their account", () => {
    const parsed = parseProviderSave([
      {
        providers: [{ id: "claude", kind: "account", account: "claude", model: "default" }],
        allowCloudFallback: false,
      },
    ]);
    expect(parsed.ok && parsed.value.providers[0]).toEqual({
      id: "claude",
      kind: "account",
      account: "claude",
      baseUrl: "https://claude.ai",
      model: "default",
    });
  });
});
