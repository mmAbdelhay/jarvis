// `reflect-metadata` must be the very first import in this file for the same
// reason certificate.ts documents at its own top: `tsyringe` (a dependency
// of @peculiar/x509) throws at import time without it. certificate.ts's own
// side-effect import would normally cover this transitively, but this file
// also imports @peculiar/x509's extension classes directly (to mint a SAN
// certificate for rule 3), so it needs the same guarantee independently.
import "reflect-metadata";

import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import {
  createPrivateKey,
  KeyObject,
  webcrypto,
  X509Certificate as NodeX509Certificate,
} from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type CertificateDeps,
  fingerprintOf,
  loadCertificate,
  mintSelfSigned,
} from "./certificate.js";
import { memoryFs } from "./fs-double.js";
import type { RandomBytes } from "./io.js";

const NOW = Date.UTC(2026, 8, 16, 9);
const DAY_MS = 24 * 60 * 60 * 1000;
const DIR = "/remote";
// certificate.ts builds both with `join(dir, …)` (platform-correct —
// backslash-joined on win32); memoryFs (fs-double.ts) keys its Map on the
// exact path string, so these must match rather than being hardcoded with
// a literal "/", or every lookup misses on Windows.
const CERT_PATH = join(DIR, "cert.pem");
const KEY_PATH = join(DIR, "key.pem");

/** A RandomBytes double that fills each call's buffer with an incrementing byte, so successive calls never collide. */
function countingRandom(): RandomBytes {
  let call = 0;
  return (size: number) => Buffer.alloc(size, ++call);
}

function makeDeps(overrides: Partial<CertificateDeps> = {}): CertificateDeps {
  return {
    fs: memoryFs(),
    dir: DIR,
    random: countingRandom(),
    now: () => NOW,
    enforceFileModes: true,
    ...overrides,
  };
}

/**
 * Mints a self-signed cert/key pair like `mintSelfSigned`, but additionally
 * carrying a Subject Alternative Name extension — the shape a `tailscale
 * cert` certificate has and a self-signed one never does (rule 3). Lives
 * only in this test file: production minting (certificate.ts) never adds a
 * SAN of its own.
 */
async function mintWithSan(
  now: number,
  serial: string,
  sanEntries: { type: "dns" | "ip"; value: string }[],
): Promise<{ cert: string; key: string }> {
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: serial,
    name: "CN=Jarvis remote bridge",
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + 3650 * DAY_MS),
    keys,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
      new SubjectAlternativeNameExtension(sanEntries),
    ],
  });
  const cert = certificate.toString("pem");
  const key = KeyObject.from(keys.privateKey).export({ type: "pkcs8", format: "pem" }) as string;
  return { cert, key };
}

describe("mintSelfSigned", () => {
  it("mints an ECDSA P-256 self-signed cert with the documented subject and validity", async () => {
    const { cert, key } = await mintSelfSigned(NOW, "0102030405060708");
    const parsed = new NodeX509Certificate(cert);

    expect(parsed.subject).toBe("CN=Jarvis remote bridge");
    expect(parsed.ca).toBe(false);
    expect(new Date(parsed.validFrom).getTime()).toBe(NOW - DAY_MS);
    expect(new Date(parsed.validTo).getTime()).toBe(NOW + 3650 * DAY_MS);

    const privateKey = createPrivateKey(key);
    expect(privateKey.asymmetricKeyType).toBe("ec");
    expect((privateKey.asymmetricKeyDetails as { namedCurve?: string })?.namedCurve).toBe(
      "prime256v1",
    );
    expect(key).toContain("BEGIN PRIVATE KEY"); // PKCS#8 PEM
    expect(parsed.checkPrivateKey(privateKey)).toBe(true);
  });
});

