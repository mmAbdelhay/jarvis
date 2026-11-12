// The PROXY protocol v2 header `tailscale serve --proxy-protocol=2` prepends to
// a forwarded connection. Pure, and the first thing an unauthenticated socket's
// bytes meet, so it answers `invalid` as early as the bytes allow.

import { canonicalAddress } from "./address.js";

const SIGNATURE = Buffer.from("\r\n\r\n\0\r\nQUIT\n", "latin1");
const FIXED_BYTES = SIGNATURE.length + 4;
const VERSION_COMMAND_PROXY = 0x21;
const FAMILY_TCP4 = 0x11;
const FAMILY_TCP6 = 0x21;
/** Source, destination, source port, destination port. */
const TCP4_ADDRESS_BYTES = 4 + 4 + 2 + 2;
const TCP6_ADDRESS_BYTES = 16 + 16 + 2 + 2;
const MAX_DECLARED_BYTES = 512;

/** `need-more` only ever answers fewer bytes than this, so a reader buffering only on it stays under the cap. */
export const PROXY_V2_MAX_BYTES = FIXED_BYTES + MAX_DECLARED_BYTES;

export type ProxyV2Result =
  | { kind: "need-more" }
  | { kind: "invalid" }
  | { kind: "ok"; source: string; headerLength: number };

function ipv6Source(buffer: Buffer, offset: number): string {
  const groups: string[] = [];
  for (let index = 0; index < 8; index++) {
    groups.push(buffer.readUInt16BE(offset + index * 2).toString(16));
  }
  return groups.join(":");
}

export function parseProxyV2(buffer: Buffer): ProxyV2Result {
  const signatureSeen = Math.min(buffer.length, SIGNATURE.length);
  if (!buffer.subarray(0, signatureSeen).equals(SIGNATURE.subarray(0, signatureSeen))) {
    return { kind: "invalid" };
  }
  const versionCommand = buffer[12];
  if (versionCommand !== undefined && versionCommand !== VERSION_COMMAND_PROXY) {
    return { kind: "invalid" };
  }
  const family = buffer[13];
  if (family !== undefined && family !== FAMILY_TCP4 && family !== FAMILY_TCP6) {
    return { kind: "invalid" };
  }
  if (buffer.length < FIXED_BYTES) return { kind: "need-more" };

  const declared = buffer.readUInt16BE(14);
  const addressBytes = family === FAMILY_TCP4 ? TCP4_ADDRESS_BYTES : TCP6_ADDRESS_BYTES;
  if (declared > MAX_DECLARED_BYTES || declared < addressBytes) return { kind: "invalid" };

  const headerLength = FIXED_BYTES + declared;
  if (buffer.length < headerLength) return { kind: "need-more" };

  const text =
    family === FAMILY_TCP4
      ? buffer.subarray(FIXED_BYTES, FIXED_BYTES + 4).join(".")
      : ipv6Source(buffer, FIXED_BYTES);
  // The one spelling a socket's own address reaches backoff keys and audit
  // lines in, which is also what reports an IPv4-mapped source as plain IPv4.
  const source = canonicalAddress(text);
  return source === undefined ? { kind: "invalid" } : { kind: "ok", source, headerLength };
}
