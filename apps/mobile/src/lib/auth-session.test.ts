import { AUTH_STATE_CHANNEL } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { REFRESH_TOKEN_KEY, createAuthSession } from "./auth-session";
import type { DeviceAuth } from "./auth-session";
import { createFakeClock } from "./clock";
import { createWebDeviceAuth } from "./web-device-auth";
import type { ClientState, RpcResult } from "./rpc-client";
import type { SecureStore } from "./secure-store";

const MIN = 60_000;
const ACCESS_TTL = 15 * MIN;
const IDLE = 15 * MIN;

let counter = 0;
function token(): string {
  counter += 1;
  return counter.toString(16).padStart(64, "0");
}

type Call = { channel: string; args: unknown[] };

/** A scripted stand-in for the RpcClient: records calls and answers each
 *  channel from a queue of replies (or a default). */
function createRpcDouble(clock: ReturnType<typeof createFakeClock>) {
  let state: ClientState = "locked";
  const calls: Call[] = [];
  const replies = new Map<string, Array<RpcResult | Promise<RpcResult>>>();
  const stateHandlers = new Set<(s: ClientState, d: object) => void>();
  const pushHandlers = new Map<string, Set<(p: unknown, d: number | undefined) => void>>();
  const events: string[] = [];

  function tokensFor(): RpcResult {
    return {
      ok: true,
      value: {
        accessToken: token(),
        refreshToken: token(),
        accessExpiresAt: clock.now() + ACCESS_TTL,
      },
    };
  }

  function setState(next: ClientState): void {
    state = next;
    for (const handler of [...stateHandlers]) handler(next, {});
  }

  const rpc = {
    call(channel: string, args: unknown[]): Promise<RpcResult> {
      calls.push({ channel, args });
      events.push(`call ${channel}`);
      const queued = replies.get(channel)?.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (channel === "auth:login" || channel === "auth:refresh") {
        return Promise.resolve(tokensFor());
      }
      if (channel === "auth:resume") {
        return Promise.resolve({ ok: true, value: { locked: false, hasPasskeys: false } });
      }
      return Promise.resolve({ ok: true, value: null });
    },
    onState(handler: (s: ClientState, d: object) => void) {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },
    onPush(channel: string, handler: (p: unknown, d: number | undefined) => void) {
      let set = pushHandlers.get(channel);
      if (set === undefined) {
        set = new Set();
        pushHandlers.set(channel, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    state: () => state,
    unlock() {
      events.push("unlock");
      if (state === "locked") setState("open");
    },
    lock() {
      events.push("lock");
      if (state === "open") setState("locked");
    },
  };

  return {
    rpc,
    calls,
    events,
    setState,
    reply(channel: string, result: RpcResult | Promise<RpcResult>) {
      const list = replies.get(channel) ?? [];
      list.push(result);
      replies.set(channel, list);
    },
    push(channel: string, payload: unknown) {
      for (const handler of pushHandlers.get(channel) ?? []) handler(payload, undefined);
    },
    tokensFor,
  };
}

/** Records every write so a test can assert what did (and didn't) reach it. */
function createStoreDouble(events: string[]) {
  const values = new Map<string, string>();
  const writes: Array<{ key: string; value: string }> = [];
  let reads = 0;
  let failNextSet = false;
  const store: SecureStore = {
    async get(key) {
      reads += 1;
      return values.get(key);
    },
    async set(key, value) {
      writes.push({ key, value });
      if (failNextSet) {
        failNextSet = false;
        throw new Error("no passcode");
      }
      events.push("store.set");
      values.set(key, value);
    },
    async delete(key) {
      events.push("store.delete");
      values.delete(key);
    },
  };
  return {
    store,
    values,
    writes,
    reads: () => reads,
    failNextSet: () => {
      failNextSet = true;
    },
  };
}

/** The device-owner check: passcode presence and the prompt's answer. */
function createDeviceAuthDouble(options: { passcode?: boolean }) {
  const state = { passcode: options.passcode ?? true, pass: true, prompts: 0 };
  const auth: DeviceAuth = {
    hasPasscode: async () => state.passcode,
    authenticate: async () => {
      state.prompts += 1;
      return state.pass;
    },
  };
  return { auth, state };
}

/** The non-secret "a refresh token is stored" pref (prefs.ts). */
function createStoredFlagDouble() {
  const state = { stored: false, writes: [] as boolean[], reads: 0 };
  return {
    state,
    flag: {
      read: async () => {
        state.reads += 1;
        return state.stored;
      },
      write: async (stored: boolean) => {
        state.writes.push(stored);
        state.stored = stored;
      },
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup(
  options: { passcode?: boolean; deviceAuth?: DeviceAuth; storedUnlockAtLaunchOnly?: boolean } = {},
) {
  const clock = createFakeClock();
  const double = createRpcDouble(clock);
  const store = createStoreDouble(double.events);
  const device = createDeviceAuthDouble(options);
  const flag = createStoredFlagDouble();
  const logs: string[] = [];
  const session = createAuthSession({
    rpc: double.rpc,
    clock,
    refreshStore: store.store,
    refreshStoredFlag: flag.flag,
    deviceAuth: options.deviceAuth ?? device.auth,
    storedUnlockAtLaunchOnly: options.storedUnlockAtLaunchOnly,
    idleMs: IDLE,
    log: (line) => logs.push(line),
  });
  /** A refresh token already on the phone from an earlier launch. */
  function seed(value: string): void {
    store.values.set(REFRESH_TOKEN_KEY, value);
    flag.state.stored = true;
  }
  return { clock, double, store, session, logs, device, flag, seed };
}

function tokenArg(call: Call | undefined, field: string): string | undefined {
  return (call?.args[0] as Record<string, string> | undefined)?.[field];
}

describe("auth-session: password login", () => {
  it("logs in, stores the refresh token before unlocking, and never persists the access token", async () => {
    const { double, store, session } = setup();
    const outcome = await session.unlockWithPassword("hunter2");
    expect(outcome).toBe("unlocked");
    expect(double.calls[0]).toEqual({ channel: "auth:login", args: [{ password: "hunter2" }] });
    expect(double.rpc.state()).toBe("open");
    expect(double.events.indexOf("store.set")).toBeLessThan(double.events.indexOf("unlock"));
    expect([...store.values.keys()]).toEqual([REFRESH_TOKEN_KEY]);
  });

  it.each([
    ["forbidden", "wrong-password"],
    ["rate-limited", "rate-limited"],
    ["internal", "failed"],
  ] as const)("maps err %s to %s", async (code, expected) => {
    const { double, session } = setup();
    double.reply("auth:login", {
      ok: false,
      error: { kind: "remote", code, text: "x", language: "en" },
    });
    expect(await session.unlockWithPassword("bad")).toBe(expected);
    expect(double.rpc.state()).toBe("locked");
  });

  it("maps a transport failure to offline", async () => {
    const { double, session } = setup();
    double.reply("auth:login", { ok: false, error: { kind: "offline" } });
    expect(await session.unlockWithPassword("pw")).toBe("offline");
  });

  it("with no passcode on the phone, stores no refresh token and says so", async () => {
    const { store, session } = setup({ passcode: false });
    store.values.set(REFRESH_TOKEN_KEY, "stale");
    expect(await session.unlockWithPassword("pw")).toBe("unlocked");
    expect(store.writes).toEqual([]);
    expect(store.values.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(session.get().biometricUnavailable).toBe(true);
  });

  it("a failed refresh-token write deletes whatever stale token was stored", async () => {
    const { store, session, double } = setup();
    store.values.set(REFRESH_TOKEN_KEY, "stale");
    store.failNextSet();
    expect(await session.unlockWithPassword("pw")).toBe("unlocked");
    expect(store.values.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(double.rpc.state()).toBe("open");
  });
});

describe("auth-session: scheduled refresh", () => {
  it("refreshes at 80% of the access lifetime with the latest refresh token", async () => {
    const { clock, double, store, session } = setup();
    await session.unlockWithPassword("pw");
    const firstRefresh = store.values.get(REFRESH_TOKEN_KEY);
    clock.advance(ACCESS_TTL * 0.8 - 1);
    await flush();
    expect(double.calls.filter((c) => c.channel === "auth:refresh")).toEqual([]);
    session.touch();
    clock.advance(1);
    await flush();
    const refreshes = double.calls.filter((c) => c.channel === "auth:refresh");
    expect(refreshes).toHaveLength(1);
    expect(tokenArg(refreshes[0], "refreshToken")).toBe(firstRefresh);
    // Rotated: the new refresh token replaced the old one on disk.
    expect(store.values.get(REFRESH_TOKEN_KEY)).not.toBe(firstRefresh);
  });

  it("a refused scheduled refresh deletes the stored token and locks", async () => {
    const { clock, double, store, session } = setup();
    await session.unlockWithPassword("pw");
    double.reply("auth:refresh", {
      ok: false,
      error: { kind: "remote", code: "forbidden", text: "x", language: "en" },
    });
    session.touch();
    clock.advance(ACCESS_TTL * 0.8);
    await flush();
    expect(store.values.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(double.rpc.state()).toBe("locked");
    expect(session.get().lockedLocally).toBe(true);
  });

  it("serializes refreshes: two unlocks at once send one auth:refresh", async () => {
    const { double, session, seed } = setup();
    seed(token());
    const [a, b] = await Promise.all([
      session.unlockWithStoredRefresh(),
      session.unlockWithStoredRefresh(),
    ]);
    expect([a, b]).toEqual(["unlocked", "unlocked"]);
    expect(double.calls.filter((c) => c.channel === "auth:refresh")).toHaveLength(1);
  });
});

describe("auth-session: stored refresh (biometric) unlock", () => {
  it("unlocks with the stored token and stores the rotated one", async () => {
    const { double, store, session, seed } = setup();
    const stored = token();
    seed(stored);
    expect(await session.unlockWithStoredRefresh()).toBe("unlocked");
    expect(tokenArg(double.calls[0], "refreshToken")).toBe(stored);
    expect(store.values.get(REFRESH_TOKEN_KEY)).not.toBe(stored);
    expect(double.rpc.state()).toBe("open");
  });

  it("answers no-stored-token when nothing is stored", async () => {
    const { double, session } = setup();
    expect(await session.unlockWithStoredRefresh()).toBe("no-stored-token");
    expect(double.calls).toEqual([]);
  });

  it("a failed device-owner check never reads the stored token", async () => {
    const { store, session, device, double, seed } = setup();
    seed(token());
    device.state.pass = false;
    expect(await session.unlockWithStoredRefresh()).toBe("cancelled");
    expect(device.state.prompts).toBe(1);
    expect(store.reads()).toBe(0);
    expect(double.calls).toEqual([]);
  });

  it("with no passcode, neither prompts nor reads: the password is needed", async () => {
    const { store, session, device, seed } = setup({ passcode: false });
    seed(token());
    expect(await session.unlockWithStoredRefresh()).toBe("no-stored-token");
    expect(device.state.prompts).toBe(0);
    expect(store.reads()).toBe(0);
    expect(session.get().biometricUnavailable).toBe(true);
  });

  it("a refused (reused/invalid) token is deleted and the password is required", async () => {
    const { double, store, session, seed } = setup();
    seed(token());
    double.reply("auth:refresh", {
      ok: false,
      error: { kind: "remote", code: "forbidden", text: "x", language: "en" },
    });
    expect(await session.unlockWithStoredRefresh()).toBe("password-required");
    expect(store.values.has(REFRESH_TOKEN_KEY)).toBe(false);
  });
});

describe("auth-session: idle lock", () => {
  it("clears the access token after idleMs with no interaction", async () => {
    const { clock, double, session } = setup();
    await session.unlockWithPassword("pw");
    clock.advance(IDLE);
    await flush();
    expect(double.events).toContain("lock");
    expect(double.rpc.state()).toBe("locked");
    expect(session.get()).toMatchObject({ lockedLocally: true, lockCause: "idle" });
    // Both in-memory tokens are gone: a reconnect's locked welcome is
    // neither resumed nor refreshed.
    const before = double.calls.length;
    double.setState("reconnecting");
    double.setState("locked");
    await flush();
    expect(double.calls.slice(before)).toEqual([]);
  });

  it("a refresh reply landing after the idle lock stores the rotated token but stays locked", async () => {
    const { clock, double, store, session } = setup();
    await session.unlockWithPassword("pw");
    let answer: (result: RpcResult) => void = () => {};
    double.reply("auth:refresh", new Promise<RpcResult>((resolve) => (answer = resolve)));
    clock.advance(ACCESS_TTL * 0.8); // the refresh goes out and waits
    clock.advance(IDLE); // the idle lock fires meanwhile
    expect(double.rpc.state()).toBe("locked");
    const rotated = double.tokensFor();
    answer(rotated);
    await flush();
    expect(double.rpc.state()).toBe("locked");
    expect(store.values.get(REFRESH_TOKEN_KEY)).toBe(
      (rotated as { value: { refreshToken: string } }).value.refreshToken,
    );
  });

  it("interaction postpones the idle lock", async () => {
    const { clock, double, session } = setup();
    await session.unlockWithPassword("pw");
    clock.advance(IDLE - 1000);
    session.touch();
    clock.advance(IDLE - 1000);
    await flush();
    expect(double.rpc.state()).toBe("open");
    clock.advance(1000);
    await flush();
    expect(double.rpc.state()).toBe("locked");
  });

  it("returning to the foreground after idleMs in the background locks", async () => {
    const { clock, double, session } = setup();
    await session.unlockWithPassword("pw");
    // Timers don't run while suspended: move time without firing them.
    session.setAppActive(false);
    (clock as unknown as { now: () => number }).now = () => IDLE + 1;
    session.setAppActive(true);
    await flush();
    expect(double.rpc.state()).toBe("locked");
    expect(session.get().lockCause).toBe("idle");
  });

  it("setIdleMs changes the window", async () => {
    const { clock, double, session } = setup();
    await session.unlockWithPassword("pw");
    session.setIdleMs(5 * MIN);
    clock.advance(5 * MIN);
    await flush();
    expect(double.rpc.state()).toBe("locked");
  });
});

describe("auth-session: reconnect and laptop locks", () => {
  it("resumes a reconnect's locked welcome while the access token is valid", async () => {
    const { double, session } = setup();
    await session.unlockWithPassword("pw");
    double.setState("reconnecting");
    double.setState("locked");
    await flush();
    const resume = double.calls.find((c) => c.channel === "auth:resume");
    expect(resume).toBeDefined();
    expect(double.rpc.state()).toBe("open");
  });

  it("an expired lock push refreshes with the in-memory token instead of resuming", async () => {
    const { double, session } = setup();
    await session.unlockWithPassword("pw");
    double.push(AUTH_STATE_CHANNEL, { locked: true, reason: "expired" });
    double.setState("locked");
    await flush();
    const channels = double.calls.map((c) => c.channel);
    expect(channels).not.toContain("auth:resume");
    expect(channels).toContain("auth:refresh");
    expect(double.rpc.state()).toBe("open");
  });

  it("a signed-out push drops every token, deletes the stored one, and waits for the owner", async () => {
    const { double, store, session } = setup();
    await session.unlockWithPassword("pw");
    double.push(AUTH_STATE_CHANNEL, { locked: true, reason: "signed-out" });
    double.setState("locked");
    await flush();
    expect(double.calls.map((c) => c.channel)).toEqual(["auth:login"]);
    expect(store.values.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(session.get().lockCause).toBe("signed-out");
  });
});

describe("auth-session: logout and forget", () => {
  it("logout sends auth:logout, deletes the stored token and locks", async () => {
    const { double, store, session } = setup();
    await session.unlockWithPassword("pw");
    await session.logout();
    expect(double.calls.map((c) => c.channel)).toContain("auth:logout");
    expect(store.values.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(double.rpc.state()).toBe("locked");
    expect(session.get()).toMatchObject({ lockedLocally: true, lockCause: "logout" });
  });

  it("forget (unpair) deletes the stored token without any request", async () => {
    const { double, store, session } = setup();
    store.values.set(REFRESH_TOKEN_KEY, token());
    await session.forget();
    expect(store.values.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(double.calls).toEqual([]);
  });
});

describe("auth-session: secrets", () => {
  it("the access token never reaches the store double or a log line", async () => {
    const { clock, double, store, session, logs } = setup();
    const accessTokens: string[] = [];
    const secrets: string[] = [];
    const original = double.rpc.call;
    double.rpc.call = async (channel, args) => {
      const result = await original(channel, args);
      if (result.ok && typeof result.value === "object" && result.value !== null) {
        const value = result.value as Record<string, unknown>;
        if (typeof value.accessToken === "string") accessTokens.push(value.accessToken);
        if (typeof value.refreshToken === "string") secrets.push(value.refreshToken);
      }
      return result;
    };
    await session.unlockWithPassword("correct horse");
    session.touch();
    clock.advance(ACCESS_TTL * 0.8);
    await flush();
    double.setState("reconnecting");
    double.setState("locked");
    await flush();
    await session.logout();
    await session.unlockWithPassword("correct horse");
    clock.advance(IDLE);
    await flush();

    expect(accessTokens.length).toBeGreaterThanOrEqual(3);
    const written = store.writes.map((w) => w.value).join("\n");
    for (const access of accessTokens) {
      expect(written).not.toContain(access);
    }
    const logged = logs.join("\n");
    for (const secret of [...accessTokens, ...secrets, "correct horse"]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("auth-session: fix round 1", () => {
  it("a resume reply landing after the idle lock does not reopen the connection", async () => {
    const { clock, double, session } = setup();
    await session.unlockWithPassword("pw");
    let answer: (result: RpcResult) => void = () => {};
    double.reply("auth:resume", new Promise<RpcResult>((resolve) => (answer = resolve)));
    double.setState("reconnecting");
    double.setState("locked");
    await flush(); // the resume goes out and waits
    expect(double.calls.map((c) => c.channel)).toContain("auth:resume");
    clock.advance(IDLE); // the idle lock fires meanwhile
    const before = double.events.length;
    answer({ ok: true, value: { locked: false, hasPasskeys: false } });
    await flush();
    expect(double.events.slice(before)).not.toContain("unlock");
    expect(double.rpc.state()).toBe("locked");
    expect(session.get()).toMatchObject({ lockedLocally: true, lockCause: "idle" });
  });

  it("logout offline still deletes the stored token and locks locally", async () => {
    const { double, store, session } = setup();
    await session.unlockWithPassword("pw");
    double.reply("auth:logout", { ok: false, error: { kind: "offline" } });
    await session.logout();
    expect(store.values.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(double.rpc.state()).toBe("locked");
    expect(session.get()).toMatchObject({ lockedLocally: true, lockCause: "logout" });
  });

  it("autoPrompt: on at launch, off after an in-app idle lock, on again in the foreground", async () => {
    const { clock, session } = setup();
    expect(session.get().autoPrompt).toBe(true);
    await session.unlockWithPassword("pw");
    clock.advance(IDLE);
    await flush();
    expect(session.get()).toMatchObject({ lockCause: "idle", autoPrompt: false });
    session.setAppActive(false);
    session.setAppActive(true);
    expect(session.get().autoPrompt).toBe(true);
  });

  it("autoPrompt stays on when the foreground return itself idle-locks", async () => {
    const { clock, session } = setup();
    await session.unlockWithPassword("pw");
    await session.unlockWithStoredRefresh(); // consumes the launch autoPrompt
    expect(session.get().autoPrompt).toBe(false);
    (clock as unknown as { now: () => number }).now = () => IDLE * 3;
    session.setAppActive(true);
    expect(session.get()).toMatchObject({ lockCause: "idle", autoPrompt: true });
  });
});

describe("auth-session: a lost refresh reply", () => {
  it("retries with the refresh token it still holds, and keeps the stored copy", async () => {
    const { clock, double, store, session } = setup();
    await session.unlockWithPassword("pw");
    const held = store.values.get(REFRESH_TOKEN_KEY);
    // The laptop rotated, but the reply never arrived.
    double.reply("auth:refresh", { ok: false, error: { kind: "timeout" } });
    session.touch();
    clock.advance(ACCESS_TTL * 0.8);
    await flush();
    expect(store.values.get(REFRESH_TOKEN_KEY)).toBe(held);

    // After the reconnect the access token has expired: refresh again.
    double.push(AUTH_STATE_CHANNEL, { locked: true, reason: "expired" });
    double.setState("locked");
    await flush();
    const refreshes = double.calls.filter((c) => c.channel === "auth:refresh");
    expect(refreshes).toHaveLength(2);
    expect(tokenArg(refreshes[0], "refreshToken")).toBe(held);
    expect(tokenArg(refreshes[1], "refreshToken")).toBe(held);
    expect(double.rpc.state()).toBe("open");
  });
});

describe("auth-session: the refresh-token-stored flag", () => {
  it("never raises the device-owner prompt when no refresh token is stored", async () => {
    const { double, session, device, store } = setup();
    expect(await session.unlockWithStoredRefresh()).toBe("no-stored-token");
    expect(device.state.prompts).toBe(0);
    expect(store.reads()).toBe(0);
    expect(double.calls).toEqual([]);
  });

  it("is set once a refresh token is stored, after the write", async () => {
    const { session, flag, store } = setup();
    await session.unlockWithPassword("pw");
    expect(flag.state.stored).toBe(true);
    expect(store.values.has(REFRESH_TOKEN_KEY)).toBe(true);
  });

  it("is written only when it changes, not on every rotation", async () => {
    const { clock, session, flag } = setup();
    await session.unlockWithPassword("pw");
    session.touch();
    clock.advance(ACCESS_TTL * 0.8);
    await flush();
    expect(flag.state.writes).toEqual([true]);
  });

  it("stays clear when storing the token fails", async () => {
    const { session, flag, store } = setup();
    store.failNextSet();
    await session.unlockWithPassword("pw");
    expect(flag.state.stored).toBe(false);
  });

  it("stays clear with no passcode on the phone", async () => {
    const { session, flag } = setup({ passcode: false });
    await session.unlockWithPassword("pw");
    expect(flag.state.stored).toBe(false);
  });

  it("is cleared by logout, and the next unlock does not prompt", async () => {
    const { session, flag, device } = setup();
    await session.unlockWithPassword("pw");
    await session.logout();
    expect(flag.state.stored).toBe(false);
    session.setAppActive(true);
    expect(await session.unlockWithStoredRefresh()).toBe("no-stored-token");
    expect(device.state.prompts).toBe(0);
  });

  it("is cleared by forget (unpair) and by a signed-out push", async () => {
    const first = setup();
    await first.session.unlockWithPassword("pw");
    await first.session.forget();
    expect(first.flag.state.stored).toBe(false);

    const second = setup();
    await second.session.unlockWithPassword("pw");
    second.double.push(AUTH_STATE_CHANNEL, { locked: true, reason: "signed-out" });
    await flush();
    expect(second.flag.state.stored).toBe(false);
  });

  it("is cleared by a refused refresh", async () => {
    const { double, session, flag, seed } = setup();
    seed(token());
    double.reply("auth:refresh", {
      ok: false,
      error: { kind: "remote", code: "forbidden", text: "x", language: "en" },
    });
    expect(await session.unlockWithStoredRefresh()).toBe("password-required");
    expect(flag.state.stored).toBe(false);
  });

  it("is cleared when it said stored but the keychain had nothing", async () => {
    const { session, flag } = setup();
    flag.state.stored = true;
    expect(await session.unlockWithStoredRefresh()).toBe("no-stored-token");
    expect(flag.state.stored).toBe(false);
  });
});

/** The browser build's device-owner gate over a mutable "Keep me signed in". */
function browserSetup(keep: boolean) {
  const setting = { keep };
  const ctx = setup({
    deviceAuth: createWebDeviceAuth(async () => setting.keep),
    storedUnlockAtLaunchOnly: true,
  });
  /** A page reload: memory is gone, IndexedDB and prefs stay. */
  function reload() {
    const clock = createFakeClock();
    const double = createRpcDouble(clock);
    const session = createAuthSession({
      rpc: double.rpc,
      clock,
      refreshStore: ctx.store.store,
      refreshStoredFlag: ctx.flag.flag,
      deviceAuth: createWebDeviceAuth(async () => setting.keep),
      storedUnlockAtLaunchOnly: true,
      idleMs: IDLE,
      log: () => {},
    });
    return { double, session };
  }
  return { ...ctx, setting, reload };
}

describe("auth-session: browser, keep me signed in off (the default)", () => {
  it("never writes a refresh token: login, scheduled refresh, idle lock", async () => {
    const { store, session, clock, flag, double } = browserSetup(false);
    expect(await session.unlockWithPassword("pw")).toBe("unlocked");
    clock.advance(ACCESS_TTL * 0.8);
    await flush();
    expect(double.calls.map((call) => call.channel)).toEqual(["auth:login", "auth:refresh"]);
    clock.advance(IDLE);
    await flush();
    expect(store.writes).toEqual([]);
    expect(store.values.size).toBe(0);
    expect(flag.state.stored).toBe(false);
  });

  it("after a reload the stored-refresh unlock finds nothing and sends nothing", async () => {
    const browser = browserSetup(false);
    await browser.session.unlockWithPassword("pw");
    const { double, session } = browser.reload();
    expect(await session.unlockWithStoredRefresh()).toBe("no-stored-token");
    expect(double.calls).toEqual([]);
  });
});

describe("auth-session: browser, keep me signed in on", () => {
  it("stores the refresh token, and after a reload refreshes with it straight away (no prompt)", async () => {
    const browser = browserSetup(true);
    await browser.session.unlockWithPassword("pw");
    const stored = browser.store.values.get(REFRESH_TOKEN_KEY);
    expect(stored).toBeDefined();
    expect(browser.flag.state.stored).toBe(true);
    const { double, session } = browser.reload();
    expect(await session.unlockWithStoredRefresh()).toBe("unlocked");
    expect(double.calls.map((call) => call.channel)).toEqual(["auth:refresh"]);
    expect(tokenArg(double.calls[0], "refreshToken")).toBe(stored);
  });

  it("the access token is never stored", async () => {
    const browser = browserSetup(true);
    await browser.session.unlockWithPassword("pw");
    const login = browser.double.calls[0];
    expect(login?.channel).toBe("auth:login");
    const written = browser.store.writes.map((write) => write.value);
    expect(written).toHaveLength(1);
    // The one write is the refresh token the login answered with, never
    // the access token (tokens are distinct counters in the double).
    expect(written[0]).toBe(browser.store.values.get(REFRESH_TOKEN_KEY));
  });
});

describe("auth-session: storagePolicyChanged (the setting flipped while unlocked)", () => {
  it("turned on: rotates once so the new refresh token is stored through the normal path", async () => {
    const browser = browserSetup(false);
    await browser.session.unlockWithPassword("pw");
    expect(browser.store.writes).toEqual([]);
    browser.setting.keep = true;
    await browser.session.storagePolicyChanged();
    expect(browser.double.calls.map((call) => call.channel)).toEqual([
      "auth:login",
      "auth:refresh",
    ]);
    expect(browser.store.values.has(REFRESH_TOKEN_KEY)).toBe(true);
    expect(browser.flag.state.stored).toBe(true);
    expect(browser.double.rpc.state()).toBe("open");
  });

  it("turned off: deletes the stored token and rotates once, keeping the new pair in memory only", async () => {
    const browser = browserSetup(true);
    await browser.session.unlockWithPassword("pw");
    const deleted = browser.store.values.get(REFRESH_TOKEN_KEY);
    browser.setting.keep = false;
    await browser.session.storagePolicyChanged();
    expect(browser.store.values.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(browser.flag.state.stored).toBe(false);
    // The deleted copy was spent on the laptop by this rotation.
    expect(browser.double.calls.map((call) => call.channel)).toEqual([
      "auth:login",
      "auth:refresh",
    ]);
    expect(tokenArg(browser.double.calls[1], "refreshToken")).toBe(deleted);
    expect(browser.store.writes).toHaveLength(1);
    expect(browser.double.rpc.state()).toBe("open");
    // The next scheduled refresh uses the new in-memory token.
    browser.clock.advance(ACCESS_TTL * 0.8);
    await flush();
    expect(tokenArg(browser.double.calls[2], "refreshToken")).not.toBe(deleted);
  });

  it("a write racing the switch to off is taken back out", async () => {
    const browser = browserSetup(true);
    const originalSet = browser.store.store.set;
    browser.store.store.set = async (key, value) => {
      browser.setting.keep = false;
      await originalSet(key, value);
    };
    await browser.session.unlockWithPassword("pw");
    expect(browser.store.values.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(browser.flag.state.stored).toBe(false);
  });

  it("turned on while locked: nothing to store, no request", async () => {
    const browser = browserSetup(false);
    browser.setting.keep = true;
    await browser.session.storagePolicyChanged();
    expect(browser.double.calls).toEqual([]);
    expect(browser.store.writes).toEqual([]);
  });
});

describe("auth-session: passkey unlock", () => {
  const OPTIONS = { challenge: "AQID", rpId: "laptop.tail.ts.net", userVerification: "required" };
  const ASSERTION = {
    credentialId: "-w",
    clientDataJSON: "AQ",
    authenticatorData: "Ag",
    signature: "Aw",
  };

  it("begins, asks the browser with the server's options, finishes and unlocks", async () => {
    const { double, session, store } = setup();
    double.reply("auth:passkeyBegin", { ok: true, value: OPTIONS });
    double.reply("auth:passkeyFinish", double.tokensFor());
    const asked: unknown[] = [];
    const outcome = await session.unlockWithPasskey(async (options) => {
      asked.push(options);
      return ASSERTION;
    });
    expect(outcome).toBe("unlocked");
    expect(asked).toEqual([OPTIONS]);
    expect(double.calls.map((call) => call.channel)).toEqual([
      "auth:passkeyBegin",
      "auth:passkeyFinish",
    ]);
    expect(double.calls[1]?.args).toEqual([ASSERTION]);
    expect(double.rpc.state()).toBe("open");
    expect(store.values.has(REFRESH_TOKEN_KEY)).toBe(true);
  });

  it("a dismissed browser sheet is cancelled and sends no finish", async () => {
    const { double, session } = setup();
    double.reply("auth:passkeyBegin", { ok: true, value: OPTIONS });
    expect(await session.unlockWithPasskey(async () => undefined)).toBe("cancelled");
    expect(double.calls.map((call) => call.channel)).toEqual(["auth:passkeyBegin"]);
  });

  it("a browser error is a failure and sends no finish", async () => {
    const { double, session } = setup();
    double.reply("auth:passkeyBegin", { ok: true, value: OPTIONS });
    const outcome = await session.unlockWithPasskey(async () => {
      throw new Error("SecurityError");
    });
    expect(outcome).toBe("failed");
    expect(double.calls).toHaveLength(1);
  });

  it("an unsupported laptop (no web origin) answers passkey-unsupported", async () => {
    const { double, session } = setup();
    double.reply("auth:passkeyBegin", {
      ok: false,
      error: { kind: "remote", code: "unsupported", text: "x", language: "en" },
    });
    let asked = false;
    const outcome = await session.unlockWithPasskey(async () => {
      asked = true;
      return ASSERTION;
    });
    expect(outcome).toBe("passkey-unsupported");
    expect(asked).toBe(false);
  });

  it("a refused assertion answers passkey-refused and stays locked", async () => {
    const { double, session } = setup();
    double.reply("auth:passkeyBegin", { ok: true, value: OPTIONS });
    double.reply("auth:passkeyFinish", {
      ok: false,
      error: { kind: "remote", code: "forbidden", text: "x", language: "en" },
    });
    expect(await session.unlockWithPasskey(async () => ASSERTION)).toBe("passkey-refused");
    expect(double.rpc.state()).toBe("locked");
  });

  it("maps rate-limited and offline like the password path", async () => {
    const { double, session } = setup();
    double.reply("auth:passkeyBegin", { ok: true, value: OPTIONS });
    double.reply("auth:passkeyFinish", {
      ok: false,
      error: { kind: "remote", code: "rate-limited", text: "x", language: "en" },
    });
    expect(await session.unlockWithPasskey(async () => ASSERTION)).toBe("rate-limited");
    double.reply("auth:passkeyBegin", { ok: false, error: { kind: "offline" } });
    expect(await session.unlockWithPasskey(async () => ASSERTION)).toBe("offline");
  });

  it("a malformed begin answer never reaches the browser", async () => {
    const { double, session } = setup();
    double.reply("auth:passkeyBegin", { ok: true, value: { challenge: 5 } });
    let asked = false;
    const outcome = await session.unlockWithPasskey(async () => {
      asked = true;
      return ASSERTION;
    });
    expect(outcome).toBe("failed");
    expect(asked).toBe(false);
  });
});

describe("auth-session: browser, the stored token only signs in at page load", () => {
  it("an idle lock needs a passkey or the password even with keep-signed-in on", async () => {
    const browser = browserSetup(true);
    await browser.session.unlockWithPassword("pw");
    expect(browser.store.values.has(REFRESH_TOKEN_KEY)).toBe(true);
    browser.clock.advance(IDLE);
    await flush();
    expect(browser.session.get().lockCause).toBe("idle");
    const before = browser.double.calls.length;
    expect(await browser.session.unlockWithStoredRefresh()).toBe("no-stored-token");
    expect(browser.double.calls).toHaveLength(before);
    expect(browser.session.get().autoPrompt).toBe(false);
  });

  it("returning to the tab after the idle window locks and never re-arms the automatic sign-in", async () => {
    const browser = browserSetup(true);
    await browser.session.unlockWithPassword("pw");
    browser.session.setAppActive(false);
    browser.clock.advance(IDLE + 1);
    browser.session.setAppActive(true);
    expect(browser.session.get().lockCause).toBe("idle");
    expect(browser.session.get().autoPrompt).toBe(false);
    expect(await browser.session.unlockWithStoredRefresh()).toBe("no-stored-token");
  });

  it("after a reload the stored token signs in once, and only that once", async () => {
    const browser = browserSetup(true);
    await browser.session.unlockWithPassword("pw");
    const { double, session } = browser.reload();
    expect(session.get().autoPrompt).toBe(true);
    expect(await session.unlockWithStoredRefresh()).toBe("unlocked");
    session.setAppActive(true);
    expect(session.get().autoPrompt).toBe(false);
    session.dispose();
    expect(double.calls.map((call) => call.channel)).toEqual(["auth:refresh"]);
  });

  it("the native app keeps using the stored token after an idle lock", async () => {
    const { session, clock, double } = setup();
    await session.unlockWithPassword("pw");
    clock.advance(IDLE);
    await flush();
    const before = double.calls.length;
    expect(await session.unlockWithStoredRefresh()).toBe("unlocked");
    expect(double.calls.slice(before).map((call) => call.channel)).toEqual(["auth:refresh"]);
  });
});
