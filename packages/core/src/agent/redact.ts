// The secret-pattern table of os/go/internal/redact, ported for jarvisd's
// memory (design §5): a match becomes "[redacted:<kind>]" and the rest of
// the line stays. Same patterns, same order, same rules (a labelled value
// that is already exactly a marker is left alone, so this is idempotent).
// IP and MAC addresses are deliberately kept. Keep in step with the Go
// table; redact.test.ts carries the Go test cases. Pure.

export type RedactPattern = { kind: string; re: RegExp; keep: boolean };

export const REDACT_PATTERNS: readonly RedactPattern[] = [
  {
    kind: "private_key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    keep: false,
  },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, keep: false },
  { kind: "api_key", re: /\bsk-[A-Za-z0-9_-]{20,}/g, keep: false },
  { kind: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, keep: false },
  { kind: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g, keep: false },
  { kind: "slack_token", re: /\bxox[bap]-[A-Za-z0-9-]{10,}/g, keep: false },
  { kind: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/g, keep: false },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    keep: false,
  },
  { kind: "authorization", re: /(\bauthorization\s*:\s*)[^\r\n]+/gi, keep: true },
  { kind: "bearer", re: /(\bbearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, keep: true },
  {
    kind: "wifi_psk",
    re: /(\b(?:802-11-wireless-security|wifi-sec)\.psk\s*[:=]\s*)\S+/gi,
    keep: true,
  },
  {
    kind: "secret",
    re: /((?:^|[^A-Za-z0-9])["']?(?:password|passwd|secret|token|api[_-]?key|psk)["']?[ \t]*[:=][ \t]*)("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|\[[^\]\r\n]*\]|[^\s&;,]+)/gi,
    keep: true,
  },
];

const MARKER = /^\[redacted:[A-Za-z0-9_]+\]$/;
const VALUE_END = " \t\r\n&;,}])\"'";

function replaceKeepingLabel(re: RegExp, text: string, replacement: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    const valueStart = start + (match[1]?.length ?? 0);
    let end = start + match[0].length;
    if (MARKER.test(text.slice(valueStart, end))) {
      const next = text[end];
      if (next === undefined || VALUE_END.includes(next)) continue;
      // A marker with value characters glued on is not a marker: redact the whole token.
      while (end < text.length && !VALUE_END.includes(text[end] as string)) end++;
    }
    out += text.slice(last, valueStart) + replacement;
    last = end;
  }
  return out + text.slice(last);
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of REDACT_PATTERNS) {
    const replacement = `[redacted:${pattern.kind}]`;
    out = pattern.keep
      ? replaceKeepingLabel(pattern.re, out, replacement)
      : out.replace(pattern.re, replacement);
  }
  return out;
}
