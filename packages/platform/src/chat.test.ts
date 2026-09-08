import { describe, expect, test } from "vitest";
import { CHAT_DRIVERS, chatUrl, isChatDriver } from "./chat.js";

describe("chatUrl", () => {
  test("opens a named Slack workspace at its own subdomain", () => {
    expect(chatUrl({ name: "Acme", driver: "slack", account: "acme" })).toBe(
      "https://acme.slack.com/",
    );
  });

  test("opens Slack's own workspace picker when no account is named", () => {
    expect(chatUrl({ name: "Slack", driver: "slack" })).toBe("https://app.slack.com/client");
  });

  test("opens Teams at a named tenant", () => {
    expect(chatUrl({ name: "Globex", driver: "teams", account: "orbit.com" })).toBe(
      "https://teams.microsoft.com/?tenantId=orbit.com",
    );
  });

  test("opens Teams' own tenant picker when no account is named", () => {
    expect(chatUrl({ name: "Teams", driver: "teams" })).toBe("https://teams.microsoft.com/");
  });

  // An account is config text the user types, and a tenant id with a space
  // or an `&` in it would otherwise silently forge a second query parameter.
  test("percent-encodes an account into the Teams query", () => {
    expect(chatUrl({ name: "Odd", driver: "teams", account: "a&b c" })).toBe(
      "https://teams.microsoft.com/?tenantId=a%26b%20c",
    );
  });

  // A Slack account becomes a hostname label, not a path segment, so the
  // encoding that saves the Teams case cannot save this one — the parser
  // is what keeps a stray dot or slash out of the subdomain.
  test("encodes a Slack account into the subdomain", () => {
    expect(chatUrl({ name: "Odd", driver: "slack", account: "a b" })).toBe(
      "https://a%20b.slack.com/",
    );
  });
});

describe("isChatDriver", () => {
  test("accepts every driver the table declares", () => {
    for (const driver of Object.keys(CHAT_DRIVERS)) {
      expect(isChatDriver(driver)).toBe(true);
    }
  });

  test("rejects a provider that has no driver", () => {
    expect(isChatDriver("discord")).toBe(false);
  });

  test("rejects a value that is not a string", () => {
    expect(isChatDriver(3)).toBe(false);
  });
});

describe("CHAT_DRIVERS", () => {
  test("labels every driver for the Settings picker", () => {
    expect(CHAT_DRIVERS.slack.label).toBe("Slack");
    expect(CHAT_DRIVERS.teams.label).toBe("Teams");
  });
});
