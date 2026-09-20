// The pairing-link URI (spec, "Pairing"): the `jarvis://pair?...` deep
// link the desktop's QR/text encodes and the phone parses. Pure, shared by
// both sides via @jarvis/wire. `host` must be an IP literal in canonical
// form (M4 ruling 13), checked here through this package's own
// `canonicalAddress` rather than `node:net`.

import { canonicalAddress } from "./address.js";
import {
  FINGERPRINT_PATTERN,
  HOSTNAME_PATTERN,
  type PairingLink,
  PROTOCOL_VERSION,
  SECRET_PATTERN,
} from "./protocol.js";

const PAIRING_URI_PREFIX = "jarvis://pair?";

export function formatPairingUri(link: PairingLink): string {
  const params = new URLSearchParams([
    ["v", String(PROTOCOL_VERSION)],
    ["host", link.host],
    ["port", String(link.port)],
    ["secret", link.secret],
    ["fp", link.fingerprint],
  ]);
  // `name` is appended last, and only when present, so a link without one
  // formats byte-identical to M6's output (existing round-trip tests).
  if (link.name !== undefined) params.append("name", link.name);
  return `${PAIRING_URI_PREFIX}${params.toString()}`;
}

export function parsePairingUri(uri: string): PairingLink | undefined {
  if (!uri.startsWith(PAIRING_URI_PREFIX)) return undefined;
  const params = new URLSearchParams(uri.slice(PAIRING_URI_PREFIX.length));
  if (params.get("v") !== String(PROTOCOL_VERSION)) return undefined;

  const host = params.get("host");
  const portText = params.get("port");
  const secret = params.get("secret");
  const fingerprint = params.get("fp");
  if (host === null || portText === null || secret === null || fingerprint === null)
    return undefined;
  if (host !== canonicalAddress(host)) return undefined;

  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
  if (!SECRET_PATTERN.test(secret)) return undefined;
  if (!FINGERPRINT_PATTERN.test(fingerprint)) return undefined;

  // A present `name` must already be lowercase — HOSTNAME_PATTERN itself
  // only matches lowercase, so there is no separate normalisation step:
  // an upper-case name simply fails to parse rather than being folded.
  const name = params.get("name");
  if (name !== null && !HOSTNAME_PATTERN.test(name)) return undefined;

  return name === null
    ? { host, port, secret, fingerprint }
    : { host, port, secret, fingerprint, name };
}
