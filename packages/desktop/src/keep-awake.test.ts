import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AWAKE, type AwakeConfig } from "./config.js";
import {
  AWAKE_RECHECK_MS,
  createKeepAwake,
  createPowerBlocker,
  parseHidIdleSeconds,
  type AwakeStatus,
  type KeepAwakeDeps,
} from "./keep-awake.js";

type Pane = { paneKey: string; exited: boolean };
type Row = { terminalPaneKey?: string; foreground?: boolean };

function harness(options: { config?: Partial<AwakeConfig>; platform?: string } = {}) {
  let config: AwakeConfig = { ...DEFAULT_AWAKE, ...options.config };
  let panes: Pane[] = [];
  let rows: Row[] = [];
  let idle = 0;
  const exitListeners = new Set<(exit: { paneKey: string; code: number }) => void>();
  const outputListeners = new Set<(output: { paneKey: string; chunk: string }) => void>();
  const blocker: boolean[] = [];
  const pressShift = vi.fn<() => Promise<void>>(async () => {
    idle = 0;
  });
  const scanAgents = vi.fn(async () => rows);
  const deps: KeepAwakeDeps = {
    config: () => config,
    saveConfig: vi.fn(async (patch) => {
      config = { ...config, ...patch };
    }),
    setBlocker: (on) => blocker.push(on),
    platform: options.platform ?? "darwin",
    shells: {
      panes: () => panes as never,
      onShellExit: (listener) => {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      onOutput: (listener) => {
        outputListeners.add(listener as never);
        return () => outputListeners.delete(listener as never);
      },
    },
    scanAgents: scanAgents as never,
    idleSeconds: async () => idle,
    pressShift,
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    interval: (fn, ms) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
  };
  const awake = createKeepAwake(deps);
  const changes: AwakeStatus[] = [];
  awake.onChanged((status) => changes.push(status));
  return {
    awake,
    deps,
    blocker,
    pressShift,
    scanAgents,
    changes,
    setConfig(patch: Partial<AwakeConfig>) {
      config = { ...config, ...patch };
    },
    setPanes(next: Pane[]) {
      panes = next;
    },
    setRows(next: Row[]) {
      rows = next;
    },
    setIdle(seconds: number) {
      idle = seconds;
    },
    exit(paneKey: string) {
      for (const listener of [...exitListeners]) listener({ paneKey, code: 0 });
    },
    output(paneKey: string) {
      for (const listener of [...outputListeners]) listener({ paneKey, chunk: "x" });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("keep awake: the system stay-awake", () => {
  it("holds no blocker when off", async () => {
    const h = harness();
    h.awake.start();
    await h.awake.whenIdle();
    expect(h.blocker).toEqual([]);
    expect(h.awake.status()).toEqual({
      mode: "off",
      active: false,
      reason: "off",
      simulateInput: false,
      inputState: "idle",
    });
  });

  it("holds exactly one blocker when on", async () => {
    const h = harness({ config: { mode: "on" } });
    h.awake.start();
    h.awake.refresh();
    await h.awake.whenIdle();
    expect(h.blocker).toEqual([true]);
    expect(h.awake.status()).toMatchObject({ mode: "on", active: true, reason: "on" });
  });

  it("follows the scan in agents mode: starts when a foreground agent appears, stops when gone", async () => {
    const h = harness({ config: { mode: "agents" } });
    h.setPanes([{ paneKey: "t1", exited: false }]);
    h.awake.start();
    await h.awake.whenIdle();
    expect(h.awake.status().reason).toBe("no-agent");
    expect(h.blocker).toEqual([]);

    // A background job in the pane is not an agent at the prompt.
    h.setRows([{ terminalPaneKey: "t1", foreground: false }]);
    await vi.advanceTimersByTimeAsync(AWAKE_RECHECK_MS);
    expect(h.blocker).toEqual([]);

    h.setRows([{ terminalPaneKey: "t1", foreground: true }]);
    await vi.advanceTimersByTimeAsync(AWAKE_RECHECK_MS);
    expect(h.awake.status()).toMatchObject({ active: true, reason: "agent-running" });
    expect(h.blocker).toEqual([true]);
    expect(h.changes.at(-1)?.reason).toBe("agent-running");

    h.setRows([]);
    h.exit("t1");
    await vi.advanceTimersByTimeAsync(1000);
    await h.awake.whenIdle();
    expect(h.blocker).toEqual([true, false]);
    expect(h.awake.status().reason).toBe("no-agent");
  });

  it("never scans when no pane exists", async () => {
    const h = harness({ config: { mode: "agents" } });
    h.setRows([{ terminalPaneKey: "t1", foreground: true }]);
    h.awake.start();
    await vi.advanceTimersByTimeAsync(AWAKE_RECHECK_MS * 3);
    expect(h.scanAgents).not.toHaveBeenCalled();
    expect(h.awake.status().active).toBe(false);
  });

  it("checks again when a shell starts (its first output)", async () => {
    const h = harness({ config: { mode: "agents" } });
    h.awake.start();
    await h.awake.whenIdle();
    h.setPanes([{ paneKey: "t2", exited: false }]);
    h.setRows([{ terminalPaneKey: "t2", foreground: true }]);
    h.output("t2");
    await vi.advanceTimersByTimeAsync(1000);
    await h.awake.whenIdle();
    expect(h.awake.status().active).toBe(true);
  });

  it("ignores an agent in an exited pane or in no pane", async () => {
    const h = harness({ config: { mode: "agents" } });
    h.setPanes([
      { paneKey: "t1", exited: true },
      { paneKey: "t2", exited: false },
    ]);
    h.setRows([{ terminalPaneKey: "t1", foreground: true }, { foreground: true }]);
    h.awake.start();
    await h.awake.whenIdle();
    expect(h.awake.status().active).toBe(false);
  });

  it("applies a mode change live and saves it", async () => {
    const h = harness();
    h.awake.start();
    await h.awake.whenIdle();
    const status = await h.awake.set({ mode: "on" });
    expect(h.deps.saveConfig).toHaveBeenCalledWith({ mode: "on" });
    expect(status.active).toBe(true);
    expect(h.blocker).toEqual([true]);
    await h.awake.set({ mode: "off" });
    expect(h.blocker).toEqual([true, false]);
    expect(h.changes.map((c) => c.mode)).toEqual(["on", "off"]);
  });

  it("picks up a config written elsewhere (a Settings save) on refresh", async () => {
    const h = harness();
    h.awake.start();
    h.setConfig({ mode: "on" });
    h.awake.refresh();
    await h.awake.whenIdle();
    expect(h.blocker).toEqual([true]);
  });

  it("stops the blocker on dispose, and does nothing after", async () => {
    const h = harness({ config: { mode: "on" } });
    h.awake.start();
    await h.awake.whenIdle();
    h.awake.dispose();
    expect(h.blocker).toEqual([true, false]);
    h.awake.refresh();
    await vi.advanceTimersByTimeAsync(AWAKE_RECHECK_MS);
    expect(h.blocker).toEqual([true, false]);
  });

  it("emits only when the status actually changes", async () => {
    const h = harness({ config: { mode: "on" } });
    h.awake.start();
    await h.awake.whenIdle();
    const before = h.changes.length;
    h.awake.refresh();
    h.awake.refresh();
    await h.awake.whenIdle();
    expect(h.changes.length).toBe(before);
  });
});

describe("keep awake: the simulated-input fallback", () => {
  const fallback = { mode: "on" as const, simulateInput: true, idleSeconds: 240 };

  it("does not press while the user is active", async () => {
    const h = harness({ config: fallback });
    h.setIdle(10);
    h.awake.start();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(h.pressShift).not.toHaveBeenCalled();
    expect(h.awake.status().inputState).toBe("idle");
  });

  it("presses once at the threshold, and not again until it passes again", async () => {
    const h = harness({ config: fallback });
    h.setIdle(240);
    h.awake.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pressShift).toHaveBeenCalledTimes(1);
    expect(h.awake.status().inputState).toBe("ok");
    // The press reset the idle clock; the user then stays away 239 s.
    await vi.advanceTimersByTimeAsync(239_000);
    expect(h.pressShift).toHaveBeenCalledTimes(1);
    h.setIdle(240);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.pressShift).toHaveBeenCalledTimes(2);
  });

  it("never presses unless the stay-awake is wanted", async () => {
    const h = harness({ config: { ...fallback, mode: "off" } });
    h.setIdle(10_000);
    h.awake.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.pressShift).not.toHaveBeenCalled();
  });

  it("never presses with simulateInput off", async () => {
    const h = harness({ config: { ...fallback, simulateInput: false } });
    h.setIdle(10_000);
    h.awake.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.pressShift).not.toHaveBeenCalled();
  });

  it("a failed press means needs-permission and no further presses, until toggled", async () => {
    const h = harness({ config: fallback });
    h.pressShift.mockRejectedValue(new Error("not allowed assistive access"));
    h.setIdle(10_000);
    h.awake.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.awake.status().inputState).toBe("needs-permission");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.pressShift).toHaveBeenCalledTimes(1);
    expect(h.changes.at(-1)?.inputState).toBe("needs-permission");

    await h.awake.set({ simulateInput: false });
    h.pressShift.mockResolvedValue(undefined);
    await h.awake.set({ simulateInput: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pressShift).toHaveBeenCalledTimes(2);
    expect(h.awake.status().inputState).toBe("ok");
  });

  it("is unsupported off macOS and never runs", async () => {
    const h = harness({ config: fallback, platform: "win32" });
    h.setIdle(10_000);
    h.awake.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.pressShift).not.toHaveBeenCalled();
    expect(h.awake.status().inputState).toBe("unsupported");
    // The stay-awake itself still works there.
    expect(h.awake.status().active).toBe(true);
  });

  it("stops pressing when the stay-awake is no longer wanted", async () => {
    const h = harness({ config: fallback });
    h.setIdle(10_000);
    h.awake.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pressShift).toHaveBeenCalledTimes(1);
    await h.awake.set({ mode: "off" });
    h.setIdle(10_000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.pressShift).toHaveBeenCalledTimes(1);
  });
});

