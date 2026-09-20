import { describe, expect, it } from "vitest";
import { canonicalAddress, isIpLiteral, isLoopback, isUnspecifiedAddress } from "./address.js";

describe("canonicalAddress", () => {
  it.each<[string, string]>([
    ["::ffff:127.0.0.1", "127.0.0.1"],
    ["::FFFF:7f00:1", "127.0.0.1"],
    ["0:0:0:0:0:ffff:192.168.1.5", "192.168.1.5"],
    ["::ffff:0.0.0.0", "0.0.0.0"],
    ["::0.0.0.0", "::"],
    ["0:0:0:0:0:0:0:1", "::1"],
    ["FD7A:115C:A1E0:0:0:0:0:1", "fd7a:115c:a1e0::1"],
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["1:0:0:2:0:0:0:3", "1:0:0:2::3"],
    ["fe80::1%en0", "fe80::1%en0"],
    ["1::", "1::"],
  ])("canonicalises %s to %s", (address, expected) => {
    expect(canonicalAddress(address)).toBe(expected);
  });

  it.each<string>([
    "localhost",
    "*.ts.net",
    "127.1",
    "0x7f000001",
    " 127.0.0.1 ",
    "01.2.3.4",
    "1.2.3.4%en0",
    "fe80::1%en0%x",
    "fe80::1%",
    "",
    // A dotted-decimal IPv4 quad is only ever the *last* token of an IPv6
    // literal — never the head of a "::"-compressed one, however the zero
    // run lands.
    "1.2.3.4::",
    "0.0.0.0::",
    "1:2:3:4:5:1.2.3.4::",
    "::1.2.3.4::",
  ])("refuses %j", (address) => {
    expect(canonicalAddress(address)).toBeUndefined();
  });
});

describe("isUnspecifiedAddress", () => {
  it.each<string>(["0.0.0.0", "::", "::ffff:0.0.0.0", "0:0:0:0:0:0:0:0", "::0.0.0.0"])(
    "is true for the canonical form of %s",
    (address) => {
      const canonical = canonicalAddress(address);
      expect(canonical).toBeDefined();
      expect(isUnspecifiedAddress(canonical as string)).toBe(true);
    },
  );

  it.each<string>(["127.0.0.1", "::1"])("is false for the canonical form of %s", (address) => {
    const canonical = canonicalAddress(address);
    expect(canonical).toBeDefined();
    expect(isUnspecifiedAddress(canonical as string)).toBe(false);
  });
});

describe("isIpLiteral / isLoopback", () => {
  it.each<[string, boolean, boolean]>([
    ["127.0.0.1", true, true],
    ["::1", true, true],
    ["127.evil.example.com", false, false],
    ["127.0.0.1.evil.com", false, false],
    ["2001:db8::1", true, false],
    ["0177.0.0.1", false, false],
    ["1.2.3", false, false],
    // Broader than the old (M4) probe-side `isLoopback`, which recognised
    // only the literal "::1" or a raw "127.*" string: both of these are
    // loopback under any correct reading (an IPv4-mapped and a fully
    // expanded ::1), and the canonical-form check now says so too — see
    // the comment on `isLoopback` in address.ts.
    ["::ffff:127.0.0.1", true, true],
    ["0:0:0:0:0:0:0:1", true, true],
  ])("isIpLiteral(%j) is %s, isLoopback(%j) is %s", (host, ipLiteral, loopback) => {
    expect(isIpLiteral(host)).toBe(ipLiteral);
    expect(isLoopback(host)).toBe(loopback);
  });
});
