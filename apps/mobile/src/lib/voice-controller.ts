// The voice controller (M8 Task 7): record, upload, retry, reply, speak.
// One instance per app (ruling 14, `VoiceProvider` owns it), driving the
// `VoiceRecorder`/`Speaker`/`RecordingFiles` adapters from Task 6 and the
// `RpcClient` from Task 5 (upload) and M7 Task 3 (ref-counted subscribe).
// See task-7-brief.md's "Behaviour, voice-controller.ts" for the numbered
// rules this file implements, and rulings.md 1, 2, 3, 6, 7, 8, 9, 10, 12,
// 13, 14, 15 for the "why".
//
// Logging discipline (rule 15): every `log` line carries only the phase,
// the turnId, byte counts and outcome kinds — never the recording's text,
// its base64, or its file uri.
//
// A speak() call and the reply that started it are correlated by a
// per-call generation counter (`speakGeneration`), not by phase alone: two
// replies arriving close together both pass through the same "speaking"
// phase value, so a late resolution of a *cancelled* speak() (Task 6's
// `buildSpeaker` resolves an overlapping call's promise as "stopped" the
// moment a newer speak() cancels it) could otherwise end the *newer*
// call's speech early just because the phase still reads "speaking". The
// generation counter distinguishes "my own call finished" from "some
// other call finished" even when the visible phase can't.

import {
  MAX_VOICE_BYTES,
  MAX_VOICE_DURATION_MS,
  MIN_VOICE_DURATION_MS,
  VOICE_UPLOAD_CHANNEL,
  parseVoiceUploadResult,
} from "@jarvis/wire";
import type { VoiceUploadMeta } from "@jarvis/wire";
import type { Clock } from "./clock";
import type { Language } from "./i18n";
import type { RecordingFiles } from "./recording-files";
import type { RpcClient, RpcResult } from "./rpc-client";
import type { Speaker } from "./speaker";
import { type TurnView, mergeTurns, parseTurn, parseTurnList } from "./turns";
import type { MicPermission, Recording, VoiceRecorder } from "./voice-recorder";

export const REPLY_WAIT_MS = 180_000;
export const VOICE_UPLOAD_TIMEOUT_MS = 100_000;
export const ELAPSED_TICK_MS = 250;

export type VoiceTarget = { kind: "brain" } | { kind: "session"; sessionId: string };

export type VoicePhase =
  | "idle"
  | "starting"
  | "recording"
  | "sending"
  | "notSent"
  | "uncertain"
  | "waitingReply"
  | "speaking";

export type VoiceNoticeCode =
  | "micDenied"
  | "micBlocked"
  | "recorderFailed"
  | "tooShort"
  | "tooLarge"
  | "notSentOffline"
  // Fix round 2: the socket refused this upload locally — a second upload
  // already in flight, or the laptop's own drain latch (rpc-client.ts's
  // BLOB_IDLE_TIMEOUT_MS window after an earlier upload stopped early) —
  // or this client's own cancelled() predicate turned true. Neither ever
  // reached the laptop; the recording is untouched and a retry mints a
  // fresh call.
  | "notSentBusy"
  | "uncertain"
  | "stoppedInBackground"
  | "noReply"
  | "noVoiceAr"
  | "noVoiceEn"
  | "laptopTooOld"
  | "failed"
  | "sentToSession"
  | "server";

export type VoiceNotice = { code: VoiceNoticeCode; server?: { text: string; language: Language } };

export type VoiceView = {
  phase: VoicePhase;
  target: VoiceTarget;
  pendingTarget?: VoiceTarget;
  elapsedMs: number;
  permission?: MicPermission;
  notice?: VoiceNotice;
  turns: readonly TurnView[];
  speakReplies: boolean;
  canRetry: boolean;
  // Fix round (2026-09-19 redesign): the Voice transcript's "Spoken · HH:MM"
  // meta line (item 4) needs to know which replies were actually spoken
  // aloud — distinct from the existing `spoken` Set below, which marks a
  // turnId "already handled" the instant a reply is consumed (so a
  // duplicate push isn't re-processed) regardless of whether TTS ever ran
  // for it (speakReplies off, no voice installed, an overlapping
  // recording…). `spokenReplyIds` holds only the turnIds (a reply's own
  // `replyTo`) that this controller actually started `speaker.speak()`
  // for, so `TurnList` can render the meta line exactly where the sound
  // was heard, not on every reply merely gated open.
  spokenReplyIds: readonly string[];
};

