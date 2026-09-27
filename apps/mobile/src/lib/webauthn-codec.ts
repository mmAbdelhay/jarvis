// WebAuthn <-> wire conversion for the browser build's passkeys (Task 13).
// Pure: no `navigator`, no DOM calls — passkey.web.ts hands the browser's
// credential objects in and the server's `auth:passkey*` shapes come out.
// Every binary value on the wire is unpadded, canonical base64url, exactly
// what packages/remote/src/webauthn.ts decodes (it refuses padding and
// non-canonical tails, so this module never produces or accepts them).

import type { AuthArgs, PasskeyLoginOptions, PasskeyRegisterOptions } from "@jarvis/wire";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const DECODE = new Map<string, number>([...ALPHABET].map((char, index) => [char, index]));
/** The relying party's display name in the browser's passkey sheet. */
const RP_NAME = "Jarvis";
const DEFAULT_ALGORITHMS: ReadonlyArray<-7 | -257> = [-7, -257];

export function base64urlEncode(input: ArrayBuffer | Uint8Array): string {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  let out = "";
  for (let index = 0; index < data.length; index += 3) {
    const count = Math.min(3, data.length - index);
    const n = ((data[index] ?? 0) << 16) | ((data[index + 1] ?? 0) << 8) | (data[index + 2] ?? 0);
    // 1 byte -> 2 characters, 2 -> 3, 3 -> 4 (no padding).
    for (let shift = 18, emitted = 0; emitted <= count; shift -= 6, emitted += 1) {
      out += ALPHABET.charAt((n >> shift) & 63);
    }
  }
  return out;
}

/** Throws on anything but canonical unpadded base64url. */
export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (text.length % 4 === 1) throw new Error("invalid base64url length");
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let written = 0;
  for (const char of text) {
    const sextet = DECODE.get(char);
    if (sextet === undefined) throw new Error("invalid base64url character");
    value = (value << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written] = (value >> bits) & 0xff;
      written += 1;
    }
  }
  // Leftover bits must be zero, or two encodings map to the same bytes.
  if ((value & ((1 << bits) - 1)) !== 0) throw new Error("non-canonical base64url");
  return out;
}

function toBuffer(text: string): ArrayBuffer {
  return base64urlDecode(text).buffer;
}

function descriptors(ids: string[] | undefined): PublicKeyCredentialDescriptor[] | undefined {
  if (ids === undefined || ids.length === 0) return undefined;
  return ids.map((id) => ({ type: "public-key", id: toBuffer(id) }));
}

/** `auth:passkeyBegin`'s answer as `navigator.credentials.get({publicKey})`. */
export function requestOptionsFromWire(
  options: PasskeyLoginOptions,
): PublicKeyCredentialRequestOptions {
  const result: PublicKeyCredentialRequestOptions = {
    challenge: toBuffer(options.challenge),
    rpId: options.rpId,
    userVerification: options.userVerification ?? "required",
  };
  const allow = descriptors(options.allowCredentials);
  if (allow !== undefined) result.allowCredentials = allow;
  if (options.timeout !== undefined) result.timeout = options.timeout;
  return result;
}

/** `auth:passkeyRegisterBegin`'s answer as `navigator.credentials.create({publicKey})`. */
export function creationOptionsFromWire(
  options: PasskeyRegisterOptions,
): PublicKeyCredentialCreationOptions {
  const algorithms = options.pubKeyCredParams?.map((param) => param.alg) ?? DEFAULT_ALGORITHMS;
  const result: PublicKeyCredentialCreationOptions = {
    challenge: toBuffer(options.challenge),
    rp: { id: options.rpId, name: RP_NAME },
    user: {
      id: toBuffer(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    pubKeyCredParams: algorithms.map((alg) => ({ type: "public-key", alg })),
    authenticatorSelection: options.authenticatorSelection ?? {
      userVerification: "required",
      residentKey: "preferred",
    },
    attestation: options.attestation ?? "none",
  };
  const exclude = descriptors(options.excludeCredentials);
  if (exclude !== undefined) result.excludeCredentials = exclude;
  if (options.timeout !== undefined) result.timeout = options.timeout;
  return result;
}

/** The parts of a `get()` result the server needs. */
export type AssertionCredential = {
  rawId: ArrayBuffer;
  response: {
    clientDataJSON: ArrayBuffer;
    authenticatorData: ArrayBuffer;
    signature: ArrayBuffer;
    userHandle: ArrayBuffer | null;
  };
};

/** The parts of a `create()` result the server needs. */
export type AttestationCredential = {
  rawId: ArrayBuffer;
  response: { clientDataJSON: ArrayBuffer; attestationObject: ArrayBuffer };
};

export function assertionToWire(credential: AssertionCredential): AuthArgs["auth:passkeyFinish"] {
  const { response } = credential;
  const wire: AuthArgs["auth:passkeyFinish"] = {
    credentialId: base64urlEncode(credential.rawId),
    clientDataJSON: base64urlEncode(response.clientDataJSON),
    authenticatorData: base64urlEncode(response.authenticatorData),
    signature: base64urlEncode(response.signature),
  };
  if (response.userHandle !== null) wire.userHandle = base64urlEncode(response.userHandle);
  return wire;
}

export function attestationToWire(
  credential: AttestationCredential,
  label: string,
): AuthArgs["auth:passkeyRegisterFinish"] {
  return {
    credentialId: base64urlEncode(credential.rawId),
    clientDataJSON: base64urlEncode(credential.response.clientDataJSON),
    attestationObject: base64urlEncode(credential.response.attestationObject),
    label,
  };
}
