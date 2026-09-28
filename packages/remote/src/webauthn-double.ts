// Test-only WebAuthn authenticator built on node:crypto keys: a minimal
// CBOR encoder plus the byte shapes an authenticator produces, so
// webauthn.test.ts and the passkey channel tests share one fixture source.
// Never imported by production code.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

export type CborValue = number | string | Buffer | CborValue[] | Map<CborValue, CborValue>;

export function cbor(value: CborValue): Buffer {
  const head = (major: number, length: number): Buffer => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    if (length < 65_536) {
      const result = Buffer.alloc(3);
      result[0] = (major << 5) | 25;
      result.writeUInt16BE(length, 1);
      return result;
    }
    const result = Buffer.alloc(5);
    result[0] = (major << 5) | 26;
    result.writeUInt32BE(length, 1);
    return result;
  };
  if (typeof value === "number") {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const entries = [...value.entries()];
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)]),
  ]);
}

export function clientData(
  type: string,
  challenge: string,
  origin = "https://jarvis.test:8443",
): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin }));
}

function counter(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function jwkField(value: string | undefined): Buffer {
  if (value === undefined) throw new Error("JWK field missing");
  return Buffer.from(value, "base64url");
}

export function coseKey(publicKey: KeyObject, alg: -7 | -257): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  if (alg === -7) {
    return cbor(
      new Map<CborValue, CborValue>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, jwkField(jwk.x)],
        [-3, jwkField(jwk.y)],
      ]),
    );
  }
  return cbor(
    new Map<CborValue, CborValue>([
      [1, 3],
      [3, -257],
      [-1, jwkField(jwk.n)],
      [-2, jwkField(jwk.e)],
    ]),
  );
}

export function authData(rpId: string, flags: number, signCount: number): Buffer {
  return Buffer.concat([
    createHash("sha256").update(rpId).digest(),
    Buffer.from([flags]),
    counter(signCount),
  ]);
}

export function keyPair(alg: -7 | -257) {
  return alg === -7
    ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    : generateKeyPairSync("rsa", { modulusLength: 2048 });
}

/** `none` attestation over `credentialId` and `publicKey`, signCount 3 unless given. */
export function attestationObject(options: {
  credentialId: Buffer;
  cose: Buffer;
  rpId?: string;
  flags?: number;
  fmt?: string;
  signCount?: number;
}): Buffer {
  const base = authData(
    options.rpId ?? "jarvis.test",
    options.flags ?? 0xc5,
    options.signCount ?? 3,
  );
  const credentialLength = Buffer.alloc(2);
  credentialLength.writeUInt16BE(options.credentialId.length);
  const attested = Buffer.concat([
    base,
    Buffer.alloc(16),
    credentialLength,
    options.credentialId,
    options.cose,
  ]);
  return cbor(
    new Map<CborValue, CborValue>([
      ["fmt", options.fmt ?? "none"],
      ["attStmt", new Map()],
      ["authData", attested],
    ]),
  );
}

/**
 * One software authenticator holding one credential: `register` answers a
 * create() ceremony and `assert` a get() ceremony, both as the base64url
 * fields the `auth:passkey*Finish` channels take. Each assertion's
 * signCount is one more than the last (registration reports 0).
 */
export function softAuthenticator(options: { alg?: -7 | -257; rpId: string; origin: string }) {
  const alg = options.alg ?? -7;
  const pair = keyPair(alg);
  const credentialId = randomBytes(32);
  const cose = coseKey(pair.publicKey, alg);
  let signCount = 0;
  return {
    credentialId: credentialId.toString("base64url"),
    register(challenge: string, overrides: { origin?: string } = {}) {
      return {
        credentialId: credentialId.toString("base64url"),
        clientDataJSON: clientData(
          "webauthn.create",
          challenge,
          overrides.origin ?? options.origin,
        ).toString("base64url"),
        attestationObject: attestationObject({
          credentialId,
          cose,
          rpId: options.rpId,
          signCount: 0,
        }).toString("base64url"),
      };
    },
    assert(challenge: string, overrides: { origin?: string; signCount?: number } = {}) {
      signCount = overrides.signCount ?? signCount + 1;
      const client = clientData("webauthn.get", challenge, overrides.origin ?? options.origin);
      const authenticator = authData(options.rpId, 0x05, signCount);
      const signed = Buffer.concat([authenticator, createHash("sha256").update(client).digest()]);
      const signature = sign(alg === -7 ? "sha256" : "RSA-SHA256", signed, pair.privateKey);
      return {
        credentialId: credentialId.toString("base64url"),
        clientDataJSON: client.toString("base64url"),
        authenticatorData: authenticator.toString("base64url"),
        signature: signature.toString("base64url"),
      };
    },
  };
}
