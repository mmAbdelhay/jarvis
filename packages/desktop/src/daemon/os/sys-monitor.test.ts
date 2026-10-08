import type { SysSnapshot } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { createSysMonitor, SYS_SNAPSHOT_INTERVAL_MS } from "./sys-monitor.js";

const snapshot = (online: boolean): SysSnapshot => ({
  online,
  network: { connectivity: online ? "full" : "none", wifiSsid: null },
  memTotalBytes: 1,
  memUsedBytes: 1,
  disk: { mount: "/", sizeBytes: 1, usedBytes: 1 },
  failedUnits: [],
  model: null,
  updates: { count: 0, security: 0, checkedAt: null },
  locked: false,
  voice: { available: false, stt: null, tts: null, speak: false },
  undo: { available: false, title: null },
});

describe("createSysMonitor", () => {
  it("pushes at start and on every 10 s tick; refresh pushes only on change", async () => {
    const answers = [snapshot(true), snapshot(true), snapshot(true), snapshot(false)];
    const pushed: SysSnapshot[] = [];
    let tick: () => void = () => {};
    let interval = 0;
    const monitor = createSysMonitor({
      collect: async () => answers.shift() ?? snapshot(false),
      push: (s) => pushed.push(s),
      timers: {
        setInterval: (callback, ms) => {
          tick = callback;
          interval = ms;
          return 1;
        },
        clearInterval: () => {},
      },
      log: () => {},
    });
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(interval).toBe(SYS_SNAPSHOT_INTERVAL_MS);
    expect(pushed).toHaveLength(1);
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushed).toHaveLength(2);
    await monitor.refresh(); // same as last: no push
    expect(pushed).toHaveLength(2);
    await monitor.refresh(); // went offline: pushed
    expect(pushed.at(-1)?.online).toBe(false);
    expect(monitor.current()?.online).toBe(false);
  });

  it("logs a failed collection and keeps the last snapshot", async () => {
    const lines: string[] = [];
    const monitor = createSysMonitor({
      collect: async () => {
        throw new Error("jarvis-diag gone");
      },
      push: () => {},
      timers: { setInterval: () => 1, clearInterval: () => {} },
      log: (line) => lines.push(line),
    });
    await monitor.refresh();
    expect(lines.join("\n")).toContain("jarvis-diag gone");
    expect(monitor.current()).toBeUndefined();
  });
  it("collects again after a refresh that arrived during a collection, and pushes the change", async () => {
    let release: (s: SysSnapshot) => void = () => {};
    const answers: Array<() => Promise<SysSnapshot>> = [
      () => new Promise<SysSnapshot>((resolve) => (release = resolve)),
      async () => snapshot(false),
    ];
    const pushed: SysSnapshot[] = [];
    const monitor = createSysMonitor({
      collect: () => (answers.shift() ?? (async () => snapshot(false)))(),
      push: (s) => pushed.push(s),
      timers: { setInterval: () => 1, clearInterval: () => {} },
      log: () => {},
    });
    const first = monitor.refresh();
    const second = monitor.refresh(); // arrives mid-collection
    release(snapshot(true));
    await Promise.all([first, second]);
    expect(answers).toHaveLength(0);
    expect(pushed.map((s) => s.online)).toEqual([true, false]);
  });
});
