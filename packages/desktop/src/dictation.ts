// Dictation for the agent chat: the microphone to text in the composer, to be
// edited before anything is sent. One recording at a time, shared with the
// voice turn; the wav lives in its own private directory that goes away on
// every path; nothing here ever writes to a pane, and neither the audio nor
// the words are logged (only category tokens).

import { randomBytes } from "node:crypto";
import { Recorder, type RecorderDeps, type RecordingResult } from "./recorder.js";

/** No keep for this long: the window is gone, so the microphone is let go. */
export const DICTATION_LEASE_MS = 15_000;
/** A recording ends by itself after this long. */
export const DICTATION_CAP_MS = 5 * 60_000;
/** After the cap, how long the clip waits for its finish before deletion. */
export const DICTATION_HOLD_MS = 60_000;
/** A stop that has not settled by then fails: the process is killed. */
export const DICTATION_STOP_MS = 5_000;
/** How long disposing waits for the recording process to end before it removes the files. */
const DISPOSE_WAIT_MS = 4_000;
/** The most text one dictation hands back. */
export const DICTATION_MAX_CHARS = 20_000;

export type DictationRecorder = {
  start(): void;
  /** Stops and answers the wav path; rejects when no usable file was made. */
  stop(): Promise<string>;
  /** Releases the microphone now; no result. */
  abort(): void;
  /** Settles when the recording process ends, by itself or by stop/abort. */
  ended: Promise<RecordingResult>;
  /** Removes the private directory. Safe to call again. */
  dispose(): Promise<void>;
};

export type DictationDeps = {
  makeRecorder(): Promise<DictationRecorder>;
  transcribe(wavPath: string): Promise<{ text: string; language: string }>;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  schedule(fn: () => void, ms: number): () => void;
  /** True while the voice turn holds the microphone. */
  busy(): boolean;
  /** Whether `paneKey` is a live pane that runs an agent (as agentSend checks). */
  hostsAgent(paneKey: string): Promise<boolean>;
  log(token: string): void;
  randomId?(): string;
};

export type DictationStart = { ok: true; id: string } | { ok: false; reason: "busy" | "failed" };
export type DictationKeep =
  | { ok: true; capped?: true }
  | { ok: false; reason: "gone" | "failed" | "no-recorder" };
export type DictationFinish =
  | { ok: true; text: string; language: string }
  | { ok: false; reason: "silence" | "failed" | "gone" | "no-recorder" | "no-whisper" };

/** What a transcribe dependency throws when whisper or its model is not there. */
export class WhisperMissingError extends Error {
  readonly missing = true;
  constructor() {
    super("whisper or its model is missing");
    this.name = "WhisperMissingError";
  }
}

const isMissing = (error: unknown): boolean =>
  (error as { missing?: unknown } | null)?.missing === true;

