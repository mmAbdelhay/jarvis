import { describe, expect, it } from "vitest";
import { formatPairingUri, parsePairingUri } from "./pairing-link.js";
import { HOSTNAME_PATTERN, type PairingLink } from "./protocol.js";

const TOKEN = "A".repeat(43);
const FINGERPRINT = "0123456789abcdef".repeat(4);

describe("pairing URI", () => {
  it("round-trips, including a zoned host", () => {
    const link: PairingLink = {
      host: "fe80::1%en0",
      port: 8443,
      secret: TOKEN,
      fingerprint: FINGERPRINT,
    };
    expect(parsePairingUri(formatPairingUri(link))).toEqual(link);
  });

  const validFields = { v: "1", host: "127.0.0.1", port: "8443", secret: TOKEN, fp: FINGERPRINT };
  const uriWith = (scheme: string, overrides: Partial<typeof validFields> = {}) => {
    const params = new URLSearchParams({ ...validFields, ...overrides });
    return `${scheme}pair?${params.toString()}`;
  };

  it.each<[string, string]>([
    ["a non-canonical host", uriWith("jarvis://", { host: "::ffff:127.0.0.1" })],
    ["port 0", uriWith("jarvis://", { port: "0" })],
    ["port 65536", uriWith("jarvis://", { port: "65536" })],
    ["a 42-char secret", uriWith("jarvis://", { secret: "A".repeat(42) })],
    ["an upper-case fingerprint", uriWith("jarvis://", { fp: "A".repeat(64) })],
    ["a wrong v", uriWith("jarvis://", { v: "2" })],
  ])("refuses %s", (_label, uri) => {
    expect(parsePairingUri(uri)).toBeUndefined();
  });
});

describe("HOSTNAME_PATTERN", () => {
  it.each<string>([
    "mac.tail1234.ts.net",
    "a-b.example",
    "x.y",
    // fix round 1, M6: the 253-char accept boundary, matching the 254-char
    // reject row below (both built the same way, one byte apart).
    Array.from({ length: 5 }, (_, i) => "a".repeat(i === 4 ? 49 : 50)).join("."),
  ])("accepts %s", (value) => {
    expect(HOSTNAME_PATTERN.test(value)).toBe(true);
  });

  it.each<[string, string]>([
    ["upper-case", "Mac.tail.ts.net"],
    ["an IPv4 literal", "192.168.1.2"],
    ["another IPv4 literal", "100.64.0.1"],
    ["an IPv6 literal", "::1"],
    ["a bracketed IPv6 literal", "[::1]"],
    ["a single label", "mac"],
    ["a trailing dot", "mac."],
    ["a leading dot", ".mac"],
    ["a label starting with a hyphen", "-a.b"],
    ["a label ending with a hyphen", "a-.b"],
    ["a 64-char label", `${"a".repeat(64)}.b`],
    ["a 254-char name", Array.from({ length: 5 }, () => "a".repeat(50)).join(".")],
    ["an embedded space", "a b.c"],
    ["an underscore", "a_b.c"],
    ["a trailing port", "a.b:7717"],
  ])("rejects %s", (_label, value) => {
    expect(HOSTNAME_PATTERN.test(value)).toBe(false);
  });
});

describe("pairing URI name (rule 2)", () => {
  const link: PairingLink = {
    host: "127.0.0.1",
    port: 8443,
    secret: TOKEN,
    fingerprint: FINGERPRINT,
  };

  it("formatPairingUri appends &name=... last when name is present", () => {
    const withName = { ...link, name: "mac.tail.ts.net" };
    expect(formatPairingUri(withName)).toBe(`${formatPairingUri(link)}&name=mac.tail.ts.net`);
  });

  it("formatPairingUri without name is byte-identical to M6's output", () => {
    expect(formatPairingUri(link)).toBe(
      `jarvis://pair?v=1&host=127.0.0.1&port=8443&secret=${TOKEN}&fp=${FINGERPRINT}`,
    );
  });

  it("round-trips a link with name", () => {
    const withName = { ...link, name: "mac.tail.ts.net" };
    expect(parsePairingUri(formatPairingUri(withName))).toEqual(withName);
  });

  it.each<[string, string]>([
    ["an IP literal", "192.168.1.2"],
    ["an upper-case name", "Mac.x"],
  ])("refuses a name of %s", (_label, name) => {
    const uri = `${formatPairingUri(link)}&name=${name}`;
    expect(parsePairingUri(uri)).toBeUndefined();
  });
});
