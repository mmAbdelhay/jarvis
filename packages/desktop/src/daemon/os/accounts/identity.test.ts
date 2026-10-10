import { describe, expect, it } from "vitest";
import { claudeIdentity, codexIdentity, copilotIdentity, geminiIdentity } from "./identity.js";

const jwt = (payload: object) =>
  `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2lnbmF0dXJl`;

describe("account identity", () => {
  it("claude: oauthAccount.emailAddress from .claude.json", () => {
    expect(
      claudeIdentity(
        JSON.stringify({
          oauthAccount: { emailAddress: "sara@example.com", organizationName: "x" },
        }),
      ),
    ).toBe("sara@example.com");
    expect(claudeIdentity("{}")).toBeNull();
    expect(claudeIdentity("not json")).toBeNull();
  });

  it("chatgpt: only the email claim of the id token, nothing else", () => {
    const text = JSON.stringify({
      tokens: {
        id_token: jwt({ email: "omar@example.com", sub: "user-1" }),
        access_token: "secret-access",
        refresh_token: "secret-refresh",
      },
    });
    expect(codexIdentity(text)).toBe("omar@example.com");
    expect(
      codexIdentity(JSON.stringify({ tokens: { id_token: jwt({ email: "not an email" }) } })),
    ).toBeNull();
    expect(codexIdentity(JSON.stringify({ OPENAI_API_KEY: "sk-x" }))).toBeNull();
  });

  it("gemini: the active Google account", () => {
    expect(geminiIdentity(JSON.stringify({ active: "lina@gmail.com", old: [] }))).toBe(
      "lina@gmail.com",
    );
    expect(geminiIdentity(JSON.stringify({ active: null }))).toBeNull();
  });

  it("copilot: the GitHub login, with the host when it is not github.com", () => {
    expect(
      copilotIdentity(
        `// managed by copilot\n${JSON.stringify({ last_logged_in_user: { host: "https://github.com", login: "octocat" } })}`,
      ),
    ).toBe("octocat");
    expect(
      copilotIdentity(
        JSON.stringify({ logged_in_users: [{ host: "https://acme.ghe.com", login: "dev" }] }),
      ),
    ).toBe("dev@acme.ghe.com");
    expect(copilotIdentity(JSON.stringify({ logged_in_users: [] }))).toBeNull();
  });

  it("never returns control or bidi characters", () => {
    expect(geminiIdentity(JSON.stringify({ active: "a‮b@example.com" }))).toBeNull();
  });
});