const NON_SPEECH =
  /[[(]\s*(?:blank[_ ]audio|silence|silent|music|noise|background noise|applause|laughter|laughs|laughing|inaudible|no speech|sound|sounds)\s*[\])]/gi;

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what these patterns strip.
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what these patterns strip.
const STRING_SEQUENCE = /\u001b[\]P^_X][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b/g;
const LINE_BREAKS = /[\r\n\t\u2028\u2029]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this pattern strips.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Whisper's text made safe for a text box: no control characters or escape
 *  sequences, newlines as spaces, nothing when it is only non-speech marks. */
export function cleanDictation(raw: string): string {
  let text = raw
    .replace(CSI, "")
    .replace(STRING_SEQUENCE, "")
    .replace(LINE_BREAKS, " ")
    .replace(CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.replace(NON_SPEECH, "").trim() === "") return "";
  if (text.length > DICTATION_MAX_CHARS) {
    text = text.slice(0, DICTATION_MAX_CHARS);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  }
  return text;
}

type Phase = "starting" | "recording" | "stopping" | "stopped" | "transcribing" | "failed";

type Session = {
  id: string;
  phase: Phase;
  recorder?: DictationRecorder;
  path?: string;
  stopping?: Promise<string>;
  stopTimedOut?: boolean;
  /** Why the recording died on its own; kept for keep and finish to report. */
  deathReason?: "no-recorder" | "failed";
  released?: boolean;
  cancelStop?: () => void;
  cancelLease?: () => void;
  cancelCap?: () => void;
  cancelHold?: () => void;
};

export function createDictation(deps: DictationDeps) {
  const newId = deps.randomId ?? (() => randomBytes(24).toString("hex"));
  let current: Session | undefined;
  let disposed = false;

  function clearTimers(session: Session): void {
    session.cancelLease?.();
    session.cancelCap?.();
    session.cancelHold?.();
    session.cancelStop?.();
    session.cancelStop = undefined;
    session.cancelLease = undefined;
    session.cancelCap = undefined;
    session.cancelHold = undefined;
  }

  /** Ends the session on every path: timers, microphone, files, the slot. */
  function release(session: Session): void {
    clearTimers(session);
    if (session.released === true) return;
    session.released = true;
    if (current === session) current = undefined;
    const recorder = session.recorder;
    if (recorder === undefined) return;
    try {
      recorder.abort();
    } catch {
      deps.log("abort");
    }
    void recorder.dispose().catch(() => deps.log("dispose"));
  }

  function armLease(session: Session): void {
    session.cancelLease?.();
    session.cancelLease = deps.schedule(() => {
      deps.log("lease");
      release(session);
    }, DICTATION_LEASE_MS);
  }

  /** One stop, shared by finish and the cap. */
  function stopOnce(session: Session): Promise<string> {
    if (session.stopping !== undefined) return session.stopping;
    const recorder = session.recorder;
    if (recorder === undefined) return Promise.reject(new Error("no recorder"));
    session.phase = "stopping";
    session.cancelLease?.();
    session.cancelCap?.();
    session.cancelLease = undefined;
    session.cancelCap = undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      session.cancelStop = deps.schedule(() => {
        deps.log("stop-timeout");
        session.stopTimedOut = true;
        // Frees the slot and kills the process that ignored the stop.
        release(session);
        reject(new Error("stop timed out"));
      }, DICTATION_STOP_MS);
    });
    session.stopping = Promise.race([recorder.stop(), timedOut]).then(
      (path) => {
        session.cancelStop?.();
        session.cancelStop = undefined;
        if (current === session) {
          session.phase = "stopped";
          session.path = path;
        }
        return path;
      },
      (error: unknown) => {
        session.cancelStop?.();
        session.cancelStop = undefined;
        if (current === session) session.phase = "failed";
        throw error;
      },
    );
    return session.stopping;
  }

  function onCap(session: Session): void {
    deps.log("cap");
    stopOnce(session).then(
      () => {
        if (current !== session || session.phase !== "stopped") return;
        session.cancelHold = deps.schedule(() => release(session), DICTATION_HOLD_MS);
      },
      () => {
        // Phase is failed; the next keep or finish reports it and frees the slot.
        deps.log("stop");
      },
    );
  }

  const owned = (id: unknown): Session | undefined =>
    current !== undefined && typeof id === "string" && id === current.id ? current : undefined;

  return {
    active(): boolean {
      const phase = current?.phase;
      return phase === "starting" || phase === "recording" || phase === "stopping";
    },

    async start(paneKey: unknown): Promise<DictationStart> {
      if (disposed || typeof paneKey !== "string" || paneKey === "") {
        return { ok: false, reason: "failed" };
      }
      if (current !== undefined || deps.busy()) return { ok: false, reason: "busy" };
      const session: Session = { id: newId(), phase: "starting" };
      current = session;
      let recorder: DictationRecorder | undefined;
      try {
        if (!(await deps.hostsAgent(paneKey))) {
          release(session);
          return { ok: false, reason: "failed" };
        }
        if (current !== session) return { ok: false, reason: "failed" };
        recorder = await deps.makeRecorder();
        session.recorder = recorder;
        if (current !== session) {
          release(session);
          return { ok: false, reason: "failed" };
        }
        if (deps.busy()) {
          release(session);
          return { ok: false, reason: "busy" };
        }
        recorder.start();
      } catch {
        deps.log("start");
        release(session);
        return { ok: false, reason: "failed" };
      }
      session.phase = "recording";
      void recorder.ended.then((result) => {
        // Settling while still "recording" means nobody stopped it: it died.
        if (current === session && session.phase === "recording") {
          clearTimers(session);
          session.phase = "failed";
          session.deathReason = result?.missing === true ? "no-recorder" : "failed";
          deps.log("died");
          armLease(session);
        }
      });
      armLease(session);
      session.cancelCap = deps.schedule(() => onCap(session), DICTATION_CAP_MS);
      return { ok: true, id: session.id };
    },

    keep(id: unknown): DictationKeep {
      const session = owned(id);
      if (session === undefined) return { ok: false, reason: "gone" };
      if (session.phase === "failed") {
        const reason = session.deathReason ?? "failed";
        release(session);
        return { ok: false, reason };
      }
      if (session.phase === "recording") armLease(session);
      if (session.phase === "stopped") return { ok: true, capped: true };
      return { ok: true };
    },

    async finish(id: unknown): Promise<DictationFinish> {
      const session = owned(id);
      if (
        session === undefined ||
        session.phase === "starting" ||
        session.phase === "transcribing"
      ) {
        return { ok: false, reason: "gone" };
      }
      if (session.phase === "failed") {
        const reason = session.deathReason ?? "failed";
        release(session);
        return { ok: false, reason };
      }
      let path: string;
      try {
        path = await stopOnce(session);
      } catch (error) {
        deps.log("stop");
        const mine = current === session || session.stopTimedOut === true;
        release(session);
        if (!mine) return { ok: false, reason: "gone" };
        return { ok: false, reason: isMissing(error) ? "no-recorder" : "failed" };
      }
      if (current !== session) return { ok: false, reason: "gone" };
      clearTimers(session);
      session.phase = "transcribing";
      let heard: { text: string; language: string };
      try {
        heard = await deps.transcribe(path);
      } catch (error) {
        deps.log("transcribe");
        const mine = current === session;
        release(session);
        if (!mine) return { ok: false, reason: "gone" };
        return { ok: false, reason: isMissing(error) ? "no-whisper" : "failed" };
      }
      if (current !== session) return { ok: false, reason: "gone" };
      release(session);
      const text = cleanDictation(typeof heard.text === "string" ? heard.text : "");
      if (text === "") return { ok: false, reason: "silence" };
      return { ok: true, text, language: heard.language };
    },

    cancel(id: unknown): { ok: boolean } {
      const session = owned(id);
      if (session === undefined) return { ok: false };
      release(session);
      return { ok: true };
    },

    dispose(): void {
      disposed = true;
      if (current !== undefined) release(current);
    },
  };
}

