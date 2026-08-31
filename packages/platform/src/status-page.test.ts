import { describe, expect, it, vi } from "vitest";
import type { FetchFn } from "./status-page.js";
import { STATUS_PAGE_URLS, readStatusPage } from "./status-page.js";

const respond = (body: unknown): FetchFn => async () => ({ ok: true, json: async () => body });

describe("readStatusPage", () => {
  it("maps each Statuspage indicator to a health state", async () => {
    const cases = [
      ["none", "ok"],
      ["minor", "degraded"],
      ["major", "outage"],
      ["critical", "outage"],
    ] as const;

    for (const [indicator, state] of cases) {
      const reading = await readStatusPage("anthropic", {
        fetch: respond({ status: { indicator, description: "Some words" } }),
      });
      expect(reading).toEqual({ state, detail: "Some words" });
    }
  });

  it("asks the right URL for each vendor", async () => {
    const fetchFn = vi.fn(respond({ status: { indicator: "none", description: "ok" } }));
    await readStatusPage("github", { fetch: fetchFn });
    expect(fetchFn).toHaveBeenCalledWith(STATUS_PAGE_URLS.github, expect.anything());
  });

  it("reports unknown, not a guess, for an indicator it has never seen", async () => {
    const reading = await readStatusPage("anthropic", {
      fetch: respond({ status: { indicator: "meltdown", description: "?" } }),
    });
    expect(reading.state).toBe("unknown");
  });

  it("reports unknown for a body that is not the shape we expect", async () => {
    for (const body of [null, {}, { status: "up" }, { status: { indicator: 7 } }, []]) {
      expect((await readStatusPage("anthropic", { fetch: respond(body) })).state).toBe("unknown");
    }
  });

  it("reports unknown on a non-OK response", async () => {
    const reading = await readStatusPage("anthropic", {
      fetch: async () => ({ ok: false, json: async () => ({}) }),
    });
    expect(reading.state).toBe("unknown");
  });

  it("reports unknown instead of rejecting when the network throws", async () => {
    const reading = await readStatusPage("anthropic", {
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    expect(reading).toEqual({ state: "unknown", detail: "" });
  });

  it("is bounded: a fetch that never settles resolves as unknown, not a hang", async () => {
    vi.useFakeTimers();
    try {
      const pending = readStatusPage(
        "anthropic",
        // A real fetch rejects on abort; this stand-in does the same when the
        // signal fires, which is the behaviour the bound relies on.
        {
          fetch: (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
          timeoutMs: 1_000,
        },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).state).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout timer on the success path, so the process is never kept alive by it", async () => {
    vi.useFakeTimers();
    try {
      const before = vi.getTimerCount();
      await readStatusPage("anthropic", {
        fetch: respond({ status: { indicator: "none", description: "ok" } }),
      });
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