export type VoiceController = {
  get(): VoiceView;
  subscribe(listener: (view: VoiceView) => void): () => void;
  focus(target: VoiceTarget): () => void;
  toggle(): Promise<void>;
  retry(): Promise<void>;
  discard(): void;
  stopSpeaking(): void;
  setSpeakReplies(on: boolean): void;
  appStateChanged(active: boolean): void;
  dispose(): void;
  isDisposed(): boolean;
};

export type VoiceControllerDeps = {
  client: RpcClient;
  clock: Clock;
  recorder: VoiceRecorder;
  speaker: Speaker;
  files: RecordingFiles;
  random(): number;
  speakReplies: boolean;
  log(line: string): void;
};

type PendingRecording = {
  recording: Recording;
  target: VoiceTarget;
  turnId: string;
  attempt: number;
};

type AwaitEntry = { timer: unknown };

/** 32 lowercase hex characters from `random()`, each nibble
 * `Math.floor(random() * 16)` — always matches @jarvis/wire's
 * `TURN_ID_PATTERN`. Only de-duplicates within this device's own uploads
 * (ruling 9); it is not a secret. */
export function newTurnId(random: () => number): string {
  let id = "";
  for (let i = 0; i < 32; i++) {
    id += Math.floor(random() * 16).toString(16);
  }
  return id;
}