describe("createPowerBlocker", () => {
  function fakeApi() {
    const started = new Set<number>();
    let next = 1;
    return {
      started,
      api: {
        start: vi.fn((_type: "prevent-display-sleep") => {
          const id = next++;
          started.add(id);
          return id;
        }),
        stop: vi.fn((id: number) => {
          started.delete(id);
        }),
        isStarted: (id: number) => started.has(id),
      },
    };
  }

  it("holds at most one prevent-display-sleep blocker", () => {
    const { api, started } = fakeApi();
    const blocker = createPowerBlocker(api);
    blocker.set(true);
    blocker.set(true);
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenCalledWith("prevent-display-sleep");
    expect(started.size).toBe(1);
    blocker.set(false);
    blocker.set(false);
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(started.size).toBe(0);
  });

  it("starts a new one when the old one was stopped from outside", () => {
    const { api, started } = fakeApi();
    const blocker = createPowerBlocker(api);
    blocker.set(true);
    started.clear();
    blocker.set(true);
    expect(api.start).toHaveBeenCalledTimes(2);
  });
});

describe("parseHidIdleSeconds", () => {
  it("reads HIDIdleTime (nanoseconds) as seconds", () => {
    expect(parseHidIdleSeconds('  |   "HIDIdleTime" = 249339239291\n')).toBeCloseTo(249.339, 2);
  });
  it("answers undefined when the key is missing", () => {
    expect(parseHidIdleSeconds("nothing here")).toBeUndefined();
  });
});