describe("fingerprintOf", () => {
  it("is the lowercase hex SHA-256 of the certificate's DER encoding", async () => {
    const { createHash } = await import("node:crypto");
    const { cert } = await mintSelfSigned(NOW, "0102030405060708");
    const expected = createHash("sha256").update(new NodeX509Certificate(cert).raw).digest("hex");

    expect(fingerprintOf(cert)).toBe(expected);
    expect(fingerprintOf(cert)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("loadCertificate — self-signed", () => {
  it("mints on first load (0700 dir, 0600 files, matching fingerprint) and reuses on the second", async () => {
    const mint = vi.fn(mintSelfSigned);
    const fs = memoryFs();
    const deps = makeDeps({ fs, mint });

    const first = await loadCertificate({}, deps);
    expect(first.source).toBe("self-signed");
    expect(mint).toHaveBeenCalledTimes(1);
    expect(fs.dirs.get(DIR)).toBe(0o700);
    expect(fs.files.get(CERT_PATH)?.mode).toBe(0o600);
    expect(fs.files.get(KEY_PATH)?.mode).toBe(0o600);
    expect(fingerprintOf(first.cert)).toBe(first.fingerprint);

    const second = await loadCertificate({}, deps);
    expect(mint).toHaveBeenCalledTimes(1); // not called again
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.source).toBe("self-signed");
  });

  it("mints with a serial matching /^01[0-9a-f]{16}$/", async () => {
    const mint = vi.fn(mintSelfSigned);
    await loadCertificate({}, makeDeps({ mint }));

    expect(mint).toHaveBeenCalledTimes(1);
    const [, serial] = mint.mock.calls[0] ?? [];
    expect(serial).toMatch(/^01[0-9a-f]{16}$/);
  });

  it("[bite-proof] never replaces a present pair, even a garbage one: rejects, no mint, files unchanged", async () => {
    const fs = memoryFs();
    fs.dirs.set(DIR, 0o700);
    fs.files.set(CERT_PATH, { data: "not a certificate", mode: 0o600 });
    fs.files.set(KEY_PATH, { data: "not a key", mode: 0o600 });
    const mint = vi.fn(mintSelfSigned);

    await expect(loadCertificate({}, makeDeps({ fs, mint }))).rejects.toThrow();

    expect(mint).not.toHaveBeenCalled();
    expect(fs.files.get(CERT_PATH)?.data).toBe("not a certificate");
    expect(fs.files.get(KEY_PATH)?.data).toBe("not a key");
  });

  it("[fix] a half-present pair (cert.pem present, key.pem missing) rejects naming key.pem, mints nothing, and leaves cert.pem untouched", async () => {
    const fs = memoryFs();
    const { cert } = await mintSelfSigned(NOW, "0102030405060708");
    fs.dirs.set(DIR, 0o700);
    fs.files.set(CERT_PATH, { data: cert, mode: 0o600 });
    const mint = vi.fn(mintSelfSigned);

    await expect(loadCertificate({}, makeDeps({ fs, mint }))).rejects.toThrow(/key\.pem.*missing/);

    expect(mint).not.toHaveBeenCalled();
    expect(fs.files.get(CERT_PATH)?.data).toBe(cert);
    expect(fs.files.has(KEY_PATH)).toBe(false);
  });

  it("[fix] a half-present pair (key.pem present, cert.pem missing) rejects naming cert.pem, and mints nothing", async () => {
    const fs = memoryFs();
    const { key } = await mintSelfSigned(NOW, "0102030405060708");
    fs.dirs.set(DIR, 0o700);
    fs.files.set(KEY_PATH, { data: key, mode: 0o600 });
    const mint = vi.fn(mintSelfSigned);

    await expect(loadCertificate({}, makeDeps({ fs, mint }))).rejects.toThrow(/cert\.pem.*missing/);

    expect(mint).not.toHaveBeenCalled();
    expect(fs.files.get(KEY_PATH)?.data).toBe(key);
    expect(fs.files.has(CERT_PATH)).toBe(false);
  });

  it("rejects a cert whose key belongs to another certificate", async () => {
    const fs = memoryFs();
    const a = await mintSelfSigned(NOW, "0102030405060708");
    const b = await mintSelfSigned(NOW, "0807060504030201");
    fs.dirs.set(DIR, 0o700);
    fs.files.set(CERT_PATH, { data: a.cert, mode: 0o600 });
    fs.files.set(KEY_PATH, { data: b.key, mode: 0o600 });

    await expect(loadCertificate({}, makeDeps({ fs }))).rejects.toThrow(/does not match/);
  });

  it("tightens a 0644 present pair to 0600", async () => {
    const fs = memoryFs();
    const { cert, key } = await mintSelfSigned(NOW, "0102030405060708");
    fs.dirs.set(DIR, 0o700);
    fs.files.set(CERT_PATH, { data: cert, mode: 0o644 });
    fs.files.set(KEY_PATH, { data: key, mode: 0o644 });

    await loadCertificate({}, makeDeps({ fs }));

    expect(fs.files.get(CERT_PATH)?.mode).toBe(0o600);
    expect(fs.files.get(KEY_PATH)?.mode).toBe(0o600);
  });
});

describe("loadCertificate — configured", () => {
  it("returns the configured cert/key/fingerprint, mints nothing, writes nothing under dir", async () => {
    const fs = memoryFs();
    const { cert, key } = await mintSelfSigned(NOW, "0102030405060708");
    fs.files.set("/etc/tls/cert.pem", { data: cert, mode: 0o644 });
    fs.files.set("/etc/tls/key.pem", { data: key, mode: 0o644 });
    const mint = vi.fn(mintSelfSigned);

    const material = await loadCertificate(
      { certPath: "/etc/tls/cert.pem", keyPath: "/etc/tls/key.pem" },
      makeDeps({ fs, mint }),
    );

    expect(material).toEqual({
      cert,
      key,
      fingerprint: fingerprintOf(cert),
      source: "configured",
      dnsNames: [],
    });
    expect(mint).not.toHaveBeenCalled();
    expect(fs.dirs.has(DIR)).toBe(false);
    expect(fs.files.has(CERT_PATH)).toBe(false);
    expect(fs.files.get("/etc/tls/cert.pem")?.mode).toBe(0o644); // untouched, never chmodded
  });

  it("rejects a configured pair whose key does not match", async () => {
    const fs = memoryFs();
    const a = await mintSelfSigned(NOW, "0102030405060708");
    const b = await mintSelfSigned(NOW, "0807060504030201");
    fs.files.set("/etc/tls/cert.pem", { data: a.cert, mode: 0o644 });
    fs.files.set("/etc/tls/key.pem", { data: b.key, mode: 0o644 });

    await expect(
      loadCertificate(
        { certPath: "/etc/tls/cert.pem", keyPath: "/etc/tls/key.pem" },
        makeDeps({ fs }),
      ),
    ).rejects.toThrow(/does not match/);
  });
});

describe("loadCertificate — dnsNames (rule 3)", () => {
  it("is every DNS SAN entry, lowercased, in certificate order, deduplicated", async () => {
    const fs = memoryFs();
    const { cert, key } = await mintWithSan(NOW, "0102030405060708", [
      { type: "dns", value: "mac.tail.ts.net" },
      { type: "dns", value: "Alt.Example" },
      { type: "dns", value: "mac.tail.ts.net" }, // duplicate — must not appear twice
      { type: "ip", value: "100.64.0.1" },
    ]);
    fs.files.set("/etc/tls/cert.pem", { data: cert, mode: 0o644 });
    fs.files.set("/etc/tls/key.pem", { data: key, mode: 0o644 });

    const material = await loadCertificate(
      { certPath: "/etc/tls/cert.pem", keyPath: "/etc/tls/key.pem" },
      makeDeps({ fs }),
    );

    expect(material.dnsNames).toEqual(["mac.tail.ts.net", "alt.example"]);
  });

  it("is [] when the SAN carries only an IP address", async () => {
    const fs = memoryFs();
    const { cert, key } = await mintWithSan(NOW, "0102030405060708", [
      { type: "ip", value: "100.64.0.1" },
    ]);
    fs.files.set("/etc/tls/cert.pem", { data: cert, mode: 0o644 });
    fs.files.set("/etc/tls/key.pem", { data: key, mode: 0o644 });

    const material = await loadCertificate(
      { certPath: "/etc/tls/cert.pem", keyPath: "/etc/tls/key.pem" },
      makeDeps({ fs }),
    );

    expect(material.dnsNames).toEqual([]);
  });

  it("is [] for a self-signed certificate (no SAN at all)", async () => {
    const material = await loadCertificate({}, makeDeps());
    expect(material.dnsNames).toEqual([]);
  });

  it("[fix round 1, M1] is [] for a self-signed pair even if the file on disk carries a SAN — hard-coded by source, not computed from the cert", async () => {
    // A cert/key pair placed directly at dir/cert.pem + dir/key.pem (no
    // certPath/keyPath configured) is loaded as "self-signed" regardless of
    // what it actually contains — e.g. a `tailscale cert` pair copied there
    // by hand. Rule 3 says self-signed material always has dnsNames: [];
    // that must hold by construction, not by accident of file content.
    const fs = memoryFs();
    const { cert, key } = await mintWithSan(NOW, "0102030405060708", [
      { type: "dns", value: "mac.tail.ts.net" },
    ]);
    fs.dirs.set(DIR, 0o700);
    fs.files.set(CERT_PATH, { data: cert, mode: 0o600 });
    fs.files.set(KEY_PATH, { data: key, mode: 0o600 });

    const material = await loadCertificate({}, makeDeps({ fs }));

    expect(material.source).toBe("self-signed");
    expect(material.dnsNames).toEqual([]);
  });

  it("[fix round 1, M1] is [] for a freshly-minted self-signed pair even if the injected mint() carries a SAN", async () => {
    const fs = memoryFs();
    const mint = (now: number, serial: string) =>
      mintWithSan(now, serial, [{ type: "dns", value: "mac.tail.ts.net" }]);

    const material = await loadCertificate({}, makeDeps({ fs, mint }));

    expect(material.source).toBe("self-signed");
    expect(material.dnsNames).toEqual([]);
  });
});
