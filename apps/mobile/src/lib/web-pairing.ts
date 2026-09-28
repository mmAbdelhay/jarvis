// Pure helpers for the browser pairing screen (app/pair.web.tsx, Task 13).
//
// The web pairing link is `https://<name>:<webPort>/pair#<query>`, where
// `<query>` is exactly the query string of the `jarvis://pair?...` link
// (packages/wire/src/pairing-link.ts). It rides in the fragment so the
// secret never reaches a server log or a Referer header. Every path here
// rebuilds the `jarvis://` form and validates it through `parsePairingUri`,
// so the web and native links share one validator.

import { type PairingLink, parsePairingUri } from "@jarvis/wire";

const JARVIS_PREFIX = "jarvis://pair?";

/** `location.hash` (with or without its leading `#`) → a validated link,
 * or `undefined`. A fragment carrying a second `#` or starting with `?` is
 * refused rather than trimmed. */
export function pairingLinkFromHash(hash: string): PairingLink | undefined {
  const query = hash.startsWith("#") ? hash.slice(1) : hash;
  if (query.length === 0) return undefined;
  if (query.includes("#") || query.startsWith("?")) return undefined;
  return parsePairingUri(`${JARVIS_PREFIX}${query}`);
}

const WEB_LINK_PATTERN = /^https:\/\/[^/?#]+\/pair#/;

/** A pasted link: either the web form (`https://…/pair#…`) or the native
 * `jarvis://pair?…` form. Anything else is `undefined`. */
export function pairingLinkFromText(text: string): PairingLink | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith(JARVIS_PREFIX)) return parsePairingUri(trimmed);
  const match = WEB_LINK_PATTERN.exec(trimmed);
  if (match === null) return undefined;
  return pairingLinkFromHash(trimmed.slice(match[0].length));
}

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bWindows\b/, "Windows"],
  [/\bLinux\b/, "Linux"],
];

const FALLBACK_DEVICE_NAME = "Web browser";

function firstMatch(ua: string, table: ReadonlyArray<readonly [RegExp, string]>) {
  for (const [pattern, label] of table) {
    if (pattern.test(ua)) return label;
  }
  return undefined;
}

/** The pairing screen's default device name, e.g. `Chrome · macOS` — the
 * user can edit it before pairing. Order matters: Edge and Opera also say
 * "Chrome", and every Chromium also says "Safari". */
export function deviceNameFromUserAgent(ua: string): string {
  const browser = firstMatch(ua, BROWSERS);
  const system = firstMatch(ua, SYSTEMS);
  if (browser === undefined || system === undefined) return FALLBACK_DEVICE_NAME;
  return `${browser} · ${system}`;
}

/**
 * D6b: what the pairing screen does with a fragment that arrives while it
 * is already showing (a `/pair#…` link entered in the address bar is only a
 * hashchange, not a new page load). The entry step takes it at once; while
 * the already-paired check is still running it is held for that step;
 * anywhere else (already paired, a confirm or a pairing in flight) it is
 * dropped. The fragment leaves the address bar in every case.
 */
export function fragmentArrivalAction(phaseKind: string): "intake" | "hold" | "drop" {
  if (phaseKind === "scan") return "intake";
  if (phaseKind === "checking") return "hold";
  return "drop";
}

/**
 * D6a: the value that clears Expo Router's `#` route param. `undefined`
 * keeps the key, and the router's URLSearchParams turns it into the string
 * "undefined" — every later URL ended in `#undefined`. An empty string is
 * dropped by both of the router's hash writers.
 */
export const CLEARED_HASH_PARAM = "";