export function createVoiceController(deps: VoiceControllerDeps): VoiceController {
  const listeners = new Set<(view: VoiceView) => void>();

  let view: VoiceView = {
    phase: "idle",
    target: { kind: "brain" },
    elapsedMs: 0,
    turns: [],
    speakReplies: deps.speakReplies,
    canRetry: false,
    spokenReplyIds: [],
  };

  let disposed = false;
  let appActive = true;
  let focusCount = 0;
  let holding = false;
  let unsubscribePush: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;

  let pending: PendingRecording | undefined;
  const awaiting = new Map<string, AwaitEntry>();
  const spoken = new Set<string>();
  // Distinct from `spoken` above (see VoiceView.spokenReplyIds's own
  // comment) — only turnIds this controller actually started speaking.
  const spokenAloud = new Set<string>();
  const noticedNoVoice = new Set<Language>();
  let speakGeneration = 0;
  let replyChain: Promise<void> = Promise.resolve();

  let elapsedTimer: unknown;
  let autoStopTimer: unknown;
  // Review round 1, Important #3: `recorder.stop()`/`recorder.start()` are
  // native calls that can take hundreds of ms. This flag is set
  // synchronously at the very top of `start()`/`stop()` (before any
  // `await`) and is checked there too, so a second tap arriving before
  // the first native call resolves is a no-op — never a second call into
  // the recorder, and never two outcomes racing to set the final phase.
  // `backgroundStop()` and `appStateChanged()` respect it as well.
  let recorderInFlight = false;

  function setView(patch: Partial<VoiceView>): void {
    view = { ...view, ...patch };
    for (const listener of [...listeners]) {
      listener(view);
    }
  }

  // --- subscription lifetime (rule 2) -------------------------------

  function shouldHold(): boolean {
    return focusCount > 0 || awaiting.size > 0;
  }

  function ensureSubscriptions(): void {
    const hold = shouldHold();
    if (hold && !holding) {
      holding = true;
      // Unsupported is ignored (rule 2): turns:list still works.
      deps.client.subscribe("turn:new");
      unsubscribePush = deps.client.onPush("turn:new", (payload) => {
        const turn = parseTurn(payload);
        if (turn === undefined) return;
        applyTurns([turn]);
      });
      unsubscribeState = deps.client.onState((state) => {
        if (state === "open") void refreshTurnsList();
      });
      return;
    }
    if (!hold && holding) {
      holding = false;
      deps.client.unsubscribe("turn:new");
      unsubscribePush?.();
      unsubscribePush = undefined;
      unsubscribeState?.();
      unsubscribeState = undefined;
    }
  }

  async function refreshTurnsList(): Promise<void> {
    const result = await deps.client.call("turns:list", []);
    if (!result.ok) return;
    applyTurns(parseTurnList(result.value));
  }

  function applyTurns(list: TurnView[]): void {
    if (list.length === 0) return;
    setView({ turns: mergeTurns(view.turns, list) });
    for (const turn of list) {
      if (
        turn.role === "assistant" &&
        turn.replyTo !== undefined &&
        awaiting.has(turn.replyTo) &&
        !spoken.has(turn.replyTo)
      ) {
        enqueueReply(turn);
      }
    }
  }

  // --- replies (rule 9) ----------------------------------------------

  // Review round 1, Minor #3: chained with both handlers so a throw
  // anywhere in one reply's handling can never poison every reply queued
  // after it — the chain always keeps moving.
  function enqueueReply(turn: TurnView): void {
    const run = (): Promise<void> => handleReply(turn);
    replyChain = replyChain.then(run, run);
  }

  /** Rule 9's `waitingReply`/`idle`/`speaking` are the only phases a reply
   * may ever move the controller into or out of — every other phase (an
   * overlapping recording, sending, notSent, uncertain) is something the
   * user is actively doing that a reply must never interrupt (review
   * round 1, Important #1: rule 3 lets `toggle()` start a new recording
   * while `waitingReply`, so this overlap is a designed path). Checked
   * once before the async `hasVoice` lookup and again right after it,
   * since the phase can change out from under that await. */
  function speakableNow(): boolean {
    // M12 Task 8, rule 11: also false while a recorder start()/stop() is
    // in flight — without this, a reply arriving during start()'s
    // permission-prompt await (view.phase is still "idle" at that point,
    // since start() hasn't set "starting" yet) would speak into an
    // about-to-open mic, overlapping the recording the user just asked
    // for.
    return (
      !recorderInFlight &&
      (view.phase === "waitingReply" || view.phase === "idle" || view.phase === "speaking")
    );
  }

  function exitSpeaking(): void {
    setView({ phase: awaiting.size > 0 ? "waitingReply" : "idle" });
  }

  async function handleReply(turn: TurnView): Promise<void> {
    const turnId = turn.replyTo;
    if (turnId === undefined) return;
    const entry = awaiting.get(turnId);
    if (entry === undefined || spoken.has(turnId)) return; // already answered/expired
    deps.clock.clearTimeout(entry.timer);
    awaiting.delete(turnId);
    spoken.add(turnId);
    ensureSubscriptions();

    if (view.speakReplies && appActive && speakableNow()) {
      let hasVoice: boolean;
      try {
        hasVoice = await deps.speaker.hasVoice(turn.language);
      } catch {
        hasVoice = true; // unknown -> speak and let onError report (ruling 8)
      }
      if (speakableNow()) {
        if (hasVoice) {
          const generation = ++speakGeneration;
          spokenAloud.add(turnId);
          setView({ phase: "speaking", spokenReplyIds: [...spokenAloud] });
          try {
            await deps.speaker.speak(turn.text, turn.language);
          } catch {
            // A synchronous throw from the native module (an old build,
            // Minor #3) must not poison the reply chain or leave the
            // phase stuck at "speaking" — fall through to the same exit
            // a normal completion takes.
          }
          // Only this call's own completion may close it out — a stale
          // resolution from a call a newer speak() cancelled must not.
          if (generation === speakGeneration && view.phase === "speaking") {
            exitSpeaking();
          }
          return;
        }
        if (!noticedNoVoice.has(turn.language)) {
          noticedNoVoice.add(turn.language);
          setView({ notice: { code: turn.language === "ar" ? "noVoiceAr" : "noVoiceEn" } });
        }
        exitSpeaking();
        return;
      }
      // The phase moved away from waitingReply/idle/speaking while
      // hasVoice() was in flight (e.g. the user started recording) —
      // fall through to the same "consume only" path below.
    }

    // Not speakable (an overlapping recording/send/notSent/uncertain is
    // in progress), or speaking is off/the app is backgrounded: the turn
    // is already merged into `turns` and marked spoken above, so it is
    // never spoken later either. Nothing else — phase, recorder, pending
    // — is touched here.
    if (view.phase === "waitingReply" && awaiting.size === 0) {
      setView({ phase: "idle" });
    }
  }

  function handleReplyTimeout(turnId: string): void {
    if (!awaiting.has(turnId)) return;
    awaiting.delete(turnId);
    ensureSubscriptions();
    if (view.phase === "waitingReply" && awaiting.size === 0) {
      setView({ phase: "idle", notice: { code: "noReply" } });
    }
  }

  // --- focus -----------------------------------------------------------

  function focus(target: VoiceTarget): () => void {
    if (disposed) return () => {};
    setView({ target });
    const wasZero = focusCount === 0;
    focusCount += 1;
    ensureSubscriptions();
    if (wasZero) void refreshTurnsList();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      focusCount = Math.max(0, focusCount - 1);
      ensureSubscriptions();
    };
  }

  // --- timers ------------------------------------------------------------

  function clearElapsedTicker(): void {
    if (elapsedTimer !== undefined) {
      deps.clock.clearTimeout(elapsedTimer);
      elapsedTimer = undefined;
    }
  }

  function armElapsedTicker(): void {
    clearElapsedTicker();
    const tick = (): void => {
      elapsedTimer = deps.clock.setTimeout(tick, ELAPSED_TICK_MS);
      setView({ elapsedMs: deps.recorder.elapsedMs() });
    };
    elapsedTimer = deps.clock.setTimeout(tick, ELAPSED_TICK_MS);
  }

  function clearAutoStopTimer(): void {
    if (autoStopTimer !== undefined) {
      deps.clock.clearTimeout(autoStopTimer);
      autoStopTimer = undefined;
    }
  }

  function armAutoStopTimer(): void {
    clearAutoStopTimer();
    autoStopTimer = deps.clock.setTimeout(() => {
      autoStopTimer = undefined;
      void stop();
    }, MAX_VOICE_DURATION_MS);
  }

  // --- start / stop (rules 4, 5) ------------------------------------

  async function start(): Promise<void> {
    if (recorderInFlight) return; // Important #3: a tap while a stop/start is already running is a no-op.
    recorderInFlight = true;
    try {
      deps.speaker.stop();
      let permission = await deps.recorder.permission();
      if (permission === "undetermined") {
        permission = await deps.recorder.requestPermission();
      }
      if (disposed) return; // Minor #2: dispose() raced the permission prompt.
      setView({ permission });
      if (permission === "denied") {
        setView({ phase: "idle", notice: { code: "micDenied" } });
        return;
      }
      if (permission === "blocked") {
        setView({ phase: "idle", notice: { code: "micBlocked" } });
        return;
      }
      setView({ phase: "starting", notice: undefined });
      try {
        await deps.recorder.start();
      } catch {
        if (!disposed) setView({ phase: "idle", notice: { code: "recorderFailed" } });
        return;
      }
      if (disposed) {
        // Minor #2: dispose() raced the native start() call — it
        // resolved after we stopped caring. Stop it and discard; there
        // is no view left to update.
        try {
          const rec = await deps.recorder.stop();
          if (rec !== undefined) deps.files.remove(rec.uri);
        } catch {
          // Best-effort cleanup only.
        }
        return;
      }
      const targetAtStart = view.target;
      setView({ phase: "recording", elapsedMs: 0, pendingTarget: targetAtStart });
      if (!appActive) {
        // Minor #2: backgrounded while the native recorder was still
        // starting up — the same outcome as backgrounding mid-recording.
        await stopIntoBackground(targetAtStart);
        return;
      }
      armElapsedTicker();
      armAutoStopTimer();
    } finally {
      recorderInFlight = false;
    }
  }

  async function stop(): Promise<void> {
    if (recorderInFlight) return; // Important #3: double-tap guard.
    recorderInFlight = true;
    try {
      clearElapsedTicker();
      clearAutoStopTimer();
      let rec: Recording | undefined;
      try {
        rec = await deps.recorder.stop();
      } catch {
        // Important #3: the brief is silent on a stop rejection — the
        // same mapping start() already uses for its own recorder.start()
        // failure.
        if (!disposed) {
          setView({
            phase: "idle",
            notice: { code: "recorderFailed" },
            pendingTarget: undefined,
            canRetry: false,
          });
        }
        return;
      }
      if (disposed) {
        // dispose() ran while this stop() was still awaiting the native
        // call — there is no view left to update, only the file to
        // clean up if one was produced.
        if (rec !== undefined) deps.files.remove(rec.uri);
        return;
      }
      if (rec === undefined || rec.durationMs < MIN_VOICE_DURATION_MS) {
        if (rec !== undefined) deps.files.remove(rec.uri);
        setView({
          phase: "idle",
          notice: { code: "tooShort" },
          pendingTarget: undefined,
          canRetry: false,
        });
        return;
      }
      // The native recorder has genuinely stopped here — from this point
      // on, `send()` is network/upload work, not "the mic is busy". Rule
      // 11's `speakableNow()` reads `recorderInFlight` to keep a reply
      // from being spoken into a mic that's about to open (start()'s own,
      // still-in-flight window); it must not also hold up I1's "reply
      // beats the upload result" case, which can legitimately land while
      // this same stop() call's own send() is still awaiting the blob's
      // res.
      recorderInFlight = false;
      pending = {
        recording: rec,
        target: view.pendingTarget ?? view.target,
        turnId: newTurnId(deps.random),
        attempt: 0,
      };
      await send();
    } finally {
      recorderInFlight = false;
    }
  }

  /** The shared "stop the recorder and keep it as Not sent, never
   * uploaded" outcome (ruling 12) — used by `backgroundStop()` and by
   * `start()`'s own late-background path (Minor #2). The caller owns
   * `recorderInFlight`: this function assumes it is already held. */
  async function stopIntoBackground(targetAtStart: VoiceTarget): Promise<void> {
    clearElapsedTicker();
    clearAutoStopTimer();
    let rec: Recording | undefined;
    try {
      rec = await deps.recorder.stop();
    } catch {
      if (!disposed) {
        setView({
          phase: "idle",
          notice: { code: "recorderFailed" },
          pendingTarget: undefined,
          canRetry: false,
        });
      }
      return;
    }
    if (disposed) {
      if (rec !== undefined) deps.files.remove(rec.uri);
      return;
    }
    if (rec === undefined) {
      setView({
        phase: "idle",
        notice: { code: "stoppedInBackground" },
        pendingTarget: undefined,
        canRetry: false,
      });
      return;
    }
    // Ruling 12: kept as Not sent, never uploaded — no send() here.
    pending = {
      recording: rec,
      target: targetAtStart,
      turnId: newTurnId(deps.random),
      attempt: 0,
    };
    setView({
      phase: "notSent",
      notice: { code: "stoppedInBackground" },
      canRetry: true,
      pendingTarget: targetAtStart,
    });
  }

  function backgroundStop(): void {
    if (recorderInFlight) return; // Important #3: a stop/start is already running.
    recorderInFlight = true;
    const targetAtStart = view.pendingTarget ?? view.target;
    void stopIntoBackground(targetAtStart).finally(() => {
      recorderInFlight = false;
    });
  }

  // --- send / result mapping (rules 6, 7) --------------------------

  function applyOutcome(
    phase: VoicePhase,
    notice: VoiceNotice | undefined,
    canRetry: boolean,
  ): void {
    setView({ phase, notice, canRetry, pendingTarget: pending?.target });
  }

  function finishPending(notice: VoiceNotice | undefined): void {
    if (pending !== undefined) {
      deps.files.remove(pending.recording.uri);
    }
    pending = undefined;
    applyOutcome("idle", notice, false);
  }

  async function send(): Promise<void> {
    if (pending === undefined) return;
    pending.attempt += 1;
    const attempt = pending.attempt;
    const uri = pending.recording.uri;
    const turnId = pending.turnId;
    const target = pending.target;

    if (deps.client.state() !== "open") {
      deps.log(`voice: notSent turn=${turnId} attempt=${attempt}`);
      applyOutcome("notSent", { code: "notSentOffline" }, true);
      return;
    }

    const size = deps.files.size(uri);
    if (size === undefined || size > MAX_VOICE_BYTES) {
      finishPending({ code: "tooLarge" });
      return;
    }

    setView({ phase: "sending", notice: undefined });
    deps.log(`voice: sending turn=${turnId} bytes=${size} attempt=${attempt}`);

    let base64: string;
    try {
      base64 = await deps.files.readBase64(uri);
    } catch {
      finishPending({ code: "recorderFailed" });
      return;
    }

    // `pending` cannot change from toggle()/retry()/discard() while phase
    // is "sending" (rule 3, rule 8) — but dispose() is not phase-gated: it
    // clears `pending` unconditionally (see dispose() below), whatever
    // phase the controller is in, and can run while this readBase64()
    // await was in flight. M12 Task 8, rule 11: return here without
    // dereferencing `pending`, or a disposed controller's stale send()
    // throws into an unhandled rejection nothing ever awaits.
    if (disposed || pending === undefined) return;

    const durationMs = Math.min(Math.round(pending.recording.durationMs), MAX_VOICE_DURATION_MS);
    const meta: VoiceUploadMeta = { turnId, format: "m4a", durationMs };
    if (target.kind === "session") {
      meta.targetSessionId = target.sessionId;
    }

    // Minor #1: re-checked "just before upload" (the table's own wording)
    // rather than relying on the pre-readBase64 check above — a close
    // during the read of a multi-MiB file must answer notSentOffline
    // like any other pre-flight offline, not the in-flight "uncertain".
    if (deps.client.state() !== "open") {
      deps.log(`voice: notSent turn=${turnId} attempt=${attempt}`);
      applyOutcome("notSent", { code: "notSentOffline" }, true);
      return;
    }

    const result = await deps.client.upload(VOICE_UPLOAD_CHANNEL, [meta], base64, {
      timeoutMs: VOICE_UPLOAD_TIMEOUT_MS,
    });
    handleUploadResult(result);
  }

  function keepPendingNotSent(notice: VoiceNotice): void {
    applyOutcome("notSent", notice, true);
  }

  function keepPendingUncertain(notice: VoiceNotice): void {
    applyOutcome("uncertain", notice, true);
  }

  function handleUploadResult(result: RpcResult): void {
    if (pending === undefined) return;
    const attempt = pending.attempt;

    if (result.ok) {
      const parsed = parseVoiceUploadResult(result.value);
      if (parsed === undefined) {
        deps.log("voice: result unparseable");
        finishPending({ code: "failed" });
        return;
      }
      if (parsed.kind === "heard" && parsed.route === "brain") {
        deps.log("voice: result heard");
        const turnId = pending.turnId;
        deps.files.remove(pending.recording.uri);
        pending = undefined;
        awaiting.set(turnId, {
          timer: deps.clock.setTimeout(() => handleReplyTimeout(turnId), REPLY_WAIT_MS),
        });
        ensureSubscriptions();
        applyOutcome("waitingReply", undefined, false);
        // I1: the laptop's assistant turn:new can arrive (and already be
        // merged into view.turns by applyTurns) before this res does — the
        // fast-brain and fast-failure paths both beat a real `rm -r` of the
        // upload's temp dir. applyTurns couldn't enqueue it at merge time
        // because `awaiting` didn't have this turnId yet; rescan now that
        // it does. handleReply re-checks awaiting/spoken itself, so this is
        // safe even if there is no match or it was already handled.
        const early = view.turns.find((t) => t.role === "assistant" && t.replyTo === turnId);
        if (early !== undefined) enqueueReply(early);
        if (attempt > 1) void refreshTurnsList();
        return;
      }
      if (parsed.kind === "heard" && parsed.route === "session") {
        deps.log("voice: result heard");
        finishPending({
          code: "sentToSession",
          server: { text: parsed.transcript, language: parsed.language },
        });
        return;
      }
      if (parsed.kind === "busy") {
        deps.log("voice: result busy");
        keepPendingNotSent({
          code: "server",
          server: { text: parsed.text, language: parsed.language },
        });
        return;
      }
      // silence | invalid | failed
      deps.log(`voice: result ${parsed.kind}`);
      finishPending({ code: "server", server: { text: parsed.text, language: parsed.language } });
      return;
    }

    const error = result.error;
    switch (error.kind) {
      case "offline":
        deps.log("voice: result offline");
        keepPendingUncertain({ code: "uncertain" });
        return;
      case "timeout":
        deps.log("voice: result timeout");
        keepPendingUncertain({ code: "uncertain" });
        return;
      case "remote":
        if (error.code === "rate-limited") {
          deps.log("voice: result rate-limited");
          keepPendingNotSent({
            code: "server",
            server: { text: error.text, language: error.language },
          });
          return;
        }
        if (error.code === "unknown-channel" || error.code === "forbidden") {
          deps.log(`voice: result ${error.code}`);
          finishPending({ code: "laptopTooOld" });
          return;
        }
        deps.log(`voice: result ${error.code}`);
        finishPending({ code: "server", server: { text: error.text, language: error.language } });
        return;
      case "unsupported":
        deps.log("voice: result unsupported");
        finishPending({ code: "failed" });
        return;
      // Fix round 2: rpc-client.ts's Task-5 upload() can now answer either
      // of these — busy when another upload (including a second voice
      // attempt) is already in flight or the socket is still draining an
      // earlier one's blobPhase; cancelled when this client's own
      // cancelled() predicate stopped it (voice never supplies one today,
      // but RpcError's union covers the case regardless). Both mean
      // nothing reached the laptop: the same "not sent, can retry" shape
      // as offline/timeout, not "uncertain" — there is nothing to check
      // for on the laptop side.
      case "busy":
        deps.log("voice: result busy");
        keepPendingNotSent({ code: "notSentBusy" });
        return;
      case "cancelled":
        deps.log("voice: result cancelled");
        keepPendingNotSent({ code: "notSentBusy" });
        return;
    }
  }

  // --- public controls -----------------------------------------------

  async function toggle(): Promise<void> {
    if (disposed) return;
    switch (view.phase) {
      case "idle":
      case "waitingReply":
      case "speaking":
        await start();
        return;
      case "recording":
        await stop();
        return;
      default:
        // starting, sending, notSent, uncertain: the mic is disabled
        // while a recording waits (ruling 12).
        return;
    }
  }

  async function retry(): Promise<void> {
    if (disposed) return;
    if (view.phase !== "notSent" && view.phase !== "uncertain") return;
    if (pending === undefined) return;
    await send();
  }

  function discard(): void {
    if (view.phase !== "notSent" && view.phase !== "uncertain") return;
    if (pending !== undefined) {
      deps.files.remove(pending.recording.uri);
      pending = undefined;
    }
    setView({ phase: "idle", notice: undefined, pendingTarget: undefined, canRetry: false });
  }

  function stopSpeaking(): void {
    deps.speaker.stop();
  }

  function setSpeakReplies(on: boolean): void {
    if (!on) deps.speaker.stop();
    setView({ speakReplies: on });
  }

  function appStateChanged(active: boolean): void {
    appActive = active;
    if (!active) {
      // Important #3: if a stop()/start() is already running (its own
      // native call in flight), let it finish on its own terms rather
      // than calling into the recorder a second time here.
      if (view.phase === "recording" && !recorderInFlight) {
        backgroundStop();
      } else if (view.phase === "speaking") {
        deps.speaker.stop();
      }
    }
  }

  function dispose(): void {
    disposed = true;
    clearElapsedTicker();
    clearAutoStopTimer();
    for (const entry of awaiting.values()) {
      deps.clock.clearTimeout(entry.timer);
    }
    awaiting.clear();
    deps.speaker.stop();
    // Important #3: only stop the recorder here if nothing else already
    // has a native call in flight — `start()`/`stop()` themselves check
    // `disposed` after their own await and clean up the file, so a
    // second concurrent `recorder.stop()` from here would be redundant
    // (or, worse, race the first one's result).
    if (view.phase === "recording" && !recorderInFlight) {
      void deps.recorder
        .stop()
        .then((rec) => {
          if (rec !== undefined) deps.files.remove(rec.uri);
        })
        .catch(() => {
          // Best-effort: nothing is left to report to once disposed.
        });
    }
    if (pending !== undefined) {
      deps.files.remove(pending.recording.uri);
      pending = undefined;
    }
    if (holding) {
      holding = false;
      deps.client.unsubscribe("turn:new");
      unsubscribePush?.();
      unsubscribePush = undefined;
      unsubscribeState?.();
      unsubscribeState = undefined;
    }
  }

  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focus,
    toggle,
    retry,
    discard,
    stopSpeaking,
    setSpeakReplies,
    appStateChanged,
    dispose,
    isDisposed: () => disposed,
  };
}
