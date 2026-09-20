// why: table-driven proof of rule 2's exact match — every field that must
// disqualify a challenge, one at a time, plus the one combination that must
// pass. See the "bite-proof" case below for why the host compare is exact.
import { describe, expect, it } from "vitest";
import { dbGateLoginAnswer, type LoginAuthInfo } from "./dbgate-login.js";

const authInfo = (overrides: Partial<LoginAuthInfo> = {}): LoginAuthInfo => ({
  isProxy: false,
  scheme: "basic",
  host: "127.0.0.1",
  port: 51234,
  realm: "DbGate Web App",
  ...overrides,
});

const CREDENTIAL = { login: "jarvis", password: "pw" };
const credentialFor = (port: number): { login: string; password: string } | undefined =>
  port === 51234 ? CREDENTIAL : undefined;

describe("dbGateLoginAnswer", () => {
  it("answers a basic-auth challenge on 127.0.0.1 for a running instance's port", () => {
    expect(dbGateLoginAnswer(authInfo(), credentialFor)).toEqual(CREDENTIAL);
  });

  it("refuses a proxy auth challenge", () => {
    expect(dbGateLoginAnswer(authInfo({ isProxy: true }), credentialFor)).toBeUndefined();
  });

  it("refuses anything but basic auth", () => {
    expect(dbGateLoginAnswer(authInfo({ scheme: "digest" }), credentialFor)).toBeUndefined();
  });

  it("refuses localhost — only the literal 127.0.0.1 DbGate spawns on qualifies", () => {
    expect(dbGateLoginAnswer(authInfo({ host: "localhost" }), credentialFor)).toBeUndefined();
  });

  it("refuses ::1", () => {
    expect(dbGateLoginAnswer(authInfo({ host: "::1" }), credentialFor)).toBeUndefined();
  });

  it("refuses a port with no running instance", () => {
    expect(dbGateLoginAnswer(authInfo({ port: 9999 }), credentialFor)).toBeUndefined();
  });

  // [bite-proof] relax the host compare to `host.startsWith("127.")` and
  // this fails: 127.0.0.2 is not the loopback literal DbGate is told to
  // bind, and a "close enough" match would hand a credential to a
  // different address, however unlikely one is to be listening there.
  it("refuses a different 127.x host, not just non-loopback ones", () => {
    expect(dbGateLoginAnswer(authInfo({ host: "127.0.0.2" }), credentialFor)).toBeUndefined();
  });

  // DbGate itself always listens on 0.0.0.0 (it has no bind-address
  // option), so a challenge naming that address is a real thing Electron
  // can raise — and it must not be answered: 0.0.0.0 is not the loopback
  // literal the host compare requires.
  it("refuses 0.0.0.0, even though that is the address DbGate itself listens on", () => {
    expect(dbGateLoginAnswer(authInfo({ host: "0.0.0.0" }), credentialFor)).toBeUndefined();
  });

  // `realm` is deliberately not part of the contract (see the function
  // doc): DbGate's realm string is not something this decision checks, so
  // an unexpected one must not change the answer.
  it("answers regardless of realm — realm is not part of the contract", () => {
    expect(dbGateLoginAnswer(authInfo({ realm: "unexpected realm" }), credentialFor)).toEqual(
      CREDENTIAL,
    );
  });
});
