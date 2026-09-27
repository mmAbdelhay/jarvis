import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";

export type WebAuthnAlgorithm = -7 | -257;
export type ChallengePurpose = "register" | "login";
type RandomBytes = (size: number) => Buffer;
type Clock = () => number;

const CHALLENGE_BYTES = 32;
const CHALLENGE_LIFETIME_MS = 120_000;
const MAX_CBOR_DEPTH = 16;
const MAX_CBOR_ITEMS = 1_024;
const MAX_CBOR_BYTES = 1_048_576;

type CborValue = number | Buffer | string | CborValue[] | Map<CborValue, CborValue>;

class CborDecoder {
  private offset = 0;
  private items = 0;

  constructor(private readonly input: Buffer) {
    if (input.length > MAX_CBOR_BYTES) throw new Error("CBOR input too large");
  }

  decode(): CborValue {
    const result = this.read(0);
    if (this.offset !== this.input.length) throw new Error("Trailing CBOR data");
    return result;
  }

  private read(depth: number): CborValue {
    if (depth > MAX_CBOR_DEPTH || ++this.items > MAX_CBOR_ITEMS)
      throw new Error("CBOR limit exceeded");
    const initial = this.byte();
    const major = initial >> 5;
    const additional = initial & 31;
    if (additional === 31) throw new Error("Indefinite CBOR is unsupported");
    const length = this.length(additional);
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2) return this.bytes(length);
    if (major === 3) return this.bytes(length).toString("utf8");
    if (major === 4) {
      const result: CborValue[] = [];
      for (let index = 0; index < length; index++) result.push(this.read(depth + 1));
      return result;
    }
    if (major === 5) {
      const result = new Map<CborValue, CborValue>();
      for (let index = 0; index < length; index++) {
        const key = this.read(depth + 1);
        if (result.has(key)) throw new Error("Duplicate CBOR map key");
        result.set(key, this.read(depth + 1));
      }
      return result;
    }
    throw new Error("Unsupported CBOR type");
  }

  private length(additional: number): number {
    if (additional < 24) return additional;
    if (additional === 24) return this.byte();
    if (additional === 25) return this.bytes(2).readUInt16BE();
    if (additional === 26) return this.bytes(4).readUInt32BE();
    if (additional === 27) {
      const value = this.bytes(8).readBigUInt64BE();
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR integer too large");
      return Number(value);
    }
    throw new Error("Invalid CBOR length");
  }

  private byte(): number {
    if (this.offset >= this.input.length) throw new Error("Truncated CBOR");
    return this.input.readUInt8(this.offset++);
  }

  private bytes(length: number): Buffer {
    if (length > MAX_CBOR_BYTES || this.offset + length > this.input.length)
      throw new Error("Truncated CBOR");
    const result = this.input.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
}

function decodeCbor(input: Buffer): CborValue {
  return new CborDecoder(input).decode();
}

function map(value: CborValue): Map<CborValue, CborValue> {
  if (!(value instanceof Map)) throw new Error("Expected CBOR map");
  return value;
}

function bytes(value: CborValue | undefined): Buffer {
  if (!Buffer.isBuffer(value)) throw new Error("Expected CBOR bytes");
  return value;
}

function integer(value: CborValue | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error("Expected CBOR integer");
  return value;
}

function base64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url");
  const result = Buffer.from(value, "base64url");
  if (result.toString("base64url") !== value) throw new Error("Non-canonical base64url");
  return result;
}

type ClientData = { type: string; challenge: string; origin: string };

function parseClientData(encoded: string): { bytes: Buffer; data: ClientData } {
  const raw = base64url(encoded);
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (typeof value !== "object" || value === null) throw new Error("Invalid client data");
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.type !== "string" ||
    typeof candidate.challenge !== "string" ||
    typeof candidate.origin !== "string"
  ) {
    throw new Error("Invalid client data");
  }
  return {
    bytes: raw,
    data: { type: candidate.type, challenge: candidate.challenge, origin: candidate.origin },
  };
}

