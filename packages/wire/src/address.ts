// The one address canonicaliser the remote bridge (and, from M6, the
// phone) trusts. `bindChoices` (packages/remote's interfaces.ts) classifies
// a *local* interface address; this file answers a different question —
// "is this string the one canonical spelling of an IP literal?" — for
// addresses that arrive from outside: a config's `bindAddress`, a socket's
// remote address, a pairing link's `host`. Both the pairing-link check and
// the connection-source check must agree on what "the same address" means,
// so there is exactly one normaliser and everything else calls it rather
// than comparing strings directly.
//
// This is a pure hand parser — no `node:net`, so it also runs on the
// phone (React Native has no `node:*`). It reproduces `node:net`'s `isIP`
// semantics: IPv4 is exactly four decimal octets 0-255, no leading zeros
// other than a lone "0"; IPv6 follows RFC 4291's text forms, including
// "::" compression and an embedded IPv4 tail. RFC 5952 §4 sets the
// canonical IPv6 form this produces: lowercase hex, no leading zeros in a
// group, and the *longest* run of two-or-more all-zero groups (the
// earliest on a tie) written as `::`. An IPv4-mapped address
// (`::ffff:a.b.c.d`, in any of its hex/dotted spellings) collapses to
// plain dotted IPv4, per §5 — a mapped address and its IPv4 form name the
// same peer, and callers that compare canonical strings need that to be
// true.

const ZONE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// A single 0-255 decimal octet with no leading zeros other than a lone
// "0" — the same rule `node:net`'s IPv4 parser applies, and the rule an
// embedded IPv4 tail inside an IPv6 address must also satisfy.
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_PATTERN = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
const OCTET_ONLY = new RegExp(`^${OCTET}$`);

export function canonicalAddress(address: string): string | undefined {
  const percentAt = address.indexOf("%");
  const base = percentAt === -1 ? address : address.slice(0, percentAt);
  const zone = percentAt === -1 ? undefined : address.slice(percentAt + 1);
  if (zone !== undefined && !ZONE_PATTERN.test(zone)) return undefined;

  if (IPV4_PATTERN.test(base)) {
    // A zone id names an interface, which only means something for a
    // link-local IPv6 address; nothing can bind IPv4 "on en0" specifically.
    return zone === undefined ? base : undefined;
  }

  const groups = ipv6Groups(base);
  if (groups === undefined) return undefined;
  const mapped = ipv4Mapped(groups);
  if (mapped !== undefined) return mapped;
  const formatted = formatIPv6(groups);
  return zone === undefined ? formatted : `${formatted}%${zone}`;
}

/** True for the canonical spelling of "no particular address" — IPv4 0.0.0.0 or IPv6 ::. */
export function isUnspecifiedAddress(canonical: string): boolean {
  return canonical === "0.0.0.0" || canonical === "::";
}

/** True only for a syntactically real IPv4 or IPv6 literal — never a hostname, however IP-shaped it looks. */
export function isIpLiteral(host: string): boolean {
  return canonicalAddress(host) !== undefined;
}

/**
 * True for a loopback host: IPv4 127.0.0.0/8, or IPv6 `::1` — checked
 * against the canonical form, never a string prefix test. A prefix test
 * (`host.startsWith("127.")`) is exactly what a hostname like
 * `127.evil.example.com` or `127.0.0.1.evil.com` is built to pass.
 *
 * Deliberately broader than the M4 probe-client version this replaces,
 * which recognised only the literal string `"::1"` or a raw `127.*`
 * prefix: because this checks the *canonical form*, an IPv4-mapped
 * spelling (`::ffff:127.0.0.1`) and a fully expanded one
 * (`0:0:0:0:0:0:0:1`) are correctly loopback too — they canonicalise to
 * `127.0.0.1` and `::1` respectively, the same addresses under any other
 * spelling.
 */
export function isLoopback(host: string): boolean {
  const canonical = canonicalAddress(host);
  if (canonical === undefined) return false;
  if (canonical === "::1") return true;
  return !canonical.includes(":") && canonical.startsWith("127.");
}

/** The eight 16-bit groups of a syntactically valid IPv6 address, or undefined if `base` is not one. */
function ipv6Groups(base: string): number[] | undefined {
  const halves = base.split("::");
  if (halves.length > 2) return undefined;
  const compressed = halves.length === 2;
  const splitHalf = (half: string | undefined): string[] =>
    half === undefined || half === "" ? [] : half.split(":");
  const headText = splitHalf(halves[0]);
  const tailText = splitHalf(halves[1]);

  // A dotted-decimal IPv4 tail, when present, is always the last token of
  // the whole address — never the head of a "::"-compressed one, however
  // the zero run lands. So a dotted last token expands only in the head of
  // an *uncompressed* address (no "::" at all); everywhere else — the tail
  // after "::", or a compressed address with no tail ("1.2.3.4::") — a dot
  // in the head is refused, not silently reinterpreted.
  const head = compressed || tailText.length > 0 ? plainHex(headText) : expandDottedTail(headText);
  const tail = tailText.length > 0 ? expandDottedTail(tailText) : [];
  if (head === undefined || tail === undefined) return undefined;

  const missing = 8 - head.length - tail.length;
  if (compressed ? missing < 1 : missing !== 0) return undefined;
  const zeros = Array<number>(compressed ? missing : 0).fill(0);
  return [...head, ...zeros, ...tail];
}

function plainHex(groups: string[]): number[] | undefined {
  const values = groups.map(parseHex);
  return values.every((value): value is number => value !== undefined) ? values : undefined;
}

/** Parses `groups`, expanding a trailing dotted-IPv4 token (e.g. "ffff", "192.168.1.5") if present. */
function expandDottedTail(groups: string[]): number[] | undefined {
  if (groups.length === 0) return [];
  const last = groups[groups.length - 1] ?? "";
  if (!last.includes(".")) return plainHex(groups);

  const octets = last.split(".");
  if (octets.length !== 4 || !octets.every((octet) => OCTET_ONLY.test(octet))) {
    return undefined;
  }
  const [o0 = 0, o1 = 0, o2 = 0, o3 = 0] = octets.map(Number);
  const head = plainHex(groups.slice(0, -1));
  if (head === undefined) return undefined;
  return [...head, (o0 << 8) | o1, (o2 << 8) | o3];
}

function parseHex(group: string): number | undefined {
  return /^[0-9a-fA-F]{1,4}$/.test(group) ? Number.parseInt(group, 16) : undefined;
}

/** `::ffff:a.b.c.d` in any spelling names the same peer as plain IPv4 `a.b.c.d`. */
function ipv4Mapped(groups: number[]): string | undefined {
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  if (g0 !== 0 || g1 !== 0 || g2 !== 0 || g3 !== 0 || g4 !== 0 || g5 !== 0xffff) return undefined;
  return `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
}

/** RFC 5952 §4: lowercase, no leading zeros, the longest ≥2-zero-group run (first on a tie) as "::". */
function formatIPv6(groups: number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;
  for (let index = 0; index < groups.length; index++) {
    if (groups[index] === 0) {
      if (runStart === -1) runStart = index;
      runLength++;
      if (runLength > bestLength) {
        bestLength = runLength;
        bestStart = runStart;
      }
    } else {
      runStart = -1;
      runLength = 0;
    }
  }
  if (bestLength < 2) return groups.map((group) => group.toString(16)).join(":");

  const before = groups.slice(0, bestStart).map((group) => group.toString(16));
  const after = groups.slice(bestStart + bestLength).map((group) => group.toString(16));
  return `${before.join(":")}::${after.join(":")}`;
}
