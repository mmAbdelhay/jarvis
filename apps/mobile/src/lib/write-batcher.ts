// Batches writes bound for the terminal WebView (Task 6, task-6-brief.md
// rule 6). Terminal output can arrive in a tight loop of tiny chunks; this
// coalesces them into one `postMessage` every `WRITE_BATCH_MS`, and caps
// any single flush at `WRITE_BATCH_MAX_CHARS` so one giant write doesn't
// block the bridge or exceed the WebView message size.

import type { Clock } from "./clock";

export const WRITE_BATCH_MS = 16;
export const WRITE_BATCH_MAX_CHARS = 65_536;

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

/** The largest prefix of `text` no longer than `max` UTF-16 units that
 * never splits a surrogate pair across its boundary. */
function chunkBoundary(text: string, max: number): number {
  if (text.length <= max) {
    return text.length;
  }
  const before = text.charCodeAt(max - 1);
  const after = text.charCodeAt(max);
  if (
    before >= HIGH_SURROGATE_MIN &&
    before <= HIGH_SURROGATE_MAX &&
    after >= LOW_SURROGATE_MIN &&
    after <= LOW_SURROGATE_MAX
  ) {
    return max - 1;
  }
  return max;
}

export function createWriteBatcher(deps: { clock: Clock; flush(data: string): void }): {
  write(data: string): void;
  flushNow(): void;
  clear(): void;
  dispose(): void;
} {
  let pending = "";
  let timer: unknown;

  function disarmTimer(): void {
    if (timer !== undefined) {
      deps.clock.clearTimeout(timer);
      timer = undefined;
    }
  }

  function armTimer(): void {
    if (timer !== undefined) {
      return;
    }
    timer = deps.clock.setTimeout(() => {
      timer = undefined;
      flushNow();
    }, WRITE_BATCH_MS);
  }

  function drainFull(): void {
    while (pending.length >= WRITE_BATCH_MAX_CHARS) {
      const cut = chunkBoundary(pending, WRITE_BATCH_MAX_CHARS);
      const chunk = pending.slice(0, cut);
      pending = pending.slice(cut);
      deps.flush(chunk);
    }
  }

  function write(data: string): void {
    pending += data;
    drainFull();
    if (pending.length > 0) {
      armTimer();
    }
  }

  function flushNow(): void {
    disarmTimer();
    if (pending.length === 0) {
      return;
    }
    const data = pending;
    pending = "";
    deps.flush(data);
  }

  function clear(): void {
    disarmTimer();
    pending = "";
  }

  function dispose(): void {
    clear();
  }

  return { write, flushNow, clear, dispose };
}
