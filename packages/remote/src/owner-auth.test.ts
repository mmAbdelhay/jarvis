import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "./audit.js";
import { fakeClock } from "./clock-double.js";
import { memoryFs } from "./fs-double.js";
import type { RandomBytes } from "./io.js";
import { formatAuditLine } from "./audit.js";
import { createLoginLimits, DEVICE_FAILURES_BEFORE_LOCKOUT } from "./login-limits.js";
import type { AuthContext, DesktopNoticeKind, LoginLimits } from "./owner-auth.js";
import {
  createOwnerAuth,
  isAuthChannel,
  MAX_CONCURRENT_PASSWORD_CHECKS,
  MAX_QUEUED_PASSWORD_CHECKS,
} from "./owner-auth.js";
import { ACCESS_TTL_MS, createSessionStore, REFRESH_RETRY_GRACE_MS } from "./sessions.js";

const PASSWORD = "correct horse battery";
const DEVICE = { id: "d".repeat(32), name: "Phone" };
const SOURCE = "100.64.0.2";

function countingRandom(): RandomBytes {
  let byte = 0;
  return (size) => Buffer.alloc(size, ++byte % 256);
}

type Gate = { release(): void };

function makeHarness(
  options: {
    verify?: (password: string) => Promise<boolean>;
    limits?: LoginLimits;
    passkeys?: number;
    /** Each auth:refresh waits for a gate after the store has rotated. */
    holdRefresh?: Gate[];
  } = {},
) {
  const clock = fakeClock(10_000);
  const fs = memoryFs();
  const sessions = createSessionStore({
    fs,
    path: "/remote/sessions.json",
    random: countingRandom(),
    now: clock.now,
    enforceFileModes: true,
  });
  const verifyPassword = vi.fn(options.verify ?? (async (password) => password === PASSWORD));
  const owner = {
    verifyPassword,
    listPasskeys: () =>
      Array.from({ length: options.passkeys ?? 0 }, (_, index) => ({
        credentialId: `cred${index}`,
        publicKey: "key",
        alg: -7 as const,
        signCount: 0,
        label: "Key",
        createdAt: 0,
      })),
    addPasskey: vi.fn(async () => {}),
    deletePasskey: vi.fn(async () => true),
    updateSignCount: vi.fn(async () => true),
    ownerHandle: vi.fn(async () => "handle"),
  };
  const events: AuditEvent[] = [];
  const log = vi.fn<(line: string) => void>();
  const lockFamily = vi.fn<(familyId: string, reason: string) => void>();
  const notifyDesktop = vi.fn<(kind: DesktopNoticeKind) => void>();
  const held = options.holdRefresh;
  const store =
    held === undefined
      ? sessions
      : {
          ...sessions,
          refresh: async (deviceId: string, token: string) => {
            const result = await sessions.refresh(deviceId, token);
            await new Promise<void>((resolve) => held.push({ release: resolve }));
            return result;
          },
        };
  const auth = createOwnerAuth({
    owner,
    random: countingRandom(),
    now: clock.now,
    sessions: store,
    notifyDesktop,
    audit: { record: (event) => events.push(event) },
    log,
    lockFamily,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
  });
  return { clock, fs, sessions, auth, events, log, lockFamily, notifyDesktop, verifyPassword };
}

function ctx(session?: AuthContext["session"]): AuthContext {
  return { connectionId: "c1", device: DEVICE, source: SOURCE, session };
}

