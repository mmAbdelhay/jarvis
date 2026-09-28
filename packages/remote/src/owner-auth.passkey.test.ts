// The four passkey channels end to end through createOwnerAuth: a real
// owner store (memory fs, test scrypt cost), a real session store, the real
// login limits, and a software authenticator on node:crypto keys.

import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "./audit.js";
import { fakeClock } from "./clock-double.js";
import { memoryFs } from "./fs-double.js";
import { createLoginLimits, DEVICE_FAILURES_BEFORE_LOCKOUT } from "./login-limits.js";
import { createOwnerStore } from "./owner.js";
import { OWNER_TEST_HASH_PARAMS } from "./owner-double.js";
import type { AuthContext, AuthOutcome, AuthSession } from "./owner-auth.js";
import { createOwnerAuth, PASSKEY_TIMEOUT_MS } from "./owner-auth.js";
import { createSessionStore } from "./sessions.js";
import { softAuthenticator } from "./webauthn-double.js";

const PASSWORD = "correct horse battery";
const RP_ID = "laptop.tailnet.ts.net";
const ORIGIN = `https://${RP_ID}:8443`;
const OWNER_PATH = "/remote/owner.json";
const DEVICE = { id: "d".repeat(32), name: "Phone" };
const SOURCE = "100.64.0.2";

async function makeHarness(
  options: { webOrigin?: string | undefined; rpId?: string | undefined } = {},
) {
  const clock = fakeClock(10_000);
  const fs = memoryFs();
  const makeOwner = () =>
    createOwnerStore({
      fs,
      path: OWNER_PATH,
      random: randomBytes,
      now: clock.now,
      enforceFileModes: true,
      hashParams: OWNER_TEST_HASH_PARAMS,
    });
  const owner = makeOwner();
  await owner.load();
  await owner.setPassword(PASSWORD);
  const sessions = createSessionStore({
    fs,
    path: "/remote/sessions.json",
    random: randomBytes,
    now: clock.now,
    enforceFileModes: true,
  });
  const events: AuditEvent[] = [];
  const audit = { record: (event: AuditEvent) => events.push(event) };
  const log = vi.fn<(line: string) => void>();
  const onPasskeyAdded = vi.fn();
  const removePasskey = vi.fn((credentialId: string) => owner.deletePasskey(credentialId));
  const webOrigin = "webOrigin" in options ? options.webOrigin : ORIGIN;
  const rpId = "rpId" in options ? options.rpId : RP_ID;
  const auth = createOwnerAuth({
    owner,
    sessions,
    random: randomBytes,
    now: clock.now,
    audit,
    log,
    lockFamily: vi.fn(),
    limits: createLoginLimits({ now: clock.now, audit, notifyDesktop: vi.fn() }),
    rpId: () => rpId,
    webOrigin: () => webOrigin,
    onPasskeyAdded,
    removePasskey,
  });
  return {
    clock,
    fs,
    owner,
    makeOwner,
    sessions,
    auth,
    events,
    log,
    onPasskeyAdded,
    removePasskey,
  };
}

type Harness = Awaited<ReturnType<typeof makeHarness>>;

function ctx(session?: AuthSession, connectionId = "c1"): AuthContext {
  return { connectionId, device: DEVICE, source: SOURCE, session };
}

function answerOf<T>(outcome: AuthOutcome): T {
  if (outcome.kind !== "value") throw new Error(`expected a value, got ${outcome.code}`);
  return outcome.value as T;
}

const FORBIDDEN = { kind: "error", code: "forbidden" };

/** Logs in with the password and answers the session the connection would now hold. */
async function unlocked(h: Harness, connectionId = "c1"): Promise<AuthContext> {
  const outcome = await h.auth.handle(
    "auth:login",
    { password: PASSWORD },
    ctx(undefined, connectionId),
  );
  if (outcome.kind !== "value" || outcome.effect === undefined || !("unlock" in outcome.effect)) {
    throw new Error("login failed");
  }
  return ctx(outcome.effect.unlock, connectionId);
}

/** Registers `authenticator` over an unlocked connection; answers the finish outcome. */
async function register(
  h: Harness,
  authenticator: ReturnType<typeof softAuthenticator>,
  context: AuthContext,
  label = "Laptop Chrome",
): Promise<AuthOutcome> {
  const options = answerOf<{ challenge: string }>(
    await h.auth.handle("auth:passkeyRegisterBegin", { password: PASSWORD }, context),
  );
  return h.auth.handle(
    "auth:passkeyRegisterFinish",
    { ...authenticator.register(options.challenge), label },
    context,
  );
}

