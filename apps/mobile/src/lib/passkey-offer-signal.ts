// A one-shot, in-memory "this browser just paired" signal (Task 13), in the
// style of clear-failed-signal.ts: pair.web.tsx sets it after a successful
// pairing, and the web unlock screen consumes it after the first password
// sign-in to offer adding a passkey. Never set from a link or a route
// param, and gone on reload (the offer is a convenience, not a gate).
let signalled = false;

export function setPasskeyOfferSignal(): void {
  signalled = true;
}

/** Reads and clears the flag in one step. */
export function takePasskeyOfferSignal(): boolean {
  const value = signalled;
  signalled = false;
  return value;
}
