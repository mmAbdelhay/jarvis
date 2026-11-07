// A one-shot, in-memory "this tree comes from a revocation that left no machine"
// signal, in the style of clear-failed-signal.ts and for the same reason: never
// a route param, since `jarvis://pair?...` maps to the /pair route's params and
// a link could forge it. The only caller is `MachineSessions.forget`, for cause
// `revoked`, just before it publishes the null scope, and the layout's listener
// for that publish takes it. An unpair, or a pair-again, asked for by the user,
// never sets it.

let signalled = false;

export function setRevokedSignal(): void {
  signalled = true;
}

/** Reads and clears the signal in one step — consumed exactly once. */
export function takeRevokedSignal(): boolean {
  const value = signalled;
  signalled = false;
  return value;
}