async function loginChallenge(h: Harness, context: AuthContext = ctx()): Promise<string> {
  return answerOf<{ challenge: string }>(await h.auth.handle("auth:passkeyBegin", {}, context))
    .challenge;
}

describe("passkeys: unsupported until the relying party is known", () => {
  it.each([
    ["no web origin", { webOrigin: undefined }],
    ["no certificate name", { rpId: undefined }],
    ["an origin on another host", { webOrigin: "https://elsewhere.example:8443" }],
    ["a non-https origin", { webOrigin: `http://${RP_ID}:8443` }],
  ])(
    "with %s, passkeyBegin and passkeyRegisterBegin answer unsupported",
    async (_name, options) => {
      const h = await makeHarness(options);
      const context = await unlocked(h);
      expect(await h.auth.handle("auth:passkeyBegin", {}, ctx())).toEqual({
        kind: "error",
        code: "unsupported",
      });
      expect(
        await h.auth.handle("auth:passkeyRegisterBegin", { password: PASSWORD }, context),
      ).toEqual({ kind: "error", code: "unsupported" });
    },
  );
});

describe("passkeys: relying party", () => {
  it("answers the certificate name lower-cased as the rpId", async () => {
    const h = await makeHarness({ rpId: RP_ID.toUpperCase() });
    expect(
      answerOf<{ rpId: string }>(await h.auth.handle("auth:passkeyBegin", {}, ctx())).rpId,
    ).toBe(RP_ID);
  });
});

describe("passkeys: registration", () => {
  it("passkeyRegisterBegin needs the password and answers create() options", async () => {
    const h = await makeHarness();
    const context = await unlocked(h);
    const options = answerOf<Record<string, unknown>>(
      await h.auth.handle("auth:passkeyRegisterBegin", { password: PASSWORD }, context),
    );
    const handle = await h.owner.ownerHandle();
    expect(options).toEqual({
      challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      rpId: RP_ID,
      user: { id: handle, name: "owner", displayName: "Jarvis owner" },
      excludeCredentials: [],
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      attestation: "none",
      timeout: PASSKEY_TIMEOUT_MS,
    });
  });

  it("refuses passkeyRegisterBegin on a locked connection", async () => {
    const h = await makeHarness();
    expect(await h.auth.handle("auth:passkeyRegisterBegin", { password: PASSWORD }, ctx())).toEqual(
      { kind: "error", code: "locked" },
    );
  });

  it("a wrong re-entered password is forbidden, audited login-failed, and counts toward the lockout", async () => {
    const h = await makeHarness();
    const context = await unlocked(h);
    for (let i = 0; i < DEVICE_FAILURES_BEFORE_LOCKOUT; i++) {
      expect(
        await h.auth.handle("auth:passkeyRegisterBegin", { password: "not the password" }, context),
      ).toEqual(FORBIDDEN);
    }
    expect(h.events).toContainEqual({ kind: "login-failed", deviceId: DEVICE.id, source: SOURCE });
    expect(
      await h.auth.handle("auth:passkeyRegisterBegin", { password: PASSWORD }, context),
    ).toEqual({ kind: "error", code: "rate-limited" });
    expect(await h.auth.handle("auth:login", { password: PASSWORD }, ctx())).toEqual({
      kind: "error",
      code: "rate-limited",
    });
  });

  it("stores a verified passkey with its label, audits only a credential prefix, and tells the desktop", async () => {
    const h = await makeHarness();
    const context = await unlocked(h);
    const authenticator = softAuthenticator({ alg: -257, rpId: RP_ID, origin: ORIGIN });

    expect(await register(h, authenticator, context, "Work laptop")).toEqual({
      kind: "value",
      value: null,
    });

    const [stored] = h.owner.listPasskeys();
    expect(stored).toMatchObject({
      credentialId: authenticator.credentialId,
      alg: -257,
      signCount: 0,
      label: "Work laptop",
      createdAt: h.clock.now(),
    });
    expect(h.events).toContainEqual({
      kind: "passkey-added",
      deviceId: DEVICE.id,
      source: SOURCE,
      credentialPrefix: authenticator.credentialId.slice(0, 8),
    });
    const audited = JSON.stringify(h.events);
    expect(audited).not.toContain(authenticator.credentialId);
    expect(audited).not.toContain(stored?.publicKey);
    expect(h.onPasskeyAdded).toHaveBeenCalledTimes(1);

    // Persisted: a fresh store reads it back.
    const reloaded = h.makeOwner();
    await reloaded.load();
    expect(reloaded.listPasskeys()).toEqual([stored]);
  });

  it("excludes existing credentials and refuses registering the same credential twice", async () => {
    const h = await makeHarness();
    const context = await unlocked(h);
    const authenticator = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    await register(h, authenticator, context);

    const options = answerOf<{ challenge: string; excludeCredentials: string[] }>(
      await h.auth.handle("auth:passkeyRegisterBegin", { password: PASSWORD }, context),
    );
    expect(options.excludeCredentials).toEqual([authenticator.credentialId]);
    expect(
      await h.auth.handle(
        "auth:passkeyRegisterFinish",
        { ...authenticator.register(options.challenge), label: "Again" },
        context,
      ),
    ).toEqual({ kind: "error", code: "bad-request" });
    expect(h.owner.listPasskeys()).toHaveLength(1);
  });

  it("rejects a wrong origin, a replayed challenge and a finish from another login", async () => {
    const h = await makeHarness();
    const context = await unlocked(h);
    const authenticator = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });

    const first = answerOf<{ challenge: string }>(
      await h.auth.handle("auth:passkeyRegisterBegin", { password: PASSWORD }, context),
    );
    const wrongOrigin = {
      ...authenticator.register(first.challenge, { origin: "https://evil.example:8443" }),
      label: "Evil",
    };
    expect(await h.auth.handle("auth:passkeyRegisterFinish", wrongOrigin, context)).toEqual(
      FORBIDDEN,
    );
    // The challenge was consumed by that attempt: the right answer to it now fails too.
    const replay = { ...authenticator.register(first.challenge), label: "Replay" };
    expect(await h.auth.handle("auth:passkeyRegisterFinish", replay, context)).toEqual(FORBIDDEN);

    const second = answerOf<{ challenge: string }>(
      await h.auth.handle("auth:passkeyRegisterBegin", { password: PASSWORD }, context),
    );
    const otherLogin = await unlocked(h);
    expect(
      await h.auth.handle(
        "auth:passkeyRegisterFinish",
        { ...authenticator.register(second.challenge), label: "Other" },
        otherLogin,
      ),
    ).toEqual(FORBIDDEN);
    expect(h.owner.listPasskeys()).toEqual([]);
    expect(h.onPasskeyAdded).not.toHaveBeenCalled();
  });
});