function gatedVerify(): { verify: (password: string) => Promise<boolean>; gates: Gate[] } {
  const gates: Gate[] = [];
  return {
    gates,
    verify: () =>
      new Promise<boolean>((resolve) => {
        gates.push({ release: () => resolve(true) });
      }),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("isAuthChannel", () => {
  it("is true only for the auth:* channel names", () => {
    expect(isAuthChannel("auth:login")).toBe(true);
    expect(isAuthChannel("auth:state")).toBe(false);
    expect(isAuthChannel("projects:list")).toBe(false);
  });
});

describe("createOwnerAuth", () => {
  it("auth:status reports locked, hasPasskeys and no expiry for a locked connection", async () => {
    const h = makeHarness({ passkeys: 1 });
    expect(await h.auth.handle("auth:status", {}, ctx())).toEqual({
      kind: "value",
      value: { locked: true, hasPasskeys: true },
    });
  });

  it("auth:status reports the access expiry of an unlocked connection", async () => {
    const h = makeHarness();
    expect(
      await h.auth.handle("auth:status", {}, ctx({ until: 99_000, familyId: "f".repeat(32) })),
    ).toEqual({
      kind: "value",
      value: { locked: false, hasPasskeys: false, accessExpiresAt: 99_000 },
    });
  });

  it("a right password issues tokens, unlocks until the access expiry and audits login-succeeded", async () => {
    const h = makeHarness();
    const outcome = await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    if (outcome.kind !== "value") throw new Error("expected a value");
    const tokens = outcome.value as {
      accessToken: string;
      refreshToken: string;
      accessExpiresAt: number;
    };
    expect(tokens.accessToken).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.accessExpiresAt).toBe(10_000 + ACCESS_TTL_MS);
    expect(outcome.effect).toEqual({
      unlock: { until: tokens.accessExpiresAt, familyId: expect.stringMatching(/^[0-9a-f]{32}$/) },
    });
    expect(h.events).toEqual([{ kind: "login-succeeded", deviceId: DEVICE.id, source: SOURCE }]);
  });

  it("a wrong password is forbidden, audited login-failed, and neither password appears anywhere", async () => {
    const h = makeHarness();
    const outcome = await h.auth.handle("auth:login", { password: "wrong password!!" }, ctx());
    expect(outcome).toEqual({ kind: "error", code: "forbidden" });
    expect(h.events).toEqual([{ kind: "login-failed", deviceId: DEVICE.id, source: SOURCE }]);
    const everything = JSON.stringify([h.events, h.log.mock.calls]);
    expect(everything).not.toContain("wrong password");
    expect(everything).not.toContain(PASSWORD);
  });

  it("consults the login-limits seam: a refused attempt never verifies and replies rate-limited", async () => {
    const limits: LoginLimits = {
      allow: vi.fn(() => false),
      failed: vi.fn(),
      succeeded: vi.fn(),
      refused: vi.fn(),
    };
    const h = makeHarness({ limits });
    expect(await h.auth.handle("auth:login", { password: PASSWORD }, ctx())).toEqual({
      kind: "error",
      code: "rate-limited",
    });
    expect(h.verifyPassword).not.toHaveBeenCalled();
    expect(limits.allow).toHaveBeenCalledWith(DEVICE.id, SOURCE);
  });

  it("a lockout that starts while a password check runs refuses it rate-limited, uncounted", async () => {
    let allowed = true;
    const limits: LoginLimits = {
      allow: () => allowed,
      failed: vi.fn(),
      succeeded: vi.fn(),
      refused: vi.fn(),
    };
    const { verify, gates } = gatedVerify();
    const h = makeHarness({ limits, verify });
    const pending = h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    await flush();
    allowed = false;
    gates[0]?.release();
    expect(await pending).toEqual({ kind: "error", code: "rate-limited" });
    expect(limits.succeeded).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("a queued password check re-asks the limits when it gets its slot, and never runs scrypt once locked out", async () => {
    let allowed = true;
    const limits: LoginLimits = {
      allow: () => allowed,
      failed: vi.fn(),
      succeeded: vi.fn(),
      refused: vi.fn(),
    };
    const { verify, gates } = gatedVerify();
    const h = makeHarness({ limits, verify });
    const running = Array.from({ length: MAX_CONCURRENT_PASSWORD_CHECKS }, () =>
      h.auth.handle("auth:login", { password: PASSWORD }, ctx()),
    );
    const queued = h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    await flush();
    expect(h.verifyPassword).toHaveBeenCalledTimes(MAX_CONCURRENT_PASSWORD_CHECKS);
    allowed = false;
    gates[0]?.release();
    expect(await queued).toEqual({ kind: "error", code: "rate-limited" });
    expect(h.verifyPassword).toHaveBeenCalledTimes(MAX_CONCURRENT_PASSWORD_CHECKS);
    expect(limits.refused).toHaveBeenCalledWith(DEVICE.id, SOURCE);
    for (const gate of gates) gate.release();
    await Promise.all(running);
  });

  it("a locked-out attempt is reported to the limits as refused", async () => {
    const limits: LoginLimits = {
      allow: () => false,
      failed: vi.fn(),
      succeeded: vi.fn(),
      refused: vi.fn(),
    };
    const h = makeHarness({ limits });
    await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    expect(limits.refused).toHaveBeenCalledExactlyOnceWith(DEVICE.id, SOURCE);
  });

  it("a locked-out device's passkey finish is refused rate-limited", async () => {
    const limits: LoginLimits = {
      allow: () => false,
      failed: vi.fn(),
      succeeded: vi.fn(),
      refused: vi.fn(),
    };
    const h = makeHarness({ limits });
    expect(await h.auth.handle("auth:passkeyFinish", {} as never, ctx())).toEqual({
      kind: "error",
      code: "rate-limited",
    });
  });

  it("with the real limits: 5 wrong passwords block the 6th, and no audit line or log carries a password or token", async () => {
    const clock = fakeClock(10_000);
    const events: AuditEvent[] = [];
    const notifyDesktop = vi.fn();
    const limits = createLoginLimits({
      now: clock.now,
      audit: { record: (event) => events.push(event) },
      notifyDesktop,
    });
    const h = makeHarness({ limits });
    const good = await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    if (good.kind !== "value") throw new Error("expected login");
    const tokens = good.value as { accessToken: string; refreshToken: string };
    const rotated = await h.auth.handle(
      "auth:refresh",
      { refreshToken: tokens.refreshToken },
      ctx(),
    );
    if (rotated.kind !== "value") throw new Error("expected refresh");
    const successor = (rotated.value as { refreshToken: string }).refreshToken;
    await h.auth.handle("auth:refresh", { refreshToken: successor }, ctx());
    await h.auth.handle("auth:refresh", { refreshToken: tokens.refreshToken }, ctx());

    const wrong = "wrong password number";
    for (let i = 0; i < DEVICE_FAILURES_BEFORE_LOCKOUT; i++) {
      expect(await h.auth.handle("auth:login", { password: wrong }, ctx())).toEqual({
        kind: "error",
        code: "forbidden",
      });
    }
    expect(await h.auth.handle("auth:login", { password: PASSWORD }, ctx())).toEqual({
      kind: "error",
      code: "rate-limited",
    });
    expect(h.verifyPassword).toHaveBeenCalledTimes(1 + DEVICE_FAILURES_BEFORE_LOCKOUT);

    const lines = [...h.events, ...events].map((event) => formatAuditLine(0, event)).join("");
    expect(lines).toContain(" login-failed ");
    expect(lines).toContain(" locked-out ");
    expect(lines).toContain(" refresh-reuse ");
    const logged = JSON.stringify(h.log.mock.calls);
    for (const secret of [PASSWORD, wrong, tokens.accessToken, tokens.refreshToken]) {
      expect(lines).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
  });

  it("reports each verified attempt to the login-limits seam", async () => {
    const limits: LoginLimits = {
      allow: () => true,
      failed: vi.fn(),
      succeeded: vi.fn(),
      refused: vi.fn(),
    };
    const h = makeHarness({ limits });
    await h.auth.handle("auth:login", { password: "nope nope nope" }, ctx());
    await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    expect(limits.failed).toHaveBeenCalledWith(DEVICE.id, SOURCE);
    expect(limits.succeeded).toHaveBeenCalledWith(DEVICE.id, SOURCE);
  });

  it("runs at most 2 password checks at once, queues 8, and refuses the rest as rate-limited", async () => {
    const { verify, gates } = gatedVerify();
    const h = makeHarness({ verify });
    const total = MAX_CONCURRENT_PASSWORD_CHECKS + MAX_QUEUED_PASSWORD_CHECKS + 1;
    const outcomes = Array.from({ length: total }, () =>
      h.auth.handle("auth:login", { password: PASSWORD }, ctx()),
    );
    await flush();
    expect(gates).toHaveLength(MAX_CONCURRENT_PASSWORD_CHECKS);
    expect(await outcomes[total - 1]).toEqual({ kind: "error", code: "rate-limited" });

    // Releasing one running check lets exactly one queued check start.
    gates[0]?.release();
    await flush();
    expect(gates).toHaveLength(MAX_CONCURRENT_PASSWORD_CHECKS + 1);

    for (let i = 1; i < total; i++) {
      gates[i]?.release();
      await flush();
    }
    const settled = await Promise.all(outcomes.slice(0, total - 1));
    expect(settled.every((outcome) => outcome.kind === "value")).toBe(true);
    expect(gates).toHaveLength(total - 1);
  });

  it("a login refused because the check queue is full is reported to the limits as capacity", async () => {
    const { verify } = gatedVerify();
    const refused = vi.fn();
    const limits: LoginLimits = { allow: () => true, failed: vi.fn(), succeeded: vi.fn(), refused };
    const h = makeHarness({ verify, limits });
    const total = MAX_CONCURRENT_PASSWORD_CHECKS + MAX_QUEUED_PASSWORD_CHECKS + 1;
    const outcomes = Array.from({ length: total }, () =>
      h.auth.handle("auth:login", { password: PASSWORD }, ctx()),
    );
    expect(await outcomes[total - 1]).toEqual({ kind: "error", code: "rate-limited" });
    expect(refused).toHaveBeenCalledExactlyOnceWith(DEVICE.id, SOURCE, "capacity");
  });

  it("a login whose password check straddles an invalidation is refused and its family revoked", async () => {
    const { verify, gates } = gatedVerify();
    const h = makeHarness({ verify });
    const pending = h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    await flush();
    h.auth.invalidate();
    gates[0]?.release();
    expect(await pending).toEqual({ kind: "error", code: "forbidden" });
    const file = await h.fs.readFile("/remote/sessions.json");
    expect(JSON.parse(file)).toEqual({ version: 1, sessions: [] });
  });

  it("auth:refresh rotates and unlocks; a replayed token revokes the family and locks its connections", async () => {
    const h = makeHarness();
    const login = await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    if (login.kind !== "value") throw new Error("expected login");
    const first = login.value as { refreshToken: string };

    const refreshed = await h.auth.handle(
      "auth:refresh",
      { refreshToken: first.refreshToken },
      ctx(),
    );
    if (refreshed.kind !== "value") throw new Error("expected refresh");
    expect(refreshed.effect).toMatchObject({ unlock: { until: expect.any(Number) } });
    const second = (refreshed.value as { refreshToken: string }).refreshToken;
    expect(second).not.toBe(first.refreshToken);
    // The successor is used, so the first token is reuse, not a retry.
    await h.auth.handle("auth:refresh", { refreshToken: second }, ctx());

    const replayed = await h.auth.handle(
      "auth:refresh",
      { refreshToken: first.refreshToken },
      ctx(),
    );
    expect(replayed).toEqual({ kind: "error", code: "forbidden" });
    const familyId = (login.effect as { unlock: { familyId: string } }).unlock.familyId;
    expect(h.lockFamily).toHaveBeenCalledWith(familyId, "signed-out");
    expect(h.events).toContainEqual({ kind: "refresh-reuse", deviceId: DEVICE.id, source: SOURCE });
    expect(h.notifyDesktop).toHaveBeenCalledExactlyOnceWith("refresh-reuse");
  });

  it("a refresh racing a logout of its family is forbidden instead of unlocking with it", async () => {
    const holdRefresh: Gate[] = [];
    const h = makeHarness({ holdRefresh });
    const login = await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    if (login.kind !== "value" || login.effect === undefined || !("unlock" in login.effect)) {
      throw new Error("expected login");
    }
    const { refreshToken } = login.value as { refreshToken: string };
    const pending = h.auth.handle("auth:refresh", { refreshToken }, ctx());
    await flush();
    expect(holdRefresh).toHaveLength(1);
    await h.auth.handle("auth:logout", {}, ctx(login.effect.unlock));
    holdRefresh[0]?.release();
    expect(await pending).toEqual({ kind: "error", code: "forbidden" });
  });

  it("a refresh straddling an invalidation is forbidden and its family revoked", async () => {
    const holdRefresh: Gate[] = [];
    const h = makeHarness({ holdRefresh });
    const login = await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    if (login.kind !== "value") throw new Error("expected login");
    const { refreshToken } = login.value as { refreshToken: string };
    const pending = h.auth.handle("auth:refresh", { refreshToken }, ctx());
    await flush();
    h.auth.invalidate();
    holdRefresh[0]?.release();
    expect(await pending).toEqual({ kind: "error", code: "forbidden" });
    const file = await h.fs.readFile("/remote/sessions.json");
    expect(JSON.parse(file)).toEqual({ version: 1, sessions: [] });
  });

  it("two concurrent refreshes with the same token leave only one live pair", async () => {
    const h = makeHarness();
    const login = await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    if (login.kind !== "value") throw new Error("expected login");
    const { refreshToken } = login.value as { refreshToken: string };
    const [first, second] = await Promise.all([
      h.auth.handle("auth:refresh", { refreshToken }, ctx()),
      h.auth.handle("auth:refresh", { refreshToken }, ctx()),
    ]);
    if (first?.kind !== "value" || second?.kind !== "value") throw new Error("expected refreshes");
    const firstTokens = first.value as { accessToken: string; refreshToken: string };
    // The second is a retry: the first pair was superseded.
    expect(h.sessions.verifyAccess(DEVICE.id, firstTokens.accessToken)).toBeUndefined();
    expect(
      await h.auth.handle("auth:refresh", { refreshToken: firstTokens.refreshToken }, ctx()),
    ).toEqual({ kind: "error", code: "forbidden" });
    expect(h.events).toContainEqual({ kind: "refresh-reuse", deviceId: DEVICE.id, source: SOURCE });
  });

  it("a retry after a lost refresh reply re-rotates without an alarm and audits refresh-retry", async () => {
    const h = makeHarness();
    const login = await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    if (login.kind !== "value") throw new Error("expected login");
    const { refreshToken } = login.value as { refreshToken: string };
    // The laptop rotates; the reply never reaches the phone.
    const lost = await h.auth.handle("auth:refresh", { refreshToken }, ctx());
    if (lost.kind !== "value") throw new Error("expected refresh");
    h.clock.advance(REFRESH_RETRY_GRACE_MS);

    const retried = await h.auth.handle("auth:refresh", { refreshToken }, ctx());
    if (retried.kind !== "value") throw new Error("expected a retry to succeed");
    expect(retried.effect).toMatchObject({ unlock: { until: expect.any(Number) } });
    expect(h.events).toContainEqual({ kind: "refresh-retry", deviceId: DEVICE.id, source: SOURCE });
    expect(h.events.some((event) => event.kind === "refresh-reuse")).toBe(false);
    expect(h.notifyDesktop).not.toHaveBeenCalled();
    expect(h.lockFamily).not.toHaveBeenCalled();
  });

  it("a retry after a failed rotation write lands in the grace path", async () => {
    const h = makeHarness();
    const login = await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    if (login.kind !== "value") throw new Error("expected login");
    const { refreshToken } = login.value as { refreshToken: string };
    const writeFile = h.fs.writeFile.bind(h.fs);
    h.fs.writeFile = async () => {
      throw new Error("disk full");
    };
    expect(await h.auth.handle("auth:refresh", { refreshToken }, ctx())).toEqual({
      kind: "error",
      code: "internal",
    });
    h.fs.writeFile = writeFile;

    const retried = await h.auth.handle("auth:refresh", { refreshToken }, ctx());
    expect(retried.kind).toBe("value");
    expect(h.events).toContainEqual({ kind: "refresh-retry", deviceId: DEVICE.id, source: SOURCE });
    expect(h.notifyDesktop).not.toHaveBeenCalled();
  });

  it("a retry past the grace window is refused quietly: family revoked, refresh-stale, no alarm", async () => {
    const h = makeHarness();
    const login = await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    if (login.kind !== "value") throw new Error("expected login");
    const { refreshToken } = login.value as { refreshToken: string };
    await h.auth.handle("auth:refresh", { refreshToken }, ctx());
    h.clock.advance(REFRESH_RETRY_GRACE_MS + 1);

    expect(await h.auth.handle("auth:refresh", { refreshToken }, ctx())).toEqual({
      kind: "error",
      code: "forbidden",
    });
    const familyId = (login.effect as { unlock: { familyId: string } }).unlock.familyId;
    expect(h.lockFamily).toHaveBeenCalledWith(familyId, "signed-out");
    expect(h.events).toContainEqual({ kind: "refresh-stale", deviceId: DEVICE.id, source: SOURCE });
    expect(h.events.some((event) => event.kind === "refresh-reuse")).toBe(false);
    expect(h.notifyDesktop).not.toHaveBeenCalled();
  });

  it("an unknown refresh token is forbidden", async () => {
    const h = makeHarness();
    expect(await h.auth.handle("auth:refresh", { refreshToken: "a".repeat(64) }, ctx())).toEqual({
      kind: "error",
      code: "forbidden",
    });
  });

  it("auth:resume with a live access token unlocks until its expiry and returns the status", async () => {
    const h = makeHarness();
    const login = await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    if (login.kind !== "value") throw new Error("expected login");
    const { accessToken, accessExpiresAt } = login.value as {
      accessToken: string;
      accessExpiresAt: number;
    };
    const resumed = await h.auth.handle("auth:resume", { accessToken }, ctx());
    expect(resumed).toEqual({
      kind: "value",
      value: { locked: false, hasPasskeys: false, accessExpiresAt },
      effect: { unlock: { until: accessExpiresAt, familyId: expect.any(String) } },
    });

    h.clock.advance(ACCESS_TTL_MS);
    expect(await h.auth.handle("auth:resume", { accessToken }, ctx())).toEqual({
      kind: "error",
      code: "forbidden",
    });
  });

  it("auth:logout revokes the connection's family, locks it and returns null", async () => {
    const h = makeHarness();
    const login = await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    if (login.kind !== "value" || login.effect === undefined || !("unlock" in login.effect)) {
      throw new Error("expected login");
    }
    const session = login.effect.unlock;
    const { refreshToken } = login.value as { refreshToken: string };
    expect(await h.auth.handle("auth:logout", {}, ctx(session))).toEqual({
      kind: "value",
      value: null,
      effect: { lock: "logout" },
    });
    expect(h.lockFamily).toHaveBeenCalledWith(session.familyId, "logout");
    expect(await h.auth.handle("auth:refresh", { refreshToken }, ctx())).toEqual({
      kind: "error",
      code: "forbidden",
    });
  });

  it("auth:logout on a locked connection is a harmless null", async () => {
    const h = makeHarness();
    expect(await h.auth.handle("auth:logout", {}, ctx())).toEqual({ kind: "value", value: null });
    expect(h.lockFamily).not.toHaveBeenCalled();
  });

  it("passkey channels answer unsupported until they are wired", async () => {
    const h = makeHarness();
    expect(await h.auth.handle("auth:passkeyBegin", {}, ctx())).toEqual({
      kind: "error",
      code: "unsupported",
    });
  });

  it("sessionAtHello is always locked", () => {
    const h = makeHarness();
    expect(h.auth.sessionAtHello(DEVICE)).toBeUndefined();
  });
});

describe("createOwnerAuth: password join", () => {
  const JOIN_SOURCE = "100.64.0.9";
  const NEW_DEVICE = "e".repeat(32);

  function spyLoginLimits() {
    return {
      allow: vi.fn(() => true),
      failed: vi.fn(),
      succeeded: vi.fn(),
      refused: vi.fn(),
    };
  }

  /** Every verify waits for its own gate; each release answers false (a wrong password). */
  function gatedWrong() {
    const gates: Array<() => void> = [];
    const verify = (_password: string) =>
      new Promise<boolean>((resolve) => {
        gates.push(() => resolve(false));
      });
    return { gates, verify };
  }

  async function failJoins(auth: ReturnType<typeof makeHarness>["auth"], count: number) {
    for (let attempt = 0; attempt < count; attempt += 1) {
      expect(await auth.checkJoinPassword("wrong", JOIN_SOURCE)).toBe("refused");
    }
  }

  it("answers ok for the right password and refused for a wrong one", async () => {
    const h = makeHarness();
    expect(await h.auth.checkJoinPassword(PASSWORD, JOIN_SOURCE)).toBe("ok");
    expect(await h.auth.checkJoinPassword("wrong", JOIN_SOURCE)).toBe("refused");
    expect(h.events).toEqual([{ kind: "join-failed", source: JOIN_SOURCE }]);
  });

  it("5 wrong joins never touch the login limiter", async () => {
    const limits = spyLoginLimits();
    const h = makeHarness({ limits });

    await failJoins(h.auth, 5);

    expect(limits.allow).not.toHaveBeenCalled();
    expect(limits.failed).not.toHaveBeenCalled();
    expect(limits.succeeded).not.toHaveBeenCalled();
    expect(limits.refused).not.toHaveBeenCalled();
  });

  it("5 wrong joins leave a paired device's real login limits untouched", async () => {
    const clock = fakeClock(10_000);
    const limits = createLoginLimits({
      now: clock.now,
      audit: { record: () => {} },
      notifyDesktop: () => {},
      deviceName: () => undefined,
      log: () => {},
    });
    const h = makeHarness({ limits });

    await failJoins(h.auth, 5);

    expect(limits.allow(DEVICE.id, SOURCE)).toBe(true);
    const answer = await h.auth.handle("auth:login", { password: PASSWORD }, ctx());
    expect(answer.kind).toBe("value");
  });

  it("locks out after 5 failures: the right password is refused unchecked until the 60 s pass", async () => {
    const h = makeHarness();
    await failJoins(h.auth, 5);
    h.verifyPassword.mockClear();

    expect(await h.auth.checkJoinPassword(PASSWORD, JOIN_SOURCE)).toBe("refused");
    expect(h.verifyPassword).not.toHaveBeenCalled();

    h.clock.advance(60_000);
    expect(await h.auth.checkJoinPassword(PASSWORD, JOIN_SOURCE)).toBe("ok");
    expect(h.verifyPassword).toHaveBeenCalledTimes(1);
  });

  it("a lockout refusal is not counted as another failure", async () => {
    const h = makeHarness();
    await failJoins(h.auth, 5);
    await failJoins(h.auth, 3);

    expect(h.events.filter((event) => event.kind === "join-failed")).toHaveLength(5);
    // Still the first 60 s lockout, not a doubled one.
    h.clock.advance(60_000);
    expect(await h.auth.checkJoinPassword(PASSWORD, JOIN_SOURCE)).toBe("ok");
  });

  it("8 concurrent wrong joins run only the allowed checks, in the order the slots grant", async () => {
    const { gates, verify } = gatedWrong();
    const h = makeHarness({ verify });
    const answers = Array.from({ length: 8 }, (_, index) =>
      h.auth.checkJoinPassword(`wrong-${index}`, JOIN_SOURCE),
    );
    await flush();
    expect(h.verifyPassword).toHaveBeenCalledTimes(MAX_CONCURRENT_PASSWORD_CHECKS);

    while (gates.length > 0) {
      gates.shift()?.();
      await flush();
    }

    expect(await Promise.all(answers)).toEqual(Array(8).fill("refused"));
    // The fifth failure's lockout lands before its slot passes on, so only
    // the one check already running beside it finishes after it.
    const allowed = DEVICE_FAILURES_BEFORE_LOCKOUT + MAX_CONCURRENT_PASSWORD_CHECKS - 1;
    expect(h.verifyPassword.mock.calls.map(([password]) => password)).toEqual(
      Array.from({ length: allowed }, (_, index) => `wrong-${index}`),
    );
    expect(h.events.filter((event) => event.kind === "join-failed")).toHaveLength(allowed);
  });

  it("asks the join limiter once per attempt: 2 refused attempts count as 2 refusals", async () => {
    const h = makeHarness();
    await failJoins(h.auth, 5);
    await failJoins(h.auth, 2);

    h.clock.advance(60_000);
    await h.auth.checkJoinPassword(PASSWORD, JOIN_SOURCE); // the first call after the window flushes

    expect(h.events.filter((event) => event.kind === "join-refused")).toEqual([
      { kind: "join-refused", source: JOIN_SOURCE, count: 2 },
    ]);
  });

  it("a full queue refuses a join without a check or a counted failure", async () => {
    const { gates, verify } = gatedWrong();
    const h = makeHarness({ verify });
    const running = Array.from(
      { length: MAX_CONCURRENT_PASSWORD_CHECKS + MAX_QUEUED_PASSWORD_CHECKS },
      () => h.auth.checkJoinPassword("wrong", JOIN_SOURCE),
    );
    await flush();

    expect(await h.auth.checkJoinPassword("wrong", JOIN_SOURCE)).toBe("refused");
    expect(h.events).toEqual([]);

    while (gates.length > 0) {
      gates.shift()?.();
      await flush();
    }
    await Promise.all(running);
  });

  it("a check that throws refuses, counts no failure and logs no password", async () => {
    const h = makeHarness({
      verify: async (password) => {
        throw new Error(password);
      },
    });

    expect(await h.auth.checkJoinPassword(PASSWORD, JOIN_SOURCE)).toBe("refused");

    expect(h.events).toEqual([]);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(PASSWORD);
  });

  it("an invalidation during the check refuses it, even with the right password", async () => {
    const { verify, gates } = gatedVerify();
    const h = makeHarness({ verify });

    const answer = h.auth.checkJoinPassword(PASSWORD, JOIN_SOURCE);
    await flush();
    h.auth.invalidate();
    gates[0]?.release();

    expect(await answer).toBe("refused");
    expect(h.events).toEqual([]);
  });

  it("never records or logs the password", async () => {
    const h = makeHarness();
    await h.auth.checkJoinPassword(PASSWORD, JOIN_SOURCE);
    await h.auth.checkJoinPassword("wrong-secret-guess", JOIN_SOURCE);

    const lines = h.events.map((event) => formatAuditLine(0, event)).join("");
    for (const text of [lines, JSON.stringify(h.log.mock.calls)]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain("wrong-secret-guess");
    }
  });

  it("issueForJoin answers live tokens for the device, without the login limiter's succeeded", async () => {
    const limits = spyLoginLimits();
    const h = makeHarness({ limits });
    const startedAt = h.auth.joinGeneration();

    const tokens = await h.auth.issueForJoin(NEW_DEVICE, JOIN_SOURCE, startedAt);

    expect(h.sessions.verifyAccess(NEW_DEVICE, tokens.accessToken)).toBeDefined();
    expect(tokens.refreshToken).toEqual(expect.any(String));
    expect(tokens.accessExpiresAt).toBe(10_000 + ACCESS_TTL_MS);
    expect(limits.succeeded).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("issueForJoin resets the join limiter", async () => {
    const h = makeHarness();
    await failJoins(h.auth, 4);

    await h.auth.issueForJoin(NEW_DEVICE, JOIN_SOURCE, h.auth.joinGeneration());

    await failJoins(h.auth, 4);
    expect(await h.auth.checkJoinPassword(PASSWORD, JOIN_SOURCE)).toBe("ok");
  });

  it("an invalidation after the check refuses the issue and issues nothing live", async () => {
    const h = makeHarness();
    const revokeFamily = vi.spyOn(h.sessions, "revokeFamily");
    const startedAt = h.auth.joinGeneration();
    expect(await h.auth.checkJoinPassword(PASSWORD, JOIN_SOURCE)).toBe("ok");

    h.auth.invalidate();

    await expect(h.auth.issueForJoin(NEW_DEVICE, JOIN_SOURCE, startedAt)).rejects.toThrow();
    expect(revokeFamily).toHaveBeenCalledTimes(1);
  });

  it("an invalidation during the issue refuses it and revokes the fresh family", async () => {
    const h = makeHarness();
    const revokeFamily = vi.spyOn(h.sessions, "revokeFamily");

    const issuing = h.auth.issueForJoin(NEW_DEVICE, JOIN_SOURCE, h.auth.joinGeneration());
    h.auth.invalidate();

    await expect(issuing).rejects.toThrow();
    expect(revokeFamily).toHaveBeenCalledTimes(1);
  });

  it("a family revoked during the issue refuses it", async () => {
    const h = makeHarness();

    const issuing = h.auth.issueForJoin(NEW_DEVICE, JOIN_SOURCE, h.auth.joinGeneration());
    void h.sessions.revokeDevice(NEW_DEVICE);

    await expect(issuing).rejects.toThrow();
  });

  it("a failed issue rejects", async () => {
    const h = makeHarness();
    vi.spyOn(h.sessions, "issue").mockRejectedValueOnce(new Error("disk full"));

    await expect(
      h.auth.issueForJoin(NEW_DEVICE, JOIN_SOURCE, h.auth.joinGeneration()),
    ).rejects.toThrow();
  });
});
