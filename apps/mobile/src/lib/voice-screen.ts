// The pure decisions behind the Voice screen and the session-screen mic
// (M8 Task 8): whether the mic is tappable, what its label reads, the
// status line under it, which i18n key a notice maps to, and the small
// text-formatting/direction helpers both screens need. `app/voice.tsx`,
// `app/session/[id].tsx` and `MicButton.tsx` are layout only — every
// decision here is a plain function over `VoiceController`'s `VoiceView`,
// so it's unit-tested without a simulator (global constraint).
//
// See task-8-brief.md's "Behaviour, rules 2-5" for what each function
// implements.
import type { Language, MessageKey } from "./i18n";
import type { VoiceNoticeCode, VoicePhase, VoiceView } from "./voice-controller";

export type MicButtonState = { enabled: boolean; active: boolean; labelKey: MessageKey };

// Rule 2: the mic is tappable while idle, recording, waiting for a reply,
// or while a reply is speaking (tapping it then stops playback and starts
// a new recording — voice-controller.ts's `toggle()` rule). It stays
// enabled with the socket closed (ruling 12: recording is always local) —
// only the phase and `sessionEnded` gate it.
const ENABLED_PHASES: ReadonlySet<VoicePhase> = new Set<VoicePhase>([
  "idle",
  "recording",
  "waitingReply",
  "speaking",
]);

export function micButtonState(
  view: VoiceView,
  options: { sessionEnded?: boolean; forSession?: boolean },
): MicButtonState {
  const active = view.phase === "recording";
  // M5: a session ending mid-recording must not strand the recorder — the
  // tap that STOPS an in-progress recording stays available even then
  // (`toggle()`'s `recording` branch always calls `stop()` regardless of
  // `target`). Only starting a *new* recording is disabled once the
  // session has ended.
  const enabled = active || (ENABLED_PHASES.has(view.phase) && !options.sessionEnded);
  const labelKey: MessageKey = active
    ? "voice.stop"
    : options.forSession
      ? "voice.startForSession"
      : "voice.start";
  return { enabled, active, labelKey };
}

// Rule 3: only these four phases show a status line; every other phase
// (idle, starting, notSent, uncertain) shows nothing here — those states
// are described by the notice line instead.
export function phaseStatusKey(phase: VoicePhase): MessageKey | undefined {
  switch (phase) {
    case "recording":
      return "voice.recording";
    case "sending":
      return "voice.sending";
    case "waitingReply":
      return "voice.waitingReply";
    case "speaking":
      return "voice.speaking";
    default:
      return undefined;
  }
}

// Rule 4: every `VoiceNoticeCode` maps to its own `voice.notice.<code>`
// key, except `server` — that notice carries the laptop's own bilingual
// text verbatim (rule 17 in rulings.md) and has no key of its own.
const NOTICE_KEYS: Readonly<Record<Exclude<VoiceNoticeCode, "server">, MessageKey>> = {
  micDenied: "voice.notice.micDenied",
  micBlocked: "voice.notice.micBlocked",
  recorderFailed: "voice.notice.recorderFailed",
  tooShort: "voice.notice.tooShort",
  tooLarge: "voice.notice.tooLarge",
  notSentOffline: "voice.notice.notSentOffline",
  notSentBusy: "voice.notice.notSentBusy",
  uncertain: "voice.notice.uncertain",
  stoppedInBackground: "voice.notice.stoppedInBackground",
  noReply: "voice.notice.noReply",
  noVoiceAr: "voice.notice.noVoiceAr",
  noVoiceEn: "voice.notice.noVoiceEn",
  laptopTooOld: "voice.notice.laptopTooOld",
  failed: "voice.notice.failed",
  sentToSession: "voice.notice.sentToSession",
};

export function noticeKey(code: VoiceNoticeCode): MessageKey | undefined {
  if (code === "server") return undefined;
  return NOTICE_KEYS[code];
}

// Rule 5: `m:ss` with ASCII digits, clamped to zero for a negative or NaN
// input (a stale/uninitialised elapsedMs must never render as garbage).
export function formatElapsed(ms: number): string {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function textDirection(language: Language): "rtl" | "ltr" {
  return language === "ar" ? "rtl" : "ltr";
}
