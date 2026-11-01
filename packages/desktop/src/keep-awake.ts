// Keep awake (Task 18): keeps the screen on and the machine running while
// Jarvis wants it to — always, or only while a Terminal pane has an agent in
// its foreground — replacing a "press Shift when idle" script.
//
// The primary means is the OS stay-awake (Electron's powerSaveBlocker,
// "prevent-display-sleep"), which only the desktop app holds: this module is
// the core's, so it imports no electron (core/no-electron.test.ts) and asks
// for the blocker through `setBlocker` (DesktopHost.setStayAwake). The
// opt-in fallback, for a machine where the OS stay-awake is not enough,
// presses and releases Shift once whenever the user has been idle for
// `idleSeconds` — macOS only, through System Events, which needs the
// Accessibility permission; a failed press stops the fallback until it is
// toggled again or Jarvis restarts. Every input here is injected, so the
// whole state machine is tested with fake timers.

import type { ExternalAgentProcess, ShellManager } from "@jarvis/platform";
import type { AwakeConfig, AwakeMode } from "./config.js";

export const AWAKE_MODES: readonly AwakeMode[] = ["off", "on", "agents"];

/** Lives here, not in config.ts, so dispatch.ts can check an awake:set
 *  argument without loading config.ts (which reads HOME at import). */
export function isAwakeMode(value: unknown): value is AwakeMode {
  return typeof value === "string" && (AWAKE_MODES as readonly string[]).includes(value);
}

/** How often agents mode looks at the process table again. */
export const AWAKE_RECHECK_MS = 30_000;
/** Quiet time after a shell starts or exits before the re-check. */
export const AWAKE_DEBOUNCE_MS = 500;
/** The fallback never re-reads the idle clock sooner than this. */
const MIN_IDLE_WAIT_MS = 1_000;

export type AwakeReason = "off" | "on" | "agent-running" | "no-agent";
export type AwakeInputState = "idle" | "ok" | "needs-permission" | "unsupported";

/** awake:status — what the stay-awake is doing now. */
export type AwakeStatus = {
  mode: AwakeMode;
  /** The OS stay-awake is wanted (and held by every attached app). */
  active: boolean;
  reason: AwakeReason;
  simulateInput: boolean;
  inputState: AwakeInputState;
};

/** awake:set — what a client may change. idleSeconds is Settings' only. */
export type AwakePatch = { mode?: AwakeMode; simulateInput?: boolean };

export type KeepAwakeDeps = {
  /** The `awake:` section, read live. */
  config(): AwakeConfig;
  /** Writes `patch` into jarvis.yaml (the core's serialized writer). */
  saveConfig(patch: AwakePatch): Promise<void>;
  /** Hold (true) or release (false) the OS stay-awake. Called on change only. */
  setBlocker(on: boolean): void;
  platform: string;
  shells: Pick<ShellManager, "panes" | "onOutput" | "onShellExit">;
  /** A fresh process scan (process-scan.ts listAgentProcesses). */
  scanAgents(): Promise<readonly ExternalAgentProcess[]>;
  /** Seconds since the user's last keyboard or mouse input. */
  idleSeconds(): Promise<number>;
  /** Presses and releases Shift once; rejects when it could not. */
  pressShift(): Promise<void>;
  schedule(fn: () => void, ms: number): () => void;
  interval(fn: () => void, ms: number): () => void;
};

export type KeepAwake = {
  /** Subscribes to shell starts and exits, starts the re-check timer and
   *  applies the current config. */
  start(): void;
  status(): AwakeStatus;
  /** Saves `patch` and applies it; answers the status after. */
  set(patch: AwakePatch): Promise<AwakeStatus>;
  /** The config may have changed (a Settings save): apply it again. */
  refresh(): void;
  /** Resolves once no scan is running or queued. */
  whenIdle(): Promise<void>;
  onChanged(listener: (status: AwakeStatus) => void): () => void;
  /** Releases the blocker and every timer and subscription. Final. */
  dispose(): void;
};