function validateClient(data: ClientData, type: string, challenge: string, origin: string): void {
  if (data.type !== type) throw new Error("Unexpected ceremony type");
  if (data.challenge !== challenge) throw new Error("Challenge mismatch");
  if (data.origin !== origin) throw new Error("Origin mismatch");
}

function parseAuthenticatorData(input: Buffer, rpId: string): { flags: number; signCount: number } {
  if (input.length < 37) throw new Error("Authenticator data is truncated");
  const expectedRpIdHash = createHash("sha256").update(rpId, "utf8").digest();
  if (!input.subarray(0, 32).equals(expectedRpIdHash)) throw new Error("RP ID mismatch");
  const flags = input.readUInt8(32);
  if ((flags & 0x01) === 0) throw new Error("User presence required");
  if ((flags & 0x04) === 0) throw new Error("User verification required");
  return { flags, signCount: input.readUInt32BE(33) };
}

function parseCosePublicKey(
  cose: Buffer,
  requestedAlg?: WebAuthnAlgorithm,
): { alg: WebAuthnAlgorithm; key: ReturnType<typeof createPublicKey> } {
  const value = map(decodeCbor(cose));
  const kty = integer(value.get(1));
  const alg = integer(value.get(3));
  if (alg !== -7 && alg !== -257) throw new Error("Unsupported algorithm");
  if (requestedAlg !== undefined && alg !== requestedAlg) throw new Error("Algorithm mismatch");
  if (alg === -7) {
    if (kty !== 2 || integer(value.get(-1)) !== 1) throw new Error("Invalid ES256 key");
    const x = bytes(value.get(-2));
    const y = bytes(value.get(-3));
    if (x.length !== 32 || y.length !== 32) throw new Error("Invalid ES256 key");
    return {
      alg,
      key: createPublicKey({
        key: { kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url") },
        format: "jwk",
      }),
    };
  }
  if (kty !== 3) throw new Error("Invalid RS256 key");
  const n = bytes(value.get(-1));
  const e = bytes(value.get(-2));
  if (n.length < 256 || e.length === 0) throw new Error("Invalid RS256 key");
  return {
    alg,
    key: createPublicKey({
      key: { kty: "RSA", n: n.toString("base64url"), e: e.toString("base64url") },
      format: "jwk",
    }),
  };
}

function failure(error: unknown): { ok: false; reason: string } {
  return { ok: false, reason: error instanceof Error ? error.message : "Verification failed" };
}

export function createChallengeStore(dependencies: { random: RandomBytes; now: Clock }): {
  issue(connId: string, purpose: ChallengePurpose): string;
  consume(connId: string, purpose: ChallengePurpose, challenge: string): boolean;
  drop(connId: string): void;
  size(): number;
} {
  const issued = new Map<string, { challenge: Buffer; createdAt: number }>();
  const key = (connId: string, purpose: ChallengePurpose) => JSON.stringify([connId, purpose]);
  const isFresh = (createdAt: number, now: number) => {
    const age = now - createdAt;
    return age >= 0 && age <= CHALLENGE_LIFETIME_MS;
  };
  return {
    issue(connId, purpose) {
      const now = dependencies.now();
      for (const [challengeKey, entry] of issued) {
        if (!isFresh(entry.createdAt, now)) issued.delete(challengeKey);
      }
      const challengeBytes = dependencies.random(CHALLENGE_BYTES);
      if (!Buffer.isBuffer(challengeBytes) || challengeBytes.length !== CHALLENGE_BYTES)
        throw new Error("Random source returned the wrong byte count");
      const challenge = challengeBytes.toString("base64url");
      issued.set(key(connId, purpose), { challenge: Buffer.from(challengeBytes), createdAt: now });
      return challenge;
    },
    consume(connId, purpose, challenge) {
      const challengeKey = key(connId, purpose);
      const entry = issued.get(challengeKey);
      if (entry === undefined) return false;
      if (!isFresh(entry.createdAt, dependencies.now())) {
        issued.delete(challengeKey);
        return false;
      }
      if (!/^[A-Za-z0-9_-]*$/.test(challenge)) return false;
      const challengeBytes = Buffer.from(challenge, "base64url");
      if (challengeBytes.toString("base64url") !== challenge) return false;
      const matches =
        challengeBytes.length === entry.challenge.length &&
        timingSafeEqual(challengeBytes, entry.challenge);
      if (matches) issued.delete(challengeKey);
      return matches;
    },
    drop(connId) {
      issued.delete(key(connId, "register"));
      issued.delete(key(connId, "login"));
    },
    size() {
      return issued.size;
    },
  };
}

export type RegistrationResult =
  | { ok: true; credentialId: string; publicKey: string; alg: WebAuthnAlgorithm; signCount: number }
  | { ok: false; reason: string };

export function verifyRegistration(input: {
  clientDataJSON: string;
  attestationObject: string;
  expectedChallenge: string;
  expectedOrigin: string;
  rpId: string;
}): RegistrationResult {
  try {
    const client = parseClientData(input.clientDataJSON);
    validateClient(client.data, "webauthn.create", input.expectedChallenge, input.expectedOrigin);
    const attestation = map(decodeCbor(base64url(input.attestationObject)));
    if (attestation.get("fmt") !== "none") throw new Error("Unsupported attestation format");
    const statement = map(attestation.get("attStmt") as CborValue);
    if (statement.size !== 0) throw new Error("Attestation statement must be empty");
    const authenticatorData = bytes(attestation.get("authData"));
    const parsed = parseAuthenticatorData(authenticatorData, input.rpId);
    if ((parsed.flags & 0x40) === 0) throw new Error("Attested credential data required");
    let offset = 37 + 16;
    if (authenticatorData.length < offset + 2)
      throw new Error("Attested credential data is truncated");
    const credentialLength = authenticatorData.readUInt16BE(offset);
    offset += 2;
    if (credentialLength === 0 || authenticatorData.length <= offset + credentialLength)
      throw new Error("Attested credential data is truncated");
    const credentialId = authenticatorData.subarray(offset, offset + credentialLength);
    const publicKey = authenticatorData.subarray(offset + credentialLength);
    const parsedKey = parseCosePublicKey(publicKey);
    return {
      ok: true,
      credentialId: credentialId.toString("base64url"),
      publicKey: publicKey.toString("base64url"),
      alg: parsedKey.alg,
      signCount: parsed.signCount,
    };
  } catch (error) {
    return failure(error);
  }
}

export type AssertionResult = { ok: true; signCount: number } | { ok: false; reason: string };

export function verifyAssertion(input: {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  expectedChallenge: string;
  expectedOrigin: string;
  rpId: string;
  publicKey: string;
  alg: WebAuthnAlgorithm;
  storedSignCount: number;
}): AssertionResult {
  try {
    const client = parseClientData(input.clientDataJSON);
    validateClient(client.data, "webauthn.get", input.expectedChallenge, input.expectedOrigin);
    const authenticatorData = base64url(input.authenticatorData);
    const parsed = parseAuthenticatorData(authenticatorData, input.rpId);
    if (!Number.isSafeInteger(input.storedSignCount) || input.storedSignCount < 0)
      throw new Error("Invalid stored counter");
    if (
      !(parsed.signCount === 0 && input.storedSignCount === 0) &&
      parsed.signCount <= input.storedSignCount
    ) {
      throw new Error("Signature counter did not increase");
    }
    const publicKey = parseCosePublicKey(base64url(input.publicKey), input.alg).key;
    const signed = Buffer.concat([
      authenticatorData,
      createHash("sha256").update(client.bytes).digest(),
    ]);
    if (!verify("sha256", signed, publicKey, base64url(input.signature)))
      throw new Error("Invalid signature");
    return { ok: true, signCount: parsed.signCount };
  } catch (error) {
    return failure(error);
  }
}