describe("passkeys: registration across an invalidation", () => {
  it("passkeyRegisterBegin is refused when an invalidation lands while the password is checked", async () => {
    const h = await makeHarness();
    const context = await unlocked(h);
    const pending = h.auth.handle("auth:passkeyRegisterBegin", { password: PASSWORD }, context);
    h.auth.invalidate();
    expect(await pending).toEqual(FORBIDDEN);
  });

  it("a passkey stored while an invalidation lands is taken back out through removePasskey", async () => {
    const h = await makeHarness();
    const context = await unlocked(h);
    const authenticator = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const options = answerOf<{ challenge: string }>(
      await h.auth.handle("auth:passkeyRegisterBegin", { password: PASSWORD }, context),
    );
    const pending = h.auth.handle(
      "auth:passkeyRegisterFinish",
      { ...authenticator.register(options.challenge), label: "Raced" },
      context,
    );
    // addPasskey has stored it in memory and is waiting on its write.
    expect(h.owner.listPasskeys()).toHaveLength(1);
    h.auth.invalidate();

    expect(await pending).toEqual(FORBIDDEN);
    await h.owner.flushed();
    expect(h.removePasskey).toHaveBeenCalledWith(authenticator.credentialId);
    expect(h.owner.listPasskeys()).toEqual([]);
    expect(h.events.some((event) => event.kind === "passkey-added")).toBe(false);
    expect(h.onPasskeyAdded).not.toHaveBeenCalled();
  });
});

