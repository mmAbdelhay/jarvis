// jarvisd's graceful stop, for SIGTERM/SIGINT (launchd, systemd, Ctrl+C)
// and daemon:stop (Windows, where there is no signal to send).
//
// The order:
//   1. the core (Core.shutdown): the remote bridge and its web listener,
//      awaited; then the sidecars; then the ptys; then the in-flight writes;
//   2. the control server, which also releases the single-instance lock —
//      last, so a new daemon can't start while this one's children still run;
//   3. exit 0: a stop that was asked for is a success, so launchd's
//      KeepAlive {SuccessfulExit: false} and systemd's Restart=on-failure
//      leave it stopped. A restart exits DAEMON_EXIT.restart instead, which
//      they answer by starting it again.
//
// A step that throws or hangs is logged and the next one still runs: a
// daemon asked to stop must stop. Idempotent — a second signal while
// stopping changes nothing.
//
// No electron here (core/no-electron.test.ts).

/** How long the core gets to stop before the daemon moves on without it. */
export const CORE_STOP_TIMEOUT_MS = 10_000;

export type ShutdownSteps = {
  stopCore(): Promise<void>;
  closeControl(): Promise<void>;
  exit(code: number): void;
  log(line: string): void;
  timers: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
};

export type Shutdown = {
  /** Starts the stop (once) and resolves when it has exited — with
   *  `exitCode`, 0 unless this is a restart. */
  stop(reason: string, exitCode?: number): Promise<void>;
  readonly stopping: boolean;
};

export function createShutdown(steps: ShutdownSteps): Shutdown {
  let running: Promise<void> | undefined;

  async function step(name: string, run: () => Promise<void>, timeoutMs?: number): Promise<void> {
    let timer: unknown;
    try {
      const timeout =
        timeoutMs === undefined
          ? undefined
          : new Promise<void>((resolve) => {
              timer = steps.timers.setTimeout(() => {
                steps.log(`[shutdown] ${name} did not finish in ${timeoutMs} ms; going on`);
                resolve();
              }, timeoutMs);
            });
      await (timeout === undefined ? run() : Promise.race([run(), timeout]));
    } catch (error) {
      steps.log(
        `[shutdown] ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (timer !== undefined) steps.timers.clearTimeout(timer);
    }
  }

  return {
    stop(reason, exitCode = 0) {
      running ??= (async () => {
        steps.log(`stopping (${reason})`);
        await step("core", steps.stopCore, CORE_STOP_TIMEOUT_MS);
        await step("control socket", steps.closeControl);
        steps.log("stopped");
        steps.exit(exitCode);
      })();
      return running;
    },
    get stopping() {
      return running !== undefined;
    },
  };
}
