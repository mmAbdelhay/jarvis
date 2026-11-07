import { describe, expect, it } from "vitest";
import { parseProxyV2, PROXY_V2_MAX_BYTES } from "./proxy-header.js";

const SIGNATURE = "0d0a0d0a000d0a515549540a";

/**
 * Real bytes, sent by Tailscale 1.102.4 through
 * `tailscale serve --bg --tcp=17717 --proxy-protocol=2`: source
 * 100.79.83.16:54154, destination 100.79.83.16:17717.
 */
const CAPTURED_V4 = Buffer.from(`${SIGNATURE}2111000c644f5310644f5310d38a4535`, "hex");

/** Source fd7a:115c:a1e0::1, destination ::1, the same ports. */
const V6_ADDRESSES = "fd7a115ca1e00000000000000000000100000000000000000000000000000001c8224535";

function header(versionCommand: number, family: number, body: Buffer): Buffer {
  const fixed = Buffer.alloc(4);
  fixed[0] = versionCommand;
  fixed[1] = family;
  fixed.writeUInt16BE(body.length, 2);
  return Buffer.concat([Buffer.from(SIGNATURE, "hex"), fixed, body]);
}

function v6(sourceHex: string): Buffer {
  return header(0x21, 0x21, Buffer.from(sourceHex + V6_ADDRESSES.slice(32), "hex"));
}

describe("parseProxyV2", () => {
  it("accepts a captured IPv4 header", () => {
    expect(parseProxyV2(CAPTURED_V4)).toEqual({
      kind: "ok",
      source: "100.79.83.16",
      headerLength: 28,
    });
  });

  it("accepts IPv6, in the spelling a socket's address is compared in", () => {
    expect(parseProxyV2(v6(V6_ADDRESSES.slice(0, 32)))).toEqual({
      kind: "ok",
      source: "fd7a:115c:a1e0::1",
      headerLength: 52,
    });
  });

  it("reports an IPv4-mapped IPv6 source as plain IPv4", () => {
    const mapped = v6("00000000000000000000ffff644f5310");
    expect(parseProxyV2(mapped)).toMatchObject({ kind: "ok", source: "100.79.83.16" });
  });

  it("does not count the bytes after the header, and skips TLVs inside it", () => {
    const withTlv = header(0x21, 0x11, Buffer.concat([CAPTURED_V4.subarray(16), Buffer.alloc(7)]));
    const parsed = parseProxyV2(Buffer.concat([withTlv, Buffer.from("client hello")]));
    expect(parsed).toEqual({ kind: "ok", source: "100.79.83.16", headerLength: 35 });
  });

  it("reports need-more at every length of a partial header", () => {
    for (let length = 0; length < CAPTURED_V4.length; length++) {
      expect(parseProxyV2(CAPTURED_V4.subarray(0, length))).toEqual({ kind: "need-more" });
    }
  });

  it("rejects a wrong signature as soon as a byte differs, and a TLS ClientHello at once", () => {
    const wrong = Buffer.from(CAPTURED_V4);
    wrong[11] = 0x0b;
    expect(parseProxyV2(wrong)).toEqual({ kind: "invalid" });
    expect(parseProxyV2(wrong.subarray(0, 12))).toEqual({ kind: "invalid" });
    expect(parseProxyV2(Buffer.from([0x16]))).toEqual({ kind: "invalid" });
  });

  it.each([
    ["the LOCAL command", 0x20, 0x11],
    ["version 1", 0x11, 0x11],
    ["an unknown command", 0x22, 0x11],
    ["UNSPEC", 0x21, 0x00],
    ["UDP over IPv4", 0x21, 0x12],
    ["UDP over IPv6", 0x21, 0x22],
    ["AF_UNIX", 0x21, 0x31],
  ])("rejects %s, without waiting for the rest", (_label, versionCommand, family) => {
    const bad = header(versionCommand, family, CAPTURED_V4.subarray(16));
    expect(parseProxyV2(bad)).toEqual({ kind: "invalid" });
    expect(parseProxyV2(bad.subarray(0, 14))).toEqual({ kind: "invalid" });
  });

  it("rejects a declared length over 512 from the fixed part alone", () => {
    const over = Buffer.from(CAPTURED_V4.subarray(0, 16));
    over.writeUInt16BE(513, 14);
    expect(parseProxyV2(over)).toEqual({ kind: "invalid" });
  });

  it("accepts a declared length of exactly 512", () => {
    const body = Buffer.concat([CAPTURED_V4.subarray(16), Buffer.alloc(500)]);
    expect(parseProxyV2(header(0x21, 0x11, body))).toMatchObject({ kind: "ok", headerLength: 528 });
  });

  it.each([
    ["IPv4", 0x11, 11],
    ["IPv6", 0x21, 35],
  ])("rejects a declared length too short for %s addresses", (_label, family, length) => {
    expect(parseProxyV2(header(0x21, family, Buffer.alloc(length)))).toEqual({ kind: "invalid" });
  });

  it("never asks for more once the cap's worth of bytes has arrived", () => {
    expect(PROXY_V2_MAX_BYTES).toBe(16 + 512);
    const longest = header(0x21, 0x11, Buffer.alloc(512));
    expect(parseProxyV2(longest.subarray(0, PROXY_V2_MAX_BYTES - 1))).toEqual({
      kind: "need-more",
    });
    expect(parseProxyV2(longest.subarray(0, PROXY_V2_MAX_BYTES)).kind).toBe("ok");
  });
});
