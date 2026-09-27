import { createHash, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakeClock } from "./clock-double.js";
import { createChallengeStore, verifyAssertion, verifyRegistration } from "./webauthn.js";
import { attestationObject, authData, clientData, coseKey, keyPair } from "./webauthn-double.js";

function registrationFixture(
  alg: -7 | -257,
  overrides: { rpId?: string; flags?: number; fmt?: string } = {},
) {
  const pair = keyPair(alg);
  const credentialId = randomBytes(32);
  const cose = coseKey(pair.publicKey, alg);
  const attestation = attestationObject({ credentialId, cose, ...overrides });
  return { pair, credentialId, cose, attestation };
}

function assertionFixture(alg: -7 | -257, signCount: number, flags = 0x05) {
  const pair = keyPair(alg);
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
