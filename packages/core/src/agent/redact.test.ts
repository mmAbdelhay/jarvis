import { describe, expect, it } from "vitest";
import { REDACT_PATTERNS, redactSecrets } from "./redact.js";

const CASES: [string, string][] = [
  [
    "key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\ndone",
    "key:\n[redacted:private_key]\ndone",
  ],
  ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow", "[redacted:private_key]"],
  [
    "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
    "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
  ],
  ["using sk-ant-api03-AbCdEf0123456789xyz now", "using [redacted:anthropic_key] now"],
  ["sk-ant-short", "sk-ant-short"],
  ["OPENAI sk-proj-AbCdEfGhIjKlMnOpQrSt12", "OPENAI [redacted:api_key]"],
  ["task-0123456789abcdefghijk", "task-0123456789abcdefghijk"],
  ["ghp_0123456789abcdefghijABCDEFGHIJ012345 pushed", "[redacted:github_token] pushed"],
  ["github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "[redacted:github_pat]"],
  ["xoxb-1234567890-abcdefghij", "[redacted:slack_token]"],
  ["id AKIAIOSFODNN7EXAMPLE ok", "id [redacted:aws_key] ok"],
  ["XAKIAIOSFODNN7EXAMPLE", "XAKIAIOSFODNN7EXAMPLE"],
  [
    "tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end",
    "tok [redacted:jwt] end",
  ],
  ["> Authorization: Basic dXNlcjpwYXNz", "> Authorization: [redacted:authorization]"],
  ["authorization failed for user jarvis", "authorization failed for user jarvis"],
  ["curl -H 'X: Bearer abcdefghijklmnop1234'", "curl -H 'X: Bearer [redacted:bearer]'"],
  [
    "802-11-wireless-security.psk:hunter2hunter2",
    "802-11-wireless-security.psk:[redacted:wifi_psk]",
  ],
  ["wifi-sec.psk = hunter2hunter2", "wifi-sec.psk = [redacted:wifi_psk]"],
  ["802-11-wireless-security.key-mgmt:wpa-psk", "802-11-wireless-security.key-mgmt:wpa-psk"],
  ["login password=hunter2 ok", "login password=[redacted:secret] ok"],
  [`client_secret="a b c" next`, "client_secret=[redacted:secret] next"],
  ["passwordless=true", "passwordless=true"],
  ["password changed for jarvis", "password changed for jarvis"],
  ["tokens=5", "tokens=5"],
  ["password=[hunter2] ok", "password=[redacted:secret] ok"],
  ["token=[abc next", "token=[redacted:secret] next"],
  [`{"password": "hunter2", "user": "ali"}`, `{"password": [redacted:secret], "user": "ali"}`],
  [`{"api_key":"abc123def"}`, `{"api_key":[redacted:secret]}`],
  [`{"secret": "a\\"b", "n": 1}`, `{"secret": [redacted:secret], "n": 1}`],
  [`{"token": ["a", "b"], "n": 1}`, `{"token": [redacted:secret], "n": 1}`],
  [`{'passwd': 'x y'}`, `{'passwd': [redacted:secret]}`],
  ["token: abc123\nuser: ali", "token: [redacted:secret]\nuser: ali"],
  ["  api-key: zzz", "  api-key: [redacted:secret]"],
  ["password:\nuser: ali", "password:\nuser: ali"],
  [`{"token_count": 5}`, `{"token_count": 5}`],
  ["secrets: 3 loaded", "secrets: 3 loaded"],
  ["mytoken: abc", "mytoken: abc"],
  [`"password" "x"`, `"password" "x"`],
  [
    "eth0 192.168.1.20/24 aa:bb:cc:dd:ee:ff gw fe80::1",
    "eth0 192.168.1.20/24 aa:bb:cc:dd:ee:ff gw fe80::1",
  ],
];

describe("redactSecrets (port of os/go/internal/redact)", () => {
  it.each(CASES)("%j", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("has a positive case for every pattern, in the Go order", () => {
    expect(REDACT_PATTERNS.map((p) => p.kind)).toEqual([
      "private_key",
      "anthropic_key",
      "api_key",
      "github_token",
      "github_pat",
      "slack_token",
      "aws_key",
      "jwt",
      "authorization",
      "bearer",
      "wifi_psk",
      "secret",
    ]);
  });

  it("is idempotent and skips only an exact marker", () => {
    for (const input of [
      "password=x Authorization: Bearer abcdefghijklmnop1234 sk-ant-api03-AbCdEf0123456789xyz",
      `{"password": "x", "token": ["a"], "api_key": 'k'}`,
      "token: [abc]\npsk: x\nwifi-sec.psk:abcdefgh",
    ]) {
      const once = redactSecrets(input);
      expect(redactSecrets(once)).toBe(once);
    }
    expect(redactSecrets("password=[redacted:foo]")).toBe("password=[redacted:foo]");
    expect(redactSecrets("password=[redacted:foo]bar")).not.toContain("bar");
  });
});
