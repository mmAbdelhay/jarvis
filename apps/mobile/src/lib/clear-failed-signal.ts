// A one-shot, in-memory "the automatic unpaired handler tried to clear the
// stored pairing and couldn't" signal (final review I1). Previously carried
// as a `clearFailed=1` route param on the `/pair` navigation — but Expo
// Router maps `jarvis://pair?...&clearFailed=1` to the very same route
// param, so a crafted link could forge it and bypass the "refuse while
// paired" check. Neither function here takes a URL, a param, or any other
// caller-supplied value: the only way this flag is ever set is
// `unpaired-handler.ts` calling `setClearFailedSignal()` after its own
// `clearPairing()` call throws. There is no path from a link — or from
// anything else — into it, forged or not.
let signalled = false;

export function setClearFailedSignal(): void {
  signalled = true;
}

/** Reads and clears the flag in one step — consumed exactly once. */
export function takeClearFailedSignal(): boolean {
  const value = signalled;
  signalled = false;
  return value;
}
