// why: main.ts has no tests, so the one decision that matters here — which
// login challenge is allowed to receive a DbGate credential, and for which
// port — has to live somewhere testable. A mistake here would hand a
// credential to the wrong origin, so this file is pure (no Electron import)
// and main.ts only wires its answer into `app.on("login", …)` (ruling 15).

/** The subset of Electron's `AuthInfo` this decision reads. */
export type LoginAuthInfo = {
  isProxy: boolean;
  scheme: string;
  host: string;
  port: number;
  realm: string;
};

/**
 * Decides whether an Electron `login` challenge should be answered with a
 * DbGate credential. Only true for a same-process, HTTP basic-auth
 * challenge on exactly the loopback literal DbGate is spawned on —
 * "127.0.0.1", never "localhost" or "::1", which name the same host but are
 * not the string DbGate's `express-basic-auth` challenge carries — and only
 * for a port a DbGate instance is running on right now. `realm` is not
 * consulted: DbGate's realm string ("DbGate Web App") is not a contract.
 */
export function dbGateLoginAnswer(
  authInfo: LoginAuthInfo,
  credentialFor: (port: number) => { login: string; password: string } | undefined,
): { login: string; password: string } | undefined {
  if (authInfo.isProxy) return undefined;
  if (authInfo.scheme !== "basic") return undefined;
  if (authInfo.host !== "127.0.0.1") return undefined;
  return credentialFor(authInfo.port);
}
