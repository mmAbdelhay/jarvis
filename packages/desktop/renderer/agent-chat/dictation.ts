// The renderer's side of dictation: one recording per pane, kept alive while
// it runs, and handed to `deliver` as text when it ends. It never sends
// anything and never reaches a pty; the words only ever go to the composer.
import type { DictationFinish, DictationKeep, DictationStart } from "../../src/dictation.js";

export type DictationApi = {
  start(): Promise<DictationStart>;
  keep(id: string): Promise<DictationKeep>;
  finish(id: string): Promise<DictationFinish>;
  cancel(id: string): Promise<{ ok: boolean }>;
};

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

/** How often the lease is renewed while recording. */
export const KEEP_EVERY_TICKS = 5;

/** 0:07, 1:05, 12:30. */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export type DictationControl = {
  state(): DictationState;
  elapsed(): number;
  /** Idle starts; recording finishes; anything else is ignored. */
  toggle(): void;
  finish(): void;
  /** Ends a start, a recording or a transcription; its text is dropped. */
  cancel(): void;
  /** The pane is going: a recording ends, a transcription still delivers. */
  detach(): void;
};

export function createDictationControl(options: {
  api: DictationApi;
  schedule(fn: () => void, ms: number): () => void;
  now(): number;
  deliver(text: string): void;
  changed(): void;
  announce(what: "started" | "writing" | "inserted" | "none"): void;
  fail(reason: "busy" | "silence" | "failed"): void;
}): DictationControl {
  const { api } = options;
  let state: DictationState = "idle";
  let id: string | undefined;
  let startedAt = 0;
  let ticks = 0;
  /** Bumped by every end, so an answer for an older run is recognised. */
  let run = 0;
  let cancelTick: (() => void) | undefined;

  function stopTicking(): void {
    cancelTick?.();
    cancelTick = undefined;
  }

  function tick(): void {
    cancelTick = options.schedule(() => {
      cancelTick = undefined;
      if (state !== "recording") return;
      ticks += 1;
      options.changed();
      if (ticks % KEEP_EVERY_TICKS === 0) void keepAlive();
      tick();
    }, 1000);
  }

  async function keepAlive(): Promise<void> {
    const mine = run;
    const current = id;
    if (current === undefined) return;
    let answer: DictationKeep;
    try {
      answer = await api.keep(current);
    } catch {
      // A missed renewal is not an end; the lease has slack for a few.
      return;
    }
    if (mine !== run || state !== "recording") return;
    if (!answer.ok) {
      run += 1;
      stopTicking();
      state = "idle";
      id = undefined;
      options.announce("none");
      options.changed();
      options.fail("failed");
      return;
    }
    if (answer.capped === true) finish();
  }

  async function start(): Promise<void> {
    const mine = ++run;
    state = "starting";
    options.changed();
    let answer: DictationStart;
    try {
      answer = await api.start();
    } catch {
      answer = { ok: false, reason: "failed" };
    }
    if (mine !== run) {
      // Cancelled or destroyed while the answer was on its way.
      if (answer.ok) void api.cancel(answer.id).catch(() => undefined);
      return;
    }
    if (!answer.ok) {
      state = "idle";
      options.changed();
      options.fail(answer.reason);
      return;
    }
    id = answer.id;
    startedAt = options.now();
    ticks = 0;
    state = "recording";
    options.announce("started");
    options.changed();
    tick();
  }

  function finish(): void {
    const current = id;
    if (state !== "recording" || current === undefined) return;
    const mine = ++run;
    stopTicking();
    state = "transcribing";
    options.announce("writing");
    options.changed();
    void (async () => {
      let answer: DictationFinish;
      try {
        answer = await api.finish(current);
      } catch {
        answer = { ok: false, reason: "failed" };
      }
      if (mine !== run) return;
      state = "idle";
      id = undefined;
      if (answer.ok) {
        options.announce("inserted");
        options.changed();
        options.deliver(answer.text);
        return;
      }
      options.announce("none");
      options.changed();
      // "gone" is not silence: the words are lost, so it says so (a cancel never gets here).
      options.fail(answer.reason === "gone" ? "failed" : answer.reason);
    })();
  }

  function cancel(): void {
    if (state === "idle") return;
    run += 1;
    stopTicking();
    const current = id;
    state = "idle";
    id = undefined;
    options.announce("none");
    options.changed();
    if (current !== undefined) void api.cancel(current).catch(() => undefined);
  }

  return {
    state: () => state,
    elapsed: () => (state === "recording" ? options.now() - startedAt : 0),
    toggle() {
      if (state === "idle") void start();
      else if (state === "recording") finish();
    },
    finish,
    cancel,
    detach() {
      if (state === "starting" || state === "recording") cancel();
    },
  };
}
