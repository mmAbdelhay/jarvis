// packages/desktop/src/daemon/os/updates-monitor.ts
// sys:snapshot.updates (M2 contracts §2): jarvis-pkg's updates.list 2 min
// after start, then again whenever the last good check is a day old, and on
// demand (updates:check, and after updates.apply ran). The day is measured
// on the wall clock at an hourly tick, because Node's interval timers stop
// while the laptop sleeps; the same tick retries a failed check after an hour.
// Concurrent checks share one call.
//
// No electron here (core/no-electron.test.ts).
import {
  AGENT_TEXT,
  isRecord,
  NO_UPDATES_YET,
  parseUpdatesList,
  type ToolOutcome,
  type UpdatesSummary,
} from "@jarvis/core";

export const UPDATES_FIRST_CHECK_MS = 120_000;
export const UPDATES_TICK_MS = 3_600_000;
export const UPDATES_MAX_AGE_MS = 86_400_000;
const MAX_MESSAGE_CHARS = 300;

export class UpdatesCheckError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UpdatesCheckError";
  }
}

export type UpdatesMonitor = {
  start(): void;
  stop(): void;
  check(): Promise<UpdatesSummary>;
  current(): UpdatesSummary;
};

function failureText(outcome: ToolOutcome): string {
  const message = isRecord(outcome.data) ? outcome.data["message"] : undefined;
  const text = typeof message === "string" && message !== "" ? message : outcome.text;
  return (text === "" ? AGENT_TEXT.updatesListFailed : text).slice(0, MAX_MESSAGE_CHARS);
}

export function createUpdatesMonitor(deps: {
  list(): Promise<ToolOutcome>;
  onChange(summary: UpdatesSummary): void;
  now(): number;
  timers: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  log(line: string): void;
}): UpdatesMonitor {
  let current: UpdatesSummary = { ...NO_UPDATES_YET };
  let lastSuccess: number | undefined;
  let inflight: Promise<UpdatesSummary> | undefined;
  let first: unknown;
  let tick: unknown;
  let stopped = false;

  function check(): Promise<UpdatesSummary> {
    if (inflight !== undefined) return inflight;
    inflight = (async () => {
      const outcome = await deps.list();
      if (!outcome.ok) throw new UpdatesCheckError(outcome.code ?? "failed", failureText(outcome));
      const summary = parseUpdatesList(outcome.data, deps.now());
      if (summary === undefined) {
        throw new UpdatesCheckError("failed", AGENT_TEXT.updatesListUnreadable);
      }
      lastSuccess = deps.now();
      current = summary;
      if (!stopped) deps.onChange(summary);
      return summary;
    })().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  function scheduled(): void {
    if (stopped) return;
    if (lastSuccess !== undefined && deps.now() - lastSuccess < UPDATES_MAX_AGE_MS) return;
    check().catch((error: unknown) => {
      deps.log(`[updates] check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return {
    start() {
      first = deps.timers.setTimeout(() => {
        first = undefined;
        scheduled();
        if (!stopped) tick = deps.timers.setInterval(scheduled, UPDATES_TICK_MS);
      }, UPDATES_FIRST_CHECK_MS);
    },
    stop() {
      stopped = true;
      if (first !== undefined) deps.timers.clearTimeout(first);
      if (tick !== undefined) deps.timers.clearInterval(tick);
      first = undefined;
      tick = undefined;
    },
    check,
    current: () => current,
  };
}
