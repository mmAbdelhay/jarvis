import { describe, expect, it } from "vitest";
import { canonicalAddress, isUnspecifiedAddress } from "./address.js";

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
