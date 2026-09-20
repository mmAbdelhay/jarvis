// `reflect-metadata` must be the very first import in this file — `tsyringe`
// (a dependency of @peculiar/x509) throws at import time without it.
import "reflect-metadata";

import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { createHash, createPrivateKey, KeyObject, webcrypto, X509Certificate } from "node:crypto";
import { join } from "node:path";
import type { Clock, RandomBytes, RemoteFs } from "./io.js";
import { ensurePrivateDir, isMissing, tightenFileMode, writeFileAtomic } from "./io.js";

export type CertificateConfig = { certPath?: string; keyPath?: string };

export type CertificateMaterial = {
  cert: string;
  key: string;
  fingerprint: string;
  source: "self-signed" | "configured";
  dnsNames: string[];
};

export type CertificateDeps = {
  fs: RemoteFs;
  dir: string;
  random: RandomBytes;
  now: Clock;
  enforceFileModes: boolean;
  mint?: (now: number, serial: string) => Promise<{ cert: string; key: string }>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const VALIDITY_DAYS = 3650;
const SUBJECT = "CN=Jarvis remote bridge";
// The extended key usage OID for TLS server authentication
// (1.3.6.1.5.5.7.3.1) — the one purpose this certificate is minted for.
const SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1";

/** Lowercase hex SHA-256 of the certificate's DER encoding — the fingerprint the pairing link carries and the phone pins. */
export function fingerprintOf(certPem: string): string {
  const der = new X509Certificate(certPem).raw;
  return createHash("sha256").update(der).digest("hex");
}

/**
 * Every `DNS:` entry of the certificate's Subject Alternative Name
 * (`subjectAltName` is a string like "DNS:a, DNS:b, IP Address:1.2.3.4"),
 * lowercased, in certificate order, deduplicated. `[]` when there is no SAN
 * at all — the shape every self-signed certificate has (M11 rule 3).
 */
export function dnsNamesOf(certPem: string): string[] {
  const { subjectAltName } = new X509Certificate(certPem);
  if (subjectAltName === undefined) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of subjectAltName.split(", ")) {
    if (!entry.startsWith("DNS:")) continue;
    const name = entry.slice("DNS:".length).toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * A fresh ECDSA P-256 self-signed certificate, valid from a day before
 * `now` for 3650 days, for TLS server auth only. No second `crypto`
 * argument is passed to `createSelfSigned` (ruling 10): it uses the
 * ambient WebCrypto provider, the same one `webcrypto.subtle` draws from.
 */
export async function mintSelfSigned(
  now: number,
  serial: string,
): Promise<{ cert: string; key: string }> {
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: serial,
    name: SUBJECT,
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + VALIDITY_DAYS * DAY_MS),
    keys,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension([SERVER_AUTH_OID]),
    ],
  });
  const cert = certificate.toString("pem");
  const key = KeyObject.from(keys.privateKey).export({ type: "pkcs8", format: "pem" }) as string;
  return { cert, key };
}

/** Throws (message matching /does not match/) unless `keyPem` is `certPem`'s own private key. */
function assertKeyMatchesCert(certPem: string, keyPem: string): void {
  const cert = new X509Certificate(certPem);
  const privateKey = createPrivateKey(keyPem);
  if (!cert.checkPrivateKey(privateKey)) {
    throw new Error("the certificate's private key does not match it");
  }
}

/** `fs.readFile`, but a missing file (ENOENT) is `undefined` instead of a rejection. Any other read error still rethrows. */
async function readIfPresent(fs: RemoteFs, path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/**
 * Loads the certificate the bridge serves: the configured pair verbatim
 * when both `certPath`/`keyPath` are set (the `tailscale cert` path,
 * nothing minted or written), otherwise the self-signed pair under `dir`
 * — minted once and never replaced. A present pair that fails to parse or
 * whose key doesn't match rejects rather than being silently regenerated
 * (ruling 11): only a missing file (ENOENT) leads to minting.
 */
export async function loadCertificate(
  config: CertificateConfig,
  deps: CertificateDeps,
): Promise<CertificateMaterial> {
  const { fs, dir, random, now, enforceFileModes, mint } = deps;

  if (config.certPath !== undefined && config.keyPath !== undefined) {
    const cert = await fs.readFile(config.certPath);
    const key = await fs.readFile(config.keyPath);
    assertKeyMatchesCert(cert, key);
    return {
      cert,
      key,
      fingerprint: fingerprintOf(cert),
      source: "configured",
      dnsNames: dnsNamesOf(cert),
    };
  }

  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  await ensurePrivateDir(fs, dir, enforceFileModes);

  // Read each file independently rather than one try wrapping both: a
  // half-present pair (one file survives, the other is gone — a manual
  // delete, a botched backup restore) must never be "fixed" by minting a
  // fresh pair over the survivor, which would silently change the pinned
  // fingerprint out from under every phone that already trusts it.
  const certText = await readIfPresent(fs, certPath);
  const keyText = await readIfPresent(fs, keyPath);

  if (certText !== undefined && keyText !== undefined) {
    assertKeyMatchesCert(certText, keyText);
    // Tightening only runs once both reads (and the match check) have
    // succeeded — never inside the same try a missing-file ENOENT is
    // caught in, so a tighten failure can't be mistaken for "not found".
    await tightenFileMode(fs, certPath, enforceFileModes);
    await tightenFileMode(fs, keyPath, enforceFileModes);
    return {
      cert: certText,
      key: keyText,
      fingerprint: fingerprintOf(certText),
      source: "self-signed",
      // Hard-coded, not computed (fix round 1, M1): "self-signed" material
      // always has dnsNames: [] by construction, regardless of what the
      // file on disk actually contains (e.g. a pair placed there by hand).
      dnsNames: [],
    };
  }

  if (certText !== undefined || keyText !== undefined) {
    const missingPath = certText === undefined ? certPath : keyPath;
    throw new Error(`the certificate pair is incomplete: ${missingPath} is missing`);
  }

  // Both missing: this is the only case that mints.
  const minter = mint ?? mintSelfSigned;
  const serial = `01${random(8).toString("hex")}`;
  const { cert, key } = await minter(now(), serial);
  await writeFileAtomic(fs, keyPath, key, 0o600, random);
  await writeFileAtomic(fs, certPath, cert, 0o600, random);
  return {
    cert,
    key,
    fingerprint: fingerprintOf(cert),
    source: "self-signed",
    // Hard-coded for the same reason as the reused-pair branch above.
    dnsNames: [],
  };
}
