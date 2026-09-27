// The browser build's passkeys (Task 13): a thin wrapper over
// `navigator.credentials`. Every conversion to and from the laptop's
// base64url wire shapes lives in webauthn-codec.ts (pure, tested); this
// file only calls the browser and sorts its errors:
// - NotAllowedError / AbortError: the owner dismissed the sheet (or the
//   browser refused to show it without a tap) -> cancelled.
// - InvalidStateError on create: this authenticator already holds one of
//   the owner's passkeys (the exclude list matched) -> "exists".
// - anything else rethrows; the flows turn it into "failed".
import type { Passkeys } from "./passkey";
import {
  type AssertionCredential,
  type AttestationCredential,
  assertionToWire,
  attestationToWire,
  creationOptionsFromWire,
  requestOptionsFromWire,
} from "./webauthn-codec";

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : undefined;
}

function isDismissal(error: unknown): boolean {
  const name = errorName(error);
  return name === "NotAllowedError" || name === "AbortError";
}

export const passkeys: Passkeys = {
  isSupported() {
    return (
      typeof window !== "undefined" &&
      typeof window.PublicKeyCredential === "function" &&
      typeof navigator.credentials?.get === "function"
    );
  },
  async hasPlatformAuthenticator() {
    if (!passkeys.isSupported()) return false;
    try {
      return (
        (await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) === true
      );
    } catch {
      return false;
    }
  },
  async getAssertion(options) {
    let credential: Credential | null;
    try {
      credential = await navigator.credentials.get({ publicKey: requestOptionsFromWire(options) });
    } catch (error) {
      if (isDismissal(error)) return undefined;
      throw error;
    }
    if (credential === null) return undefined;
    return assertionToWire(credential as unknown as AssertionCredential);
  },
  async create(options) {
    let credential: Credential | null;
    try {
      credential = await navigator.credentials.create({
        publicKey: creationOptionsFromWire(options),
      });
    } catch (error) {
      if (isDismissal(error)) return "cancelled";
      if (errorName(error) === "InvalidStateError") return "exists";
      throw error;
    }
    if (credential === null) return "cancelled";
    // The label is the owner's, added by passkey-registration.ts.
    const { label: _label, ...created } = attestationToWire(
      credential as unknown as AttestationCredential,
      "",
    );
    return created;
  },
};