export type Dictation = ReturnType<typeof createDictation>;

/** A recorder over `options.recorder`'s capture, writing into a fresh private
 *  directory that `dispose` removes. */
export async function createDictationRecorder(options: {
  recorder: RecorderDeps;
  makeDir(): Promise<string>;
  removeDir(dir: string): Promise<void>;
  /** Resolves after `ms`; for the wait on a process that will not end. */
  delay?(ms: number): Promise<void>;
}): Promise<DictationRecorder> {
  const dir = await options.makeDir();
  let settle: (result: RecordingResult) => void = () => undefined;
  const ended = new Promise<RecordingResult>((resolve) => {
    settle = resolve;
  });
  const recorder = new Recorder({
    ...options.recorder,
    tmpDir: dir,
    spawnRecorder: (outputPath) => {
      const process = options.recorder.spawnRecorder(outputPath);
      void process.done.then(settle, () => settle({ error: "recorder" }));
      return process;
    },
  });
  return {
    start: () => recorder.start(),
    stop: () => recorder.stop(),
    abort: () => recorder.abort(),
    ended,
    dispose: async () => {
      recorder.abort();
      // The process may still be writing: the directory goes after it ends
      // (bounded, so a process that never ends cannot hold this forever).
      const wait =
        options.delay ??
        ((ms: number) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, ms).unref?.();
          }));
      await Promise.race([ended, wait(DISPOSE_WAIT_MS)]);
      await options.removeDir(dir);
    },
  };
}
