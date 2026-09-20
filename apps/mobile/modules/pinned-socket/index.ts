import { FINGERPRINT_PATTERN } from "@jarvis/wire";
import NativeModule, { type PinnedSocketEvents } from "./src/PinnedSocketModule";

export type { PinnedSocketEvents };

/** Thrown by `open` when `fingerprintHex` does not match `FINGERPRINT_PATTERN`.
 * A defense-in-depth check: `apps/mobile/src/lib/native-transport.ts` (the
 * only caller) already validates before reaching here, so this should never
 * fire in practice, but the native module JS API never forwards an
 * unvalidated value regardless of caller. */
export class InvalidFingerprintError extends Error {
  constructor() {
    super("invalid fingerprint");
  }
}

export function open(url: string, fingerprintHex: string): number {
  if (!FINGERPRINT_PATTERN.test(fingerprintHex)) {
    throw new InvalidFingerprintError();
  }
  return NativeModule.open(url, fingerprintHex);
}

export function send(id: number, text: string): void {
  NativeModule.send(id, text);
}

export function sendBinary(id: number, base64: string): void {
  NativeModule.sendBinary(id, base64);
}

export function close(id: number, code: number, reason: string): void {
  NativeModule.close(id, code, reason);
}

export function addListener<EventName extends keyof PinnedSocketEvents>(
  eventName: EventName,
  listener: PinnedSocketEvents[EventName],
): { remove(): void } {
  return NativeModule.addListener(eventName, listener);
}
