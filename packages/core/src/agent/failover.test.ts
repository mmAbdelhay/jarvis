import { describe, expect, it } from "vitest";
import {
  type FailoverEntry,
  type FailoverSwitch,
  allowedChain,
  createFailoverProvider,
  failoverReason,
} from "./failover.js";
import { FAILOVER_TEXT } from "./messages.js";
import { type ModelEvent, type ModelProvider, ProviderError } from "./types.js";

const DONE: ModelEvent = { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };

function answering(id: string, seen: string[]): ModelProvider {
  return {
    async *chat() {
      seen.push(id);
      yield { type: "text", delta: `from ${id}` };
      yield DONE;
    },
    probe: async () => ({ ok: true, supportsTools: true, models: [id] }),
    listModels: async () => [id],
    reachable: async () => ({ ok: true }),
  };
}

function failing(id: string, error: Error, seen: string[]): ModelProvider {
  return {
    // biome-ignore lint/correctness/useYield: it fails before it yields anything.
    async *chat() {
      seen.push(id);
      throw error;
    },
    probe: async () => ({ ok: false, supportsTools: false, models: [], error: error.message }),
    listModels: async () => {
      throw error;
    },
    reachable: async () => ({ ok: false, error: error.message }),
  };
}

function hanging(id: string, seen: string[]): ModelProvider {
  return {
    async *chat(request) {
      seen.push(id);
      await new Promise<never>((_, reject) => {
        request.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    },
    probe: async () => ({ ok: true, supportsTools: true, models: [] }),
    listModels: async () => [],
    reachable: async () => ({ ok: true }),
  };
}

function fakeTimers() {
  const pending: { callback: () => void; ms: number; cleared: boolean }[] = [];
  return {
    pending,
    setTimeout: (callback: () => void, ms: number) => {
      pending.push({ callback, ms, cleared: false });
      return pending.length - 1;
    },
    clearTimeout: (handle: unknown) => {
      const entry = pending[handle as number];
      if (entry !== undefined) entry.cleared = true;
    },
  };
}

async function collect(provider: ModelProvider, signal = new AbortController().signal) {
  const events: ModelEvent[] = [];
  for await (const event of provider.chat({
    system: "s",
    messages: [{ role: "user", text: "hi" }],
    tools: [],
    signal,
  })) {
    events.push(event);
    if (event.type === "done") break;
  }
  return events;
}

const entry = (
  id: string,
  locality: "local" | "cloud",
  provider: ModelProvider,
): FailoverEntry => ({
  id,
  locality,
  provider,
});

function setup(entries: FailoverEntry[], allowCloudFallback = false) {
  const timers = fakeTimers();
  const switches: FailoverSwitch[] = [];
  const provider = createFailoverProvider({
    entries,
    allowCloudFallback,
    timers,
    onSwitch: (change) => switches.push(change),
  });
  return { provider, timers, switches };
}

describe("allowedChain (design §3.5 privacy ruling)", () => {
  const p = answering("x", []);
  it("skips cloud entries after a local/LAN one unless the user opted in", () => {
    const ids = (entries: FailoverEntry[], allow: boolean) =>
      allowedChain(entries, allow).map((e) => e.id);
    expect(ids([entry("local", "local", p), entry("work", "cloud", p)], false)).toEqual(["local"]);
    expect(ids([entry("local", "local", p), entry("work", "cloud", p)], true)).toEqual([
      "local",
      "work",
    ]);
    expect(
      ids(
        [entry("cloud", "cloud", p), entry("lan", "local", p), entry("local", "local", p)],
        false,
      ),
    ).toEqual(["cloud", "lan", "local"]);
    expect(
      ids(
        [entry("cloud", "cloud", p), entry("lan", "local", p), entry("cloud2", "cloud", p)],
        false,
      ),
    ).toEqual(["cloud", "lan"]);
  });
});

describe("failoverReason", () => {
  it("fails over on network, 429, 5xx and overload only", () => {
    expect(failoverReason(new ProviderError("network", "Cannot reach x"))).toBe(
      FAILOVER_TEXT.en.unreachable("Cannot reach x"),
    );
    expect(failoverReason(new ProviderError("http", "429 slow down", 429))).toBe(
      FAILOVER_TEXT.en.rateLimited,
    );
    expect(failoverReason(new ProviderError("http", "503 unavailable", 503))).toBe(
      FAILOVER_TEXT.en.serverError(503),
    );
    expect(failoverReason(new ProviderError("http", "Overloaded"))).toBe(
      FAILOVER_TEXT.en.overloaded,
    );
    expect(failoverReason(new ProviderError("http", "529 overloaded_error", 529))).toBe(
      FAILOVER_TEXT.en.overloaded,
    );
    expect(failoverReason(new ProviderError("auth", "401 invalid x-api-key", 401))).toBeNull();
    expect(failoverReason(new ProviderError("http", "400 bad request", 400))).toBeNull();
    expect(failoverReason(new ProviderError("bad-response", "not JSON"))).toBeNull();
    expect(failoverReason(new Error("boom"))).toBeNull();
  });
});

describe("createFailoverProvider (design §3.5, criterion 5)", () => {
  it("completes on the next provider when the cloud returns 5xx, and says why", async () => {
    const seen: string[] = [];
    const { provider, switches } = setup([
      entry("cloud", "cloud", failing("cloud", new ProviderError("http", "503 x", 503), seen)),
      entry("lan", "local", answering("lan", seen)),
      entry("local", "local", answering("local", seen)),
    ]);
    const events = await collect(provider);
    expect(events[0]).toEqual({ type: "text", delta: "from lan" });
    expect(seen).toEqual(["cloud", "lan"]);
    expect(switches).toEqual([
      { fromId: "cloud", toId: "lan", reason: "cloud returned an error (503)" },
    ]);
    expect(provider.status()).toEqual({
      activeId: "lan",
      fallbackReason: "cloud returned an error (503)",
    });
  });

  it("fails over on 429 and on a network error", async () => {
    for (const error of [
      new ProviderError("http", "429 x", 429),
      new ProviderError("network", "Cannot reach api"),
    ]) {
      const seen: string[] = [];
      const { provider } = setup([
        entry("cloud", "cloud", failing("cloud", error, seen)),
        entry("lan", "local", answering("lan", seen)),
      ]);
      await collect(provider);
      expect(seen).toEqual(["cloud", "lan"]);
    }
  });

  it("shows auth errors instead of failing over", async () => {
    const seen: string[] = [];
    const { provider, switches } = setup([
      entry(
        "cloud",
        "cloud",
        failing("cloud", new ProviderError("auth", "401 bad key", 401), seen),
      ),
      entry("lan", "local", answering("lan", seen)),
    ]);
    await expect(collect(provider)).rejects.toThrow("401 bad key");
    expect(seen).toEqual(["cloud"]);
    expect(switches).toEqual([]);
  });

  it("never fails over after the first event (no duplicated text)", async () => {
    const seen: string[] = [];
    const halfway: ModelProvider = {
      ...answering("cloud", seen),
      async *chat() {
        seen.push("cloud");
        yield { type: "text", delta: "partial" };
        throw new ProviderError("http", "503 x", 503);
      },
    };
    const { provider } = setup([
      entry("cloud", "cloud", halfway),
      entry("lan", "local", answering("lan", seen)),
    ]);
    await expect(collect(provider)).rejects.toThrow("503");
    expect(seen).toEqual(["cloud"]);
  });

  it("fails over after 30 s without a first event; the last provider has no timer", async () => {
    const seen: string[] = [];
    const { provider, timers } = setup([
      entry("cloud", "cloud", hanging("cloud", seen)),
      entry("lan", "local", answering("lan", seen)),
    ]);
    const done = collect(provider);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timers.pending).toHaveLength(1);
    expect(timers.pending[0]?.ms).toBe(30_000);
    timers.pending[0]?.callback();
    const events = await done;
    expect(events[0]).toEqual({ type: "text", delta: "from lan" });
    expect(timers.pending).toHaveLength(1);
    expect(provider.status().fallbackReason).toBe(`cloud ${FAILOVER_TEXT.en.slow}`);
  });

  it("is sticky for the rest of the turn and retries the first on the next turn", async () => {
    const seen: string[] = [];
    const { provider } = setup([
      entry("cloud", "cloud", failing("cloud", new ProviderError("http", "502 x", 502), seen)),
      entry("lan", "local", answering("lan", seen)),
    ]);
    provider.beginTurn();
    await collect(provider);
    await collect(provider);
    expect(seen).toEqual(["cloud", "lan", "lan"]);
    provider.beginTurn();
    await collect(provider);
    expect(seen).toEqual(["cloud", "lan", "lan", "cloud", "lan"]);
  });

  it("never sends a local user's request to the cloud without the opt-in", async () => {
    const seen: string[] = [];
    const { provider } = setup([
      entry("local", "local", failing("local", new ProviderError("network", "down"), seen)),
      entry("lan", "local", failing("lan", new ProviderError("network", "down"), seen)),
      entry("work", "cloud", answering("work", seen)),
    ]);
    await expect(collect(provider)).rejects.toThrow("down");
    expect(seen).toEqual(["local", "lan"]);
  });

  it("rethrows the user's Stop without switching", async () => {
    const seen: string[] = [];
    const { provider, switches } = setup([
      entry("cloud", "cloud", hanging("cloud", seen)),
      entry("lan", "local", answering("lan", seen)),
    ]);
    const controller = new AbortController();
    const done = collect(provider, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(done).rejects.toThrow("aborted");
    expect(switches).toEqual([]);
    expect(seen).toEqual(["cloud"]);
  });

  it("reports reachability from the first answering provider; auth errors are not skipped", async () => {
    const seen: string[] = [];
    const down = setup([
      entry("cloud", "cloud", failing("cloud", new ProviderError("network", "Cannot reach"), seen)),
      entry("lan", "local", answering("lan", seen)),
    ]);
    await expect(down.provider.reachable()).resolves.toEqual({ ok: true });
    expect(down.provider.status()).toEqual({
      activeId: "lan",
      fallbackReason: `cloud ${FAILOVER_TEXT.en.unreachable("Cannot reach")}`,
    });
    const badKey = setup([
      entry("cloud", "cloud", failing("cloud", new ProviderError("auth", "401 bad key"), seen)),
      entry("lan", "local", answering("lan", seen)),
    ]);
    await expect(badKey.provider.reachable()).resolves.toEqual({ ok: false, error: "401 bad key" });
    expect(badKey.provider.status()).toEqual({ activeId: "cloud", fallbackReason: null });
  });

  it("refuses an empty list", () => {
    expect(() => setup([])).toThrow();
  });
});