describe("passkeys: login", () => {
  async function withPasskey(options: { alg?: -7 | -257 } = {}) {
    const h = await makeHarness();
    const authenticator = softAuthenticator({ ...options, rpId: RP_ID, origin: ORIGIN });
    await register(h, authenticator, await unlocked(h, "setup"));
    h.events.length = 0;
    return { h, authenticator };
  }

  it("passkeyBegin answers get() options listing every credential", async () => {
    const { h, authenticator } = await withPasskey();
    expect(answerOf(await h.auth.handle("auth:passkeyBegin", {}, ctx()))).toEqual({
      challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      rpId: RP_ID,
      allowCredentials: [authenticator.credentialId],
      userVerification: "required",
      timeout: PASSKEY_TIMEOUT_MS,
    });
  });

  it.each([-7, -257] as const)(
    "a verified assertion (alg %d) unlocks, issues tokens, persists the sign count and audits method passkey",
    async (alg) => {
      const { h, authenticator } = await withPasskey({ alg });
      const challenge = await loginChallenge(h);
      const outcome = await h.auth.handle(
        "auth:passkeyFinish",
        authenticator.assert(challenge, { signCount: 7 }),
        ctx(),
      );
      const tokens = answerOf<{ accessToken: string; accessExpiresAt: number }>(outcome);
      expect(outcome.kind === "value" && outcome.effect).toEqual({
        unlock: { until: tokens.accessExpiresAt, familyId: expect.any(String) },
      });
      expect(h.sessions.verifyAccess(DEVICE.id, tokens.accessToken)).toBeDefined();
      expect(h.events).toEqual([
        { kind: "login-succeeded", deviceId: DEVICE.id, source: SOURCE, method: "passkey" },
      ]);

      await h.owner.flushed();
      const reloaded = h.makeOwner();
      await reloaded.load();
      expect(reloaded.listPasskeys()[0]?.signCount).toBe(7);

      // A sign count that did not move past the stored one is refused.
      const next = await loginChallenge(h);
      expect(
        await h.auth.handle(
          "auth:passkeyFinish",
          authenticator.assert(next, { signCount: 7 }),
          ctx(),
        ),
      ).toEqual(FORBIDDEN);
    },
  );

  it("refuses a replayed challenge, counted and audited as a failed passkey login", async () => {
    const { h, authenticator } = await withPasskey();
    const challenge = await loginChallenge(h);
    const answer = authenticator.assert(challenge);
    expect((await h.auth.handle("auth:passkeyFinish", answer, ctx())).kind).toBe("value");
    // Freshly signed (its sign count moved on), but over the spent challenge.
    const again = authenticator.assert(challenge);
    expect(await h.auth.handle("auth:passkeyFinish", again, ctx())).toEqual(FORBIDDEN);
    expect(h.events).toContainEqual({
      kind: "login-failed",
      deviceId: DEVICE.id,
      source: SOURCE,
      method: "passkey",
    });
  });

  it("refuses a wrong origin and a challenge issued to another connection", async () => {
    const { h, authenticator } = await withPasskey();
    const challenge = await loginChallenge(h);
    expect(
      await h.auth.handle(
        "auth:passkeyFinish",
        authenticator.assert(challenge, { origin: "https://evil.example:8443" }),
        ctx(),
      ),
    ).toEqual(FORBIDDEN);

    const other = await loginChallenge(h, ctx(undefined, "c2"));
    expect(await h.auth.handle("auth:passkeyFinish", authenticator.assert(other), ctx())).toEqual(
      FORBIDDEN,
    );
  });

  it("drops a connection's challenges when it closes", async () => {
    const { h, authenticator } = await withPasskey();
    const challenge = await loginChallenge(h);
    h.auth.connectionClosed("c1");
    expect(
      await h.auth.handle("auth:passkeyFinish", authenticator.assert(challenge), ctx()),
    ).toEqual(FORBIDDEN);
  });

  it("a deleted passkey can no longer log in", async () => {
    const { h, authenticator } = await withPasskey();
    const challenge = await loginChallenge(h);
    await h.owner.deletePasskey(authenticator.credentialId);
    expect(
      await h.auth.handle("auth:passkeyFinish", authenticator.assert(challenge), ctx()),
    ).toEqual(FORBIDDEN);
  });

  it("failed passkey logins count toward the lockout, which then refuses a valid one", async () => {
    const { h, authenticator } = await withPasskey();
    const stranger = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    for (let i = 0; i < DEVICE_FAILURES_BEFORE_LOCKOUT; i++) {
      const challenge = await loginChallenge(h);
      expect(await h.auth.handle("auth:passkeyFinish", stranger.assert(challenge), ctx())).toEqual(
        FORBIDDEN,
      );
    }
    const challenge = await loginChallenge(h);
    expect(
      await h.auth.handle("auth:passkeyFinish", authenticator.assert(challenge), ctx()),
    ).toEqual({ kind: "error", code: "rate-limited" });
  });

  it("a login verified across an invalidation is refused", async () => {
    const { h, authenticator } = await withPasskey();
    const challenge = await loginChallenge(h);
    const pending = h.auth.handle("auth:passkeyFinish", authenticator.assert(challenge), ctx());
    h.auth.invalidate();
    expect(await pending).toEqual(FORBIDDEN);
  });
});