export function createKeepAwake(deps: KeepAwakeDeps): KeepAwake {
  const listeners = new Set<(status: AwakeStatus) => void>();
  const unsubscribers: Array<() => void> = [];
  const seenPanes = new Set<string>();
  const darwin = deps.platform === "darwin";
  let disposed = false;
  let agentRunning = false;
  // Whether agentRunning answers for agents mode yet: false until the first
  // scan in agents mode, so switching into it (on → agents) holds the
  // blocker as it is rather than dropping it for a "no-agent" that only
  // means "not looked yet".
  let agentsScanned = false;
  let blockerOn = false;
  let lastSent: string | undefined;
  // The fallback: whether the last press worked, whether one failed (sticky
  // until simulateInput is toggled), and the setting it was last armed with.
  let pressedOk = false;
  let pressFailed = false;
  let armedFor: string | undefined;
  let cancelTick: (() => void) | undefined;
  let tickGeneration = 0;
  let lastSimulate = deps.config().simulateInput;
  let cancelEvery: (() => void) | undefined;
  let cancelDebounce: (() => void) | undefined;
  let running: Promise<void> | undefined;
  let rerun = false;

  function reasonOf(config: AwakeConfig): AwakeReason {
    if (config.mode === "off") return "off";
    if (config.mode === "on") return "on";
    return agentRunning ? "agent-running" : "no-agent";
  }

  function status(): AwakeStatus {
    const config = deps.config();
    const reason = reasonOf(config);
    let inputState: AwakeInputState = "idle";
    if (!darwin) inputState = "unsupported";
    else if (pressFailed) inputState = "needs-permission";
    else if (pressedOk) inputState = "ok";
    return {
      mode: config.mode,
      active: reason === "on" || reason === "agent-running",
      reason,
      simulateInput: config.simulateInput,
      inputState,
    };
  }

  function emitIfChanged(): void {
    const next = status();
    const key = JSON.stringify(next);
    if (key === lastSent) return;
    lastSent = key;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (error) {
        console.error(`awake: listener failed: ${String(error)}`);
      }
    }
  }

  function disarm(): void {
    tickGeneration++;
    cancelTick?.();
    cancelTick = undefined;
    armedFor = undefined;
  }

  function scheduleTick(ms: number): void {
    const generation = tickGeneration;
    cancelTick?.();
    cancelTick = deps.schedule(() => {
      cancelTick = undefined;
      if (generation === tickGeneration) void tick(generation);
    }, ms);
  }

  async function tick(generation: number): Promise<void> {
    const threshold = deps.config().idleSeconds;
    let idle: number;
    try {
      idle = await deps.idleSeconds();
    } catch {
      if (generation === tickGeneration) scheduleTick(threshold * 1000);
      return;
    }
    if (generation !== tickGeneration) return;
    if (idle < threshold) {
      scheduleTick(Math.max(MIN_IDLE_WAIT_MS, Math.ceil((threshold - idle) * 1000)));
      return;
    }
    try {
      await deps.pressShift();
    } catch (error) {
      if (generation !== tickGeneration) return;
      pressFailed = true;
      pressedOk = false;
      disarm();
      console.error(`awake: simulated input failed, stopping: ${String(error)}`);
      emitIfChanged();
      return;
    }
    if (generation !== tickGeneration) return;
    pressedOk = true;
    emitIfChanged();
    scheduleTick(threshold * 1000);
  }

  /** Applies the config and the last scan to the blocker and the fallback. */
  function apply(): void {
    if (disposed) return;
    const config = deps.config();
    if (config.simulateInput !== lastSimulate) {
      // A toggle is the user trying again: forget the last outcome.
      lastSimulate = config.simulateInput;
      pressFailed = false;
      pressedOk = false;
    }
    if (config.mode === "agents" && !agentsScanned) return; // check() applies.
    const current = status();
    if (current.active !== blockerOn) {
      blockerOn = current.active;
      deps.setBlocker(blockerOn);
    }
    const wantFallback = current.active && config.simulateInput && darwin && !pressFailed;
    if (!wantFallback) {
      if (armedFor !== undefined) disarm();
    } else {
      const key = String(config.idleSeconds);
      if (armedFor !== key) {
        disarm();
        armedFor = key;
        scheduleTick(0);
      }
    }
    emitIfChanged();
  }

  async function scanOnce(): Promise<void> {
    if (deps.config().mode !== "agents") {
      agentRunning = false;
      agentsScanned = false;
      return;
    }
    const live = new Set(
      deps.shells
        .panes()
        .filter((pane) => !pane.exited)
        .map((pane) => pane.paneKey),
    );
    if (live.size === 0) {
      agentRunning = false;
      agentsScanned = true;
      return;
    }
    let rows: readonly ExternalAgentProcess[];
    try {
      rows = await deps.scanAgents();
    } catch {
      agentsScanned = true;
      return; // The last answer stands until a scan succeeds.
    }
    agentsScanned = true;
    agentRunning = rows.some(
      (row) =>
        row.foreground === true &&
        row.terminalPaneKey !== undefined &&
        live.has(row.terminalPaneKey),
    );
  }

  /** One scan at a time; a request during one runs once more after it. */
  function check(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (running !== undefined) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await scanOnce();
          apply();
        } while (rerun && !disposed);
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  function checkSoon(): void {
    if (disposed) return;
    cancelDebounce?.();
    cancelDebounce = deps.schedule(() => {
      cancelDebounce = undefined;
      void check();
    }, AWAKE_DEBOUNCE_MS);
  }

  return {
    start() {
      if (disposed) return;
      // Pushes say what changed since start, not the starting state.
      lastSent = JSON.stringify(status());
      unsubscribers.push(
        deps.shells.onShellExit(({ paneKey }) => {
          seenPanes.delete(paneKey);
          checkSoon();
        }),
        deps.shells.onOutput(({ paneKey }) => {
          if (seenPanes.has(paneKey)) return;
          seenPanes.add(paneKey);
          checkSoon();
        }),
      );
      cancelEvery = deps.interval(() => void check(), AWAKE_RECHECK_MS);
      apply();
      void check();
    },
    status,
    async set(patch) {
      await deps.saveConfig(patch);
      apply();
      await check();
      return status();
    },
    refresh() {
      apply();
      void check();
    },
    async whenIdle() {
      while (running !== undefined) await running;
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disarm();
      cancelEvery?.();
      cancelEvery = undefined;
      cancelDebounce?.();
      cancelDebounce = undefined;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      listeners.clear();
      if (blockerOn) {
        blockerOn = false;
        deps.setBlocker(false);
      }
    },
  };
}

