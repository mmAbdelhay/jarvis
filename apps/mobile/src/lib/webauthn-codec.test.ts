import { describe, expect, it } from "vitest";
import {
  assertionToWire,
  attestationToWire,
  base64urlDecode,
  base64urlEncode,
  creationOptionsFromWire,
  requestOptionsFromWire,
} from "./webauthn-codec";

function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

describe("base64url", () => {
  it("encodes without padding using the url-safe alphabet", () => {
    expect(base64urlEncode(bytes())).toBe("");
    expect(base64urlEncode(bytes(0xfb))).toBe("-w");
    expect(base64urlEncode(bytes(0xfb, 0xff))).toBe("-_8");
    expect(base64urlEncode(bytes(1, 2, 3))).toBe("AQID");
  });

  it("matches btoa-based base64url for every length up to 64 random bytes", () => {
    for (let length = 0; length <= 64; length += 1) {
      const data = new Uint8Array(length);
      crypto.getRandomValues(data);
      const encoded = base64urlEncode(data);
      const reference = btoa(String.fromCharCode(...data))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      expect(encoded).toBe(reference);
      expect([...base64urlDecode(encoded)]).toEqual([...data]);
    }
  });

  it("accepts an ArrayBuffer as input", () => {
    expect(base64urlEncode(bytes(1, 2, 3).buffer)).toBe("AQID");
  });

  it("refuses padding, the standard alphabet, a dangling character and non-canonical tails", () => {
    expect(() => base64urlDecode("AQ==")).toThrow();
    expect(() => base64urlDecode("+w")).toThrow();
    expect(() => base64urlDecode("A")).toThrow();
    // "-x" decodes to 0xfb with nonzero leftover bits: the server's own
    // decoder refuses it, so the client never produces or accepts it.
    expect(() => base64urlDecode("-x")).toThrow();
  });
});

describe("requestOptionsFromWire", () => {
  it("turns auth:passkeyBegin's answer into navigator.credentials.get options", () => {
    const options = requestOptionsFromWire({
      challenge: "AQID",
      rpId: "laptop.tail.ts.net",
      allowCredentials: ["-w"],
      userVerification: "required",
      timeout: 120_000,
    });
    expect([...new Uint8Array(options.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect(options.rpId).toBe("laptop.tail.ts.net");
    expect(options.userVerification).toBe("required");
    expect(options.timeout).toBe(120_000);
    const allowed = options.allowCredentials ?? [];
    expect(allowed).toHaveLength(1);
    expect(allowed[0]?.type).toBe("public-key");
    expect([...new Uint8Array(allowed[0]?.id as ArrayBuffer)]).toEqual([0xfb]);
  });

  it("defaults user verification to required and omits an empty allow list", () => {
    const options = requestOptionsFromWire({ challenge: "AQID", rpId: "h" });
    expect(options.userVerification).toBe("required");
    expect(options.allowCredentials).toBeUndefined();
  });
});

describe("creationOptionsFromWire", () => {
  it("turns auth:passkeyRegisterBegin's answer into navigator.credentials.create options", () => {
    const options = creationOptionsFromWire({
      challenge: "AQID",
      rpId: "laptop.tail.ts.net",
      user: { id: "BAUG", name: "owner", displayName: "Jarvis owner" },
      excludeCredentials: ["-w"],
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      attestation: "none",
      timeout: 120_000,
    });
    expect(options.rp).toEqual({ id: "laptop.tail.ts.net", name: "Jarvis" });
    expect([...new Uint8Array(options.user.id as ArrayBuffer)]).toEqual([4, 5, 6]);
    expect(options.user.name).toBe("owner");
    expect(options.user.displayName).toBe("Jarvis owner");
    expect([...new Uint8Array(options.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect(options.pubKeyCredParams.map((param) => param.alg)).toEqual([-7, -257]);
    expect(options.excludeCredentials?.[0]?.type).toBe("public-key");
    expect(options.authenticatorSelection).toEqual({
      userVerification: "required",
      residentKey: "preferred",
    });
    expect(options.attestation).toBe("none");
    expect(options.timeout).toBe(120_000);
  });

  it("falls back to ES256 then RS256, user verification required and no attestation", () => {
    const options = creationOptionsFromWire({
      challenge: "AQID",
      rpId: "h",
      user: { id: "BAUG", name: "owner", displayName: "Jarvis owner" },
    });
    expect(options.pubKeyCredParams).toEqual([
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ]);
    expect(options.authenticatorSelection?.userVerification).toBe("required");
    expect(options.attestation).toBe("none");
  });
});

describe("credential to wire", () => {
  it("maps an assertion to auth:passkeyFinish's fields", () => {
    const wire = assertionToWire({
      rawId: bytes(0xfb).buffer,
      response: {
        clientDataJSON: bytes(1).buffer,
        authenticatorData: bytes(2).buffer,
        signature: bytes(3).buffer,
        userHandle: bytes(4, 5, 6).buffer,
      },
    });
    expect(wire).toEqual({
      credentialId: "-w",
      clientDataJSON: "AQ",
      authenticatorData: "Ag",
      signature: "Aw",
      userHandle: "BAUG",
    });
  });

  it("omits a missing user handle", () => {
    const wire = assertionToWire({
      rawId: bytes(0xfb).buffer,
      response: {
        clientDataJSON: bytes(1).buffer,
        authenticatorData: bytes(2).buffer,
        signature: bytes(3).buffer,
        userHandle: null,
      },
    });
    expect("userHandle" in wire).toBe(false);
  });

  it("maps an attestation to auth:passkeyRegisterFinish's fields with the label", () => {
    const wire = attestationToWire(
      {
        rawId: bytes(0xfb).buffer,
        response: { clientDataJSON: bytes(1).buffer, attestationObject: bytes(7).buffer },
      },
      "Chrome · macOS",
    );
    expect(wire).toEqual({
      credentialId: "-w",
      clientDataJSON: "AQ",
      attestationObject: "Bw",
      label: "Chrome · macOS",
    });
  });
});
