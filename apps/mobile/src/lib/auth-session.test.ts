import { AUTH_STATE_CHANNEL } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { REFRESH_TOKEN_KEY, createAuthSession } from "./auth-session";
import type { RefreshStore } from "./auth-session";
import { createFakeClock } from "./clock";
import type { ClientState, RpcResult } from "./rpc-client";

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
function createStoreDouble(events: string[], options: { biometrics?: boolean } = {}) {
  const values = new Map<string, string>();
  const writes: Array<{ key: string; value: string }> = [];
  let failNextSet = false;
  let failNextGet = false;
  const store: RefreshStore = {
    async get(key) {
      if (failNextGet) {
        failNextGet = false;
        throw new Error("cancelled");
      }
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
    canUseBiometrics: () => options.biometrics ?? true,
  };
  return {
    store,
    values,
    writes,
    failNextSet: () => {
      failNextSet = true;
    },
    failNextGet: () => {
      failNextGet = true;
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup(options: { biometrics?: boolean } = {}) {
  const clock = createFakeClock();
  const double = createRpcDouble(clock);
  const store = createStoreDouble(double.events, options);
  const logs: string[] = [];
  const session = createAuthSession({
    rpc: double.rpc,
    clock,
    refreshStore: store.store,
    idleMs: IDLE,
    log: (line) => logs.push(line),
  });
  return { clock, double, store, session, logs };
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

  it("with no biometrics on the phone, keeps nothing on disk and says so", async () => {
    const { store, session } = setup({ biometrics: false });
    expect(await session.unlockWithPassword("pw")).toBe("unlocked");
    expect(store.writes).toEqual([]);
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
    const { double, store, session } = setup();
    store.values.set(REFRESH_TOKEN_KEY, token());
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
    const { double, store, session } = setup();
    const stored = token();
    store.values.set(REFRESH_TOKEN_KEY, stored);
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

  it("answers cancelled when the biometric prompt fails", async () => {
    const { store, session } = setup();
    store.values.set(REFRESH_TOKEN_KEY, token());
    store.failNextGet();
    expect(await session.unlockWithStoredRefresh()).toBe("cancelled");
  });

  it("a refused (reused/invalid) token is deleted and the password is required", async () => {
    const { double, store, session } = setup();
    store.values.set(REFRESH_TOKEN_KEY, token());
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
