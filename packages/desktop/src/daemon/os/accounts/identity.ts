// "Signed in as <account>" (Plan Y §1.2), read from each CLI's own files.
// Only a display name ever leaves this module: never a token, never the rest
// of a file. For ChatGPT that means decoding the id_token's payload in memory
// and keeping its `email` claim only (the signature is not checked: this is a
// label, not an authorization decision).
//
// No electron here (core/no-electron.test.ts).
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const UNSAFE = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

function json(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
const email = (value: unknown): string | null =>
  typeof value === "string" && EMAIL.test(value) && !UNSAFE.test(value) ? value : null;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function claudeIdentity(claudeJson: string): string | null {
  return email(record(json(claudeJson)?.["oauthAccount"])["emailAddress"]);
}

export function codexIdentity(authJson: string): string | null {
  const token = record(json(authJson)?.["tokens"])["id_token"];
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    return email(record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))["email"]);
  } catch {
    return null;
  }
}

export function geminiIdentity(accountsJson: string): string | null {
  return email(json(accountsJson)?.["active"]);
}

export function copilotIdentity(configText: string): string | null {
  const body = configText
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  const config = json(body);
  if (config === null) return null;
  const users = Array.isArray(config["logged_in_users"]) ? config["logged_in_users"] : [];
  const user = record(config["last_logged_in_user"] ?? users[0]);
  const login = user["login"];
  if (typeof login !== "string" || !LOGIN.test(login)) return null;
  let host = "github.com";
  try {
    host = new URL(String(user["host"] ?? "https://github.com")).hostname;
  } catch {
    return null;
  }
  return host === "github.com" ? login : `${login}@${host}`;
}
