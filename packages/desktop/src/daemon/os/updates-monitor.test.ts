// packages/desktop/src/daemon/os/updates-monitor.test.ts
import type { ToolOutcome, UpdatesSummary } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import {
  createUpdatesMonitor,
  UPDATES_FIRST_CHECK_MS,
  UPDATES_MAX_AGE_MS,
  UPDATES_TICK_MS,
  UpdatesCheckError,
} from "./updates-monitor.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const listing = (security: boolean[], checkedAt = "2026-10-08T09:00:00Z"): ToolOutcome => ({
  ok: true,
  data: {
    items: security.map((s, i) => ({
      source: "apt",
      id: `p${i}`,
      from: "1",
      to: "2",
      security: s,
    })),
    checkedAt,
  },
  text: "{}",
});

function harness(answers: Array<ToolOutcome | (() => Promise<ToolOutcome>)>) {
  let now = 1_000_000;
  let lists = 0;
  const changes: UpdatesSummary[] = [];
  const lines: string[] = [];
  const timeouts = new Map<number, { callback: () => void; ms: number }>();
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  let ids = 0;
  const monitor = createUpdatesMonitor({
    list: async () => {
      lists++;
      const next = answers.shift();
      if (next === undefined) throw new Error("unexpected updates.list");
      return typeof next === "function" ? next() : next;
    },
    onChange: (summary) => changes.push(summary),
    now: () => now,
    timers: {
      setTimeout: (callback, ms) => {
        timeouts.set(++ids, { callback, ms });
        return ids;
      },
      clearTimeout: (handle) => {
        timeouts.delete(handle as number);
      },
      setInterval: (callback, ms) => {
        intervals.set(++ids, { callback, ms });
        return ids;
      },
      clearInterval: (handle) => {
        intervals.delete(handle as number);
      },
    },
    log: (line) => lines.push(line),
  });
  const fireTimeouts = () => {
    for (const [id, entry] of [...timeouts]) {
      timeouts.delete(id);
      entry.callback();
    }
  };
  const tick = () => {
    for (const entry of intervals.values()) entry.callback();
  };
  return {
    monitor,
    changes,
    lines,
    timeouts,
    intervals,
    fireTimeouts,
    tick,
    lists: () => lists,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createUpdatesMonitor (M2 contracts §2)", () => {
  it("checks 2 minutes after start, then hourly ticks re-check once the last check is a day old", async () => {
    const h = harness([listing([false, true]), listing([true])]);
    expect(h.monitor.current()).toEqual({ count: 0, security: 0, checkedAt: null });
    h.monitor.start();
    expect([...h.timeouts.values()].map((t) => t.ms)).toEqual([UPDATES_FIRST_CHECK_MS]);
    expect(h.lists()).toBe(0);
    h.fireTimeouts();
    await flush();
    expect(h.lists()).toBe(1);
    expect(h.changes).toEqual([
      { count: 2, security: 1, checkedAt: Date.parse("2026-10-08T09:00:00Z") },
    ]);
    expect([...h.intervals.values()].map((i) => i.ms)).toEqual([UPDATES_TICK_MS]);
    h.advance(UPDATES_MAX_AGE_MS - 1);
    h.tick();
    await flush();
    expect(h.lists()).toBe(1);
    h.advance(1);
    h.tick();
    await flush();
    expect(h.lists()).toBe(2);
    expect(h.monitor.current()).toMatchObject({ count: 1, security: 1 });
  });

  it("retries a failed scheduled check on the next hourly tick and logs the failure", async () => {
    const offline: ToolOutcome = {
      ok: false,
      data: { code: "failed", message: "Temporary failure resolving deb.debian.org" },
      text: "x",
      code: "failed",
    };
    const h = harness([offline, listing([])]);
    h.monitor.start();
    h.fireTimeouts();
    await flush();
    expect(h.lines).toEqual(["[updates] check failed: Temporary failure resolving deb.debian.org"]);
    expect(h.monitor.current().checkedAt).toBeNull();
    h.advance(UPDATES_TICK_MS);
    h.tick();
    await flush();
    expect(h.lists()).toBe(2);
    expect(h.monitor.current()).toMatchObject({ count: 0, security: 0 });
  });

  it("shares one updates.list call between concurrent checks", async () => {
    let release: (outcome: ToolOutcome) => void = () => {};
    const h = harness([() => new Promise<ToolOutcome>((resolve) => (release = resolve))]);
    const first = h.monitor.check();
    const second = h.monitor.check();
    release(listing([true]));
    await expect(first).resolves.toMatchObject({ count: 1, security: 1 });
    await expect(second).resolves.toMatchObject({ count: 1, security: 1 });
    expect(h.lists()).toBe(1);
  });

  it("rejects with the tool's code, or failed for an unreadable answer, and keeps the last summary", async () => {
    const h = harness([
      listing([false]),
      {
        ok: false,
        data: { code: "not_found", message: "no tool updates.list" },
        text: "",
        code: "not_found",
      },
      { ok: true, data: { nothing: true }, text: "{}" },
    ]);
    await h.monitor.check();
    const missing = await h.monitor.check().catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(UpdatesCheckError);
    expect(missing).toMatchObject({ code: "not_found", message: "no tool updates.list" });
    await expect(h.monitor.check()).rejects.toMatchObject({ code: "failed" });
    expect(h.monitor.current()).toMatchObject({ count: 1 });
  });

  it("does nothing after stop, even for a check that was already running", async () => {
    let release: (outcome: ToolOutcome) => void = () => {};
    const h = harness([() => new Promise<ToolOutcome>((resolve) => (release = resolve))]);
    h.monitor.start();
    const running = h.monitor.check();
    h.monitor.stop();
    expect(h.timeouts.size).toBe(0);
    release(listing([true]));
    await running;
    expect(h.changes).toEqual([]);
  });
});
