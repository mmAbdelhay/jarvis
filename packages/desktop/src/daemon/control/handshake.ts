// The control handshake's proofs (task 20 review C1, controller ruling):
// mutual HMAC-SHA256 challenge-response, server first. The secret never
// crosses the wire, so a peer that answers on the endpoint without being the
// daemon (a squatted Windows pipe) can neither harvest it nor pass the client's
// check; and each side's proof covers the other side's fresh 32-byte nonce, so
// a recorded proof is useless on the next connection.
//
//   client → {t:"hello", v, build, nonceC}
//   server → {t:"challenge", nonceS, proof: HMAC(secret, "jarvisd-server"‖nonceC‖nonceS)}
//   client → {t:"auth", proof: HMAC(secret, "jarvisd-client"‖nonceS‖nonceC)}
//   server → {t:"welcome", …} | {t:"restart-required", build}
//
// The distinct labels stop one side's proof being replayed as the other's.
import { createHmac, timingSafeEqual } from "node:crypto";

export const NONCE_BYTES = 32;
/** 32 bytes as lowercase hex: nonces, proofs and the secret file's content alike. */
export const HEX32_PATTERN = /^[0-9a-f]{64}$/;

function proof(secret: Uint8Array, label: string, first: Uint8Array, second: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(label).update(first).update(second).digest();
}

export function serverProof(secret: Uint8Array, nonceC: Uint8Array, nonceS: Uint8Array): Buffer {
  return proof(secret, "jarvisd-server", nonceC, nonceS);
}

export function clientProof(secret: Uint8Array, nonceS: Uint8Array, nonceC: Uint8Array): Buffer {
  return proof(secret, "jarvisd-client", nonceS, nonceC);
}

/** Constant-time; a malformed `given` is simply a mismatch. */
export function proofMatches(expected: Buffer, given: string): boolean {
  if (!HEX32_PATTERN.test(given)) return false;
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}
