import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakeClock } from "./clock-double.js";
import { createChallengeStore, verifyAssertion, verifyRegistration } from "./webauthn.js";

type CborValue = number | string | Buffer | CborValue[] | Map<CborValue, CborValue>;

function cbor(value: CborValue): Buffer {
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

function clientData(type: string, challenge: string, origin = "https://jarvis.test:8443"): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin }));
}

function counter(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function coseKey(publicKey: KeyObject, alg: -7 | -257): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  if (alg === -7) {
    return cbor(
      new Map<CborValue, CborValue>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
  }
  return cbor(
    new Map<CborValue, CborValue>([
      [1, 3],
      [3, -257],
      [-1, Buffer.from(jwk.n!, "base64url")],
      [-2, Buffer.from(jwk.e!, "base64url")],
    ]),
  );
}

function authData(rpId: string, flags: number, signCount: number): Buffer {
  return Buffer.concat([
    createHash("sha256").update(rpId).digest(),
    Buffer.from([flags]),
    counter(signCount),
  ]);
}

function registrationFixture(
  alg: -7 | -257,
  overrides: { rpId?: string; flags?: number; fmt?: string } = {},
) {
  const pair =
    alg === -7
      ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credentialId = randomBytes(32);
  const cose = coseKey(pair.publicKey, alg);
  const base = authData(overrides.rpId ?? "jarvis.test", overrides.flags ?? 0xc5, 3);
  const credentialLength = Buffer.alloc(2);
  credentialLength.writeUInt16BE(credentialId.length);
  const attested = Buffer.concat([base, Buffer.alloc(16), credentialLength, credentialId, cose]);
  const attestation = cbor(
    new Map<CborValue, CborValue>([
      ["fmt", overrides.fmt ?? "none"],
      ["attStmt", new Map()],
      ["authData", attested],
    ]),
  );
  return { pair, credentialId, cose, attestation };
}

function assertionFixture(alg: -7 | -257, signCount: number, flags = 0x05) {
  const pair =
    alg === -7
      ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const cose = coseKey(pair.publicKey, alg);
  const challenge = randomBytes(32).toString("base64url");
  const client = clientData("webauthn.get", challenge);
  const authenticator = authData("jarvis.test", flags, signCount);
  const signed = Buffer.concat([authenticator, createHash("sha256").update(client).digest()]);
  const signature = sign(alg === -7 ? "sha256" : "RSA-SHA256", signed, pair.privateKey);
  return { challenge, client, authenticator, signature, cose };
}

describe("createChallengeStore", () => {
  it("issues 32-byte base64url challenges bound to connection and purpose and consumes once", () => {
    const store = createChallengeStore({ random: (size) => Buffer.alloc(size, 7), now: () => 100 });
    const challenge = store.issue("connection-a", "register");
    expect(Buffer.from(challenge, "base64url")).toHaveLength(32);
    expect(store.consume("connection-b", "register", challenge)).toBe(false);
    expect(store.consume("connection-a", "login", challenge)).toBe(false);
    expect(store.consume("connection-a", "register", challenge)).toBe(true);
    expect(store.consume("connection-a", "register", challenge)).toBe(false);
  });

  it("rejects a challenge after two minutes", () => {
    const clock = fakeClock();
    const store = createChallengeStore({ random: randomBytes, now: clock.now });
    const challenge = store.issue("connection-a", "login");
    clock.advance(120_001);
    expect(store.consume("connection-a", "login", challenge)).toBe(false);
  });

  it("invalidates the previous challenge when the same purpose is re-issued", () => {
    let value = 0;
    const store = createChallengeStore({
      random: (size) => Buffer.alloc(size, value++),
      now: () => 100,
    });
    const previous = store.issue("connection-a", "register");
    const latest = store.issue("connection-a", "register");

    expect(store.consume("connection-a", "register", previous)).toBe(false);
    expect(store.consume("connection-a", "register", latest)).toBe(true);
  });

  it("drops registration and login challenges for a connection", () => {
    let value = 0;
    const store = createChallengeStore({
      random: (size) => Buffer.alloc(size, value++),
      now: () => 100,
    });
    const registration = store.issue("connection-a", "register");
    const login = store.issue("connection-a", "login");

    store.drop("connection-a");

    expect(store.consume("connection-a", "register", registration)).toBe(false);
    expect(store.consume("connection-a", "login", login)).toBe(false);
  });

  it("sweeps expired challenges whenever a challenge is issued", () => {
    const clock = fakeClock();
    const store = createChallengeStore({ random: randomBytes, now: clock.now });
    store.issue("expired-a", "register");
    store.issue("expired-b", "login");
    clock.advance(120_001);

    store.issue("current", "login");

    expect(store.size()).toBe(1);
  });

  it("keeps the store bounded after 10000 connections expire", () => {
    const clock = fakeClock();
    const store = createChallengeStore({ random: randomBytes, now: clock.now });
    for (let index = 0; index < 10_000; index++) {
      store.issue(`connection-${index}`, "login");
    }
    expect(store.size()).toBe(10_000);
    clock.advance(120_001);

    store.issue("current", "login");

    expect(store.size()).toBe(1);
  });
});

describe("verifyRegistration", () => {
  for (const alg of [-7, -257] as const) {
    it(`accepts a valid ${alg === -7 ? "ES256" : "RS256"} none attestation`, () => {
      const fixture = registrationFixture(alg);
      const challenge = randomBytes(32).toString("base64url");
      expect(
        verifyRegistration({
          clientDataJSON: clientData("webauthn.create", challenge).toString("base64url"),
          attestationObject: fixture.attestation.toString("base64url"),
          expectedChallenge: challenge,
          expectedOrigin: "https://jarvis.test:8443",
          rpId: "jarvis.test",
        }),
      ).toEqual({
        ok: true,
        credentialId: fixture.credentialId.toString("base64url"),
        publicKey: fixture.cose.toString("base64url"),
        alg,
        signCount: 3,
      });
    });
  }

  it.each([
    [
      "wrong origin",
      clientData("webauthn.create", "challenge", "https://evil.test"),
      registrationFixture(-7),
    ],
    [
      "wrong rpId",
      clientData("webauthn.create", "challenge"),
      registrationFixture(-7, { rpId: "evil.test" }),
    ],
    [
      "UV missing",
      clientData("webauthn.create", "challenge"),
      registrationFixture(-7, { flags: 0xc1 }),
    ],
    [
      "UP missing",
      clientData("webauthn.create", "challenge"),
      registrationFixture(-7, { flags: 0xc4 }),
    ],
    ["wrong type", clientData("webauthn.get", "challenge"), registrationFixture(-7)],
    ["wrong challenge", clientData("webauthn.create", "other-challenge"), registrationFixture(-7)],
    [
      "non-none format",
      clientData("webauthn.create", "challenge"),
      registrationFixture(-7, { fmt: "packed" }),
    ],
  ])("rejects %s", (_name, client, fixture) => {
    expect(
      verifyRegistration({
        clientDataJSON: client.toString("base64url"),
        attestationObject: fixture.attestation.toString("base64url"),
        expectedChallenge: "challenge",
        expectedOrigin: "https://jarvis.test:8443",
        rpId: "jarvis.test",
      }).ok,
    ).toBe(false);
  });

  it("rejects malformed CBOR without throwing", () => {
    expect(
      verifyRegistration({
        clientDataJSON: clientData("webauthn.create", "challenge").toString("base64url"),
        attestationObject: Buffer.from([0xbf, 0xff]).toString("base64url"),
        expectedChallenge: "challenge",
        expectedOrigin: "https://jarvis.test:8443",
        rpId: "jarvis.test",
      }).ok,
    ).toBe(false);
  });
});

describe("verifyAssertion", () => {
  for (const alg of [-7, -257] as const) {
    it(`verifies a valid ${alg === -7 ? "ES256" : "RS256"} signature`, () => {
      const fixture = assertionFixture(alg, 4);
      expect(
        verifyAssertion({
          clientDataJSON: fixture.client.toString("base64url"),
          authenticatorData: fixture.authenticator.toString("base64url"),
          signature: fixture.signature.toString("base64url"),
          expectedChallenge: fixture.challenge,
          expectedOrigin: "https://jarvis.test:8443",
          rpId: "jarvis.test",
          publicKey: fixture.cose.toString("base64url"),
          alg,
          storedSignCount: 3,
        }),
      ).toEqual({ ok: true, signCount: 4 });
    });
  }

  it("allows counters to remain zero", () => {
    const fixture = assertionFixture(-7, 0);
    expect(
      verifyAssertion({
        clientDataJSON: fixture.client.toString("base64url"),
        authenticatorData: fixture.authenticator.toString("base64url"),
        signature: fixture.signature.toString("base64url"),
        expectedChallenge: fixture.challenge,
        expectedOrigin: "https://jarvis.test:8443",
        rpId: "jarvis.test",
        publicKey: fixture.cose.toString("base64url"),
        alg: -7,
        storedSignCount: 0,
      }).ok,
    ).toBe(true);
  });

  it("rejects a signCount regression", () => {
    const fixture = assertionFixture(-7, 3);
    expect(
      verifyAssertion({
        clientDataJSON: fixture.client.toString("base64url"),
        authenticatorData: fixture.authenticator.toString("base64url"),
        signature: fixture.signature.toString("base64url"),
        expectedChallenge: fixture.challenge,
        expectedOrigin: "https://jarvis.test:8443",
        rpId: "jarvis.test",
        publicKey: fixture.cose.toString("base64url"),
        alg: -7,
        storedSignCount: 3,
      }).ok,
    ).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const fixture = assertionFixture(-7, 4);
    fixture.signature.writeUInt8(fixture.signature.readUInt8(0) ^ 1, 0);
    expect(
      verifyAssertion({
        clientDataJSON: fixture.client.toString("base64url"),
        authenticatorData: fixture.authenticator.toString("base64url"),
        signature: fixture.signature.toString("base64url"),
        expectedChallenge: fixture.challenge,
        expectedOrigin: "https://jarvis.test:8443",
        rpId: "jarvis.test",
        publicKey: fixture.cose.toString("base64url"),
        alg: -7,
        storedSignCount: 3,
      }).ok,
    ).toBe(false);
  });
});
