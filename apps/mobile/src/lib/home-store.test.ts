import { describe, expect, it } from "vitest";
import {
  parseCapacityTrends,
  parseProviderCapacity,
  parseSessionsPerDay,
  resetsIn,
  TREND_BARS,
} from "./home-capacity";
import { createHomeStore } from "./home-store";
import type { ClientState, RpcClient, RpcResult } from "./rpc-client";

type PushHandler = (payload: unknown, dropped: number | undefined) => void;

/** A fake client answering each call by channel, recording subscriptions,
 *  and letting a test drive pushes directly. */
function fakeClient(answer: (channel: string, args: unknown[]) => RpcResult) {
  const calls: { channel: string; args: unknown[] }[] = [];
  const subscribed: unknown[] = [];
  const unsubscribed: unknown[] = [];
  const pushes = new Map<string, Set<PushHandler>>();
  const state: ClientState = "open";
  const client = {
    call: async (channel: string, args: unknown[]) => {
      calls.push({ channel, args });
      return answer(channel, args);
    },
    subscribe: (target: unknown) => {
      subscribed.push(target);
      return { ok: true, value: undefined };
    },
    unsubscribe: (target: unknown) => {
      unsubscribed.push(target);
    },
    onPush: (channel: string, handler: PushHandler) => {
      const set = pushes.get(channel) ?? new Set<PushHandler>();
      set.add(handler);
      pushes.set(channel, set);
      return () => set.delete(handler);
    },
    onState: () => () => {},
    state: () => state,
  } as unknown as RpcClient;
  return {
    client,
    calls,
    subscribed,
    unsubscribed,
    push(channel: string, payload: unknown) {
      for (const handler of pushes.get(channel) ?? []) handler(payload, undefined);
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const PROMPT = { question: "Run it?", options: [{ label: "Yes" }, { label: "No" }] };

function fakeTimer() {
  let tick: (() => void) | undefined;
  let cleared = false;
  return {
    setInterval: (fn: () => void) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      cleared = true;
    },
    tick: () => tick?.(),
    cleared: () => cleared,
  };
}

describe("parseProviderCapacity", () => {
  it("keeps known windows with what is left, floored, and names the window by vendor", () => {
    const cards = parseProviderCapacity([
      {
        id: "claude-main",
        vendor: "anthropic",
        capacity: {
          state: "known",
          primary: { usedPercent: 37.6, resetsAt: "2026-10-02T12:00:00Z" },
          readAt: 1,
        },
      },
      {
        id: "copilot",
        vendor: "github",
        capacity: {
          state: "known",
          primary: { usedPercent: 120, resetsAt: "2026-11-01T00:00:00Z" },
        },
      },
      { id: "codex", vendor: "openai", capacity: { state: "unknown", reason: "never-read" } },
      { id: "broken", capacity: { state: "known", primary: { usedPercent: "x" } } },
      "junk",
    ]);
    expect(cards).toEqual([
      { id: "claude-main", window: "5h", left: 62, resetsAt: Date.parse("2026-10-02T12:00:00Z") },
      { id: "copilot", window: "month", left: 0, resetsAt: Date.parse("2026-11-01T00:00:00Z") },
    ]);
  });

  it("reads nothing from a payload that is not a list", () => {
    expect(parseProviderCapacity({ id: "x" })).toEqual([]);
  });
});

describe("parseCapacityTrends", () => {
  it("samples a long history down to a fixed number of bars, oldest first", () => {
    const points = Array.from({ length: 100 }, (_, index) => ({ at: index, left: index }));
    const [trend] = parseCapacityTrends({ capacity: [{ id: "a", points }], sessionsPerDay: [] });
    expect(trend?.points).toHaveLength(TREND_BARS);
    expect(trend?.points[0]).toBe(0);
    expect(trend?.points.at(-1)).toBe(99);
  });

  it("drops accounts with no readable point", () => {
    expect(parseCapacityTrends({ capacity: [{ id: "a", points: [{ left: "x" }] }] })).toEqual([]);
  });
});

describe("parseSessionsPerDay", () => {
  it("keeps the last 31 days' counts in order", () => {
    const days = Array.from({ length: 40 }, (_, day) => ({ day, count: day }));
    const counts = parseSessionsPerDay({ sessionsPerDay: days });
    expect(counts).toHaveLength(31);
    expect(counts[0]).toBe(9);
    expect(counts[30]).toBe(39);
  });

  it("reads nothing from a malformed history rather than a gap-filled guess", () => {
    expect(parseSessionsPerDay(null)).toEqual([]);
    expect(parseSessionsPerDay({ sessionsPerDay: "x" })).toEqual([]);
    expect(parseSessionsPerDay({ sessionsPerDay: [{ count: 1 }, { count: -1 }] })).toEqual([]);
    expect(parseSessionsPerDay({ sessionsPerDay: [{ count: 1.5 }] })).toEqual([]);
  });
});

describe("resetsIn", () => {
  it("says hours and minutes, minutes, days, or nothing once passed", () => {
    expect(resetsIn(100 * 60_000, 0)).toBe("1h 40m");
    expect(resetsIn(25 * 60_000, 0)).toBe("25m");
    expect(resetsIn(120 * 60_000, 0)).toBe("2h");
    expect(resetsIn(30_000, 0)).toBe("<1m");
    expect(resetsIn(72 * 3_600_000, 0)).toBe("3d");
    expect(resetsIn(0, 60_001)).toBeUndefined();
  });
});

describe("createHomeStore", () => {
  it("subscribes to capacity on focus and drops it on blur", async () => {
    const fake = fakeClient(() => ({ ok: true, value: null }));
    const timer = fakeTimer();
    const store = createHomeStore({ client: fake.client, ...timer });
    store.focus();
    expect(fake.subscribed).toEqual(["providers:update"]);
    fake.push("providers:update", [
      {
        id: "claude-main",
        vendor: "anthropic",
        capacity: {
          state: "known",
          primary: { usedPercent: 50, resetsAt: "2026-10-02T12:00:00Z" },
        },
      },
    ]);
    expect(store.get().capacity[0]?.left).toBe(50);
    store.blur();
    expect(fake.unsubscribed).toEqual(["providers:update"]);
    expect(timer.cleared()).toBe(true);
  });

  it("asks each live session for its prompt and lists only the ones waiting", async () => {
    const fake = fakeClient((channel, args) =>
      channel === "session:prompt" && args[0] === "s2"
        ? { ok: true, value: PROMPT }
        : { ok: true, value: null },
    );
    const timer = fakeTimer();
    const store = createHomeStore({ client: fake.client, ...timer });
    store.focus();
    store.setLiveSessions(["s1", "s2"]);
    await flush();
    expect(store.get().waiting).toEqual([
      { sessionId: "s2", prompt: { question: "Run it?", options: ["Yes", "No"] } },
    ]);
  });

  it("forgets a session that is no longer live, and one just answered", async () => {
    const fake = fakeClient((channel) =>
      channel === "session:prompt" ? { ok: true, value: PROMPT } : { ok: true, value: null },
    );
    const timer = fakeTimer();
    const store = createHomeStore({ client: fake.client, ...timer });
    store.focus();
    store.setLiveSessions(["s1", "s2"]);
    await flush();
    expect(store.get().waiting.map((entry) => entry.sessionId)).toEqual(["s1", "s2"]);
    store.dismiss("s1");
    expect(store.get().waiting.map((entry) => entry.sessionId)).toEqual(["s2"]);
    store.setLiveSessions(["s1"]);
    expect(store.get().waiting.map((entry) => entry.sessionId)).toEqual([]);
  });

  it("asks again on every tick while focused, and never once blurred", async () => {
    const fake = fakeClient(() => ({ ok: true, value: null }));
    const timer = fakeTimer();
    const store = createHomeStore({ client: fake.client, ...timer });
    store.focus();
    store.setLiveSessions(["s1"]);
    await flush();
    const asked = () => fake.calls.filter((call) => call.channel === "session:prompt").length;
    const before = asked();
    timer.tick();
    await flush();
    expect(asked()).toBe(before + 1);
    store.blur();
    timer.tick();
    await flush();
    expect(asked()).toBe(before + 1);
  });

  it("loads the day's trend on focus", async () => {
    const fake = fakeClient((channel) =>
      channel === "usage:history"
        ? {
            ok: true,
            value: {
              capacity: [{ id: "a", points: [{ at: 1, left: 40 }] }],
              sessionsPerDay: [
                { day: 1, count: 2 },
                { day: 2, count: 0 },
              ],
            },
          }
        : { ok: true, value: null },
    );
    const store = createHomeStore({ client: fake.client, ...fakeTimer() });
    store.focus();
    await flush();
    expect(store.get().trends).toEqual([{ id: "a", points: [40] }]);
    expect(store.get().sessionsPerDay).toEqual([2, 0]);
  });
});