/** The slice of Electron's powerSaveBlocker this uses. */
export type PowerSaveBlockerApi = {
  start(type: "prevent-display-sleep"): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
};

/** One OS stay-awake at most, for the desktop app (main.ts): `set(true)`
 *  starts one unless the one it holds is still started, `set(false)` stops
 *  it. Electron-free, so the rule is testable. */
export function createPowerBlocker(api: PowerSaveBlockerApi): { set(on: boolean): void } {
  let id: number | undefined;
  return {
    set(on) {
      if (on) {
        if (id !== undefined && api.isStarted(id)) return;
        id = api.start("prevent-display-sleep");
        return;
      }
      if (id === undefined) return;
      if (api.isStarted(id)) api.stop(id);
      id = undefined;
    },
  };
}

/** `ioreg -c IOHIDSystem`'s HIDIdleTime (nanoseconds) as seconds. */
export function parseHidIdleSeconds(stdout: string): number | undefined {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout);
  if (match?.[1] === undefined) return undefined;
  return Number(match[1]) / 1e9;
}

/** The fallback's one key press: Shift (key code 56), down and up — no
 *  character is typed. Run with execFile semantics, never a shell. */
export const PRESS_SHIFT_COMMAND = {
  file: "osascript",
  args: ["-e", 'tell application "System Events" to key code 56'],
} as const;

/** The macOS idle-clock read, for the core (no electron there). `-d 4` is
 *  load-bearing: it keeps the output to IOHIDSystem's own entry, whose
 *  HIDIdleTime is the first one parseHidIdleSeconds matches. */
export const IDLE_TIME_COMMAND = {
  file: "ioreg",
  args: ["-c", "IOHIDSystem", "-d", "4", "-r", "-k", "HIDIdleTime"],
} as const;
