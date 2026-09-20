// The utterance pipeline, out of main.ts's processVoiceTurn closure and
// given its own tests. Both the desktop recorder (main.ts) and the phone's
// remote:uploadAudio handler (M8 Task 4) call handleUtterance with the same
// deps shape, differing only in `origin` — that's what makes ruling 5's
// per-turn muting and ruling 17's generic phone-facing failure text live in
// one place instead of two.
//
// handleUtterance never rejects, never deletes wavPath (the caller owns
// that — main.ts's recorder.cleanup, the upload handler's mkdtemp removal)
// and never logs the transcript (global constraints: transcripts are never
// logged on either side).
import type { HandleOptions } from "@jarvis/core";
import type { Broadcaster } from "./broadcast.js";
import type { PushChannels } from "./channels.js";
import { MESSAGES } from "./messages.js";

export type UtteranceOrigin = { kind: "desktop" } | { kind: "remote"; replyTo: string };

export type UtteranceOutcome =
  | { kind: "failed"; text: string; language: "ar" | "en" }
  | { kind: "silence"; text: string; language: "ar" | "en" }
  | { kind: "session"; sessionId: string; transcript: string; language: "ar" | "en" }
  | { kind: "brain"; transcript: string; language: "ar" | "en" };

export type UtteranceRequest = {
  wavPath: string;
  targetSessionId: string | undefined;
  origin: UtteranceOrigin;
};

export type HandledUtterance = { outcome: UtteranceOutcome; answered: Promise<void> };

export type UtteranceDeps = {
  transcribe(wavPath: string): Promise<{ text: string; language: string }>;
  sessions: {
    get(id: string): { id: string; endedAt?: number } | undefined;
    write(id: string, data: string): void;
  };
  orchestrator: {
    handle(text: string, language: "ar" | "en", options?: HandleOptions): Promise<unknown>;
  };
  broadcast: Pick<Broadcaster, "send">;
  primaryLanguage: "ar" | "en";
  log(line: string): void;
};

const RESOLVED: Promise<void> = Promise.resolve();

function safeLog(deps: UtteranceDeps, line: string): void {
  try {
    deps.log(line);
  } catch {
    // Diagnostics cannot break a voice turn.
  }
}

function safeBroadcast<C extends keyof PushChannels>(
  deps: UtteranceDeps,
  channel: C,
  payload: PushChannels[C],
): void {
  try {
    deps.broadcast.send(channel, payload);
  } catch {
    // Renderer delivery is best-effort; the completed outcome remains valid.
  }
}

export async function handleUtterance(
  request: UtteranceRequest,
  deps: UtteranceDeps,
): Promise<HandledUtterance> {
  const { wavPath, targetSessionId, origin } = request;
  const isDesktop = origin.kind === "desktop";

  let transcript: { text: string; language: string };
  try {
    transcript = await deps.transcribe(wavPath);
  } catch {
    // M12 Task 7 (ruling 10, "voice leak"): `turn:new` is broadcast to
    // every subscribed client, remote-paired phones included — a
    // desktop-origin failure's own detail (the caught error's own message,
    // which can carry a wav path or a dependency's own stderr) is no safer
    // on that channel than it would be on the wire to a phone directly.
    // `transcriptionFailed` no longer takes a detail argument (messages.ts);
    // the caught error itself never crosses into a log line or a broadcast
    // payload — the desktop log line below carries only a fixed site
    // category ("transcribe", this catch block's one failure site), never
    // the dependency's own message.
    let text: string;
    if (isDesktop) {
      text = MESSAGES.transcriptionFailed(deps.primaryLanguage);
      safeLog(deps, "voice-turn: transcription failed (desktop): transcribe");
      safeBroadcast(deps, "turn:new", {
        role: "assistant",
        text,
        language: deps.primaryLanguage,
        at: Date.now(),
      });
    } else {
      text = MESSAGES.voiceTurnFailed(deps.primaryLanguage);
      safeLog(deps, "voice-turn: transcription failed");
    }
    return {
      outcome: { kind: "failed", text, language: deps.primaryLanguage },
      answered: RESOLVED,
    };
  }

  const language = transcript.language === "ar" ? "ar" : "en";

  if (transcript.text.trim() === "") {
    const text = MESSAGES.nothingHeard(language);
    if (isDesktop) {
      safeBroadcast(deps, "voice:notice", { text, language });
    }
    return { outcome: { kind: "silence", text, language }, answered: RESOLVED };
  }

  let target: { id: string; endedAt?: number } | undefined;
  if (targetSessionId !== undefined) {
    try {
      target = deps.sessions.get(targetSessionId);
    } catch {
      safeLog(deps, "voice-turn: session lookup failed");
    }
  }
  if (target !== undefined && target.endedAt === undefined) {
    try {
      deps.sessions.write(target.id, `${transcript.text}\r`);
    } catch {
      safeLog(deps, "voice-turn: session write failed");
      return {
        outcome: {
          kind: "failed",
          text: MESSAGES.voiceTurnFailed(deps.primaryLanguage),
          language: deps.primaryLanguage,
        },
        answered: RESOLVED,
      };
    }
    if (isDesktop) {
      safeBroadcast(deps, "voice:notice", { text: transcript.text, language });
    }
    return {
      outcome: { kind: "session", sessionId: target.id, transcript: transcript.text, language },
      answered: RESOLVED,
    };
  }

  const options: HandleOptions = isDesktop
    ? { speakAloud: true }
    : { speakAloud: false, replyTo: origin.replyTo };

  let brain: Promise<unknown>;
  try {
    brain = Promise.resolve(deps.orchestrator.handle(transcript.text, language, options));
  } catch {
    safeLog(deps, "voice-turn: brain failed");
    brain = RESOLVED;
  }

  const answered = brain
    .then(() => undefined)
    .catch(() => {
      safeLog(deps, "voice-turn: brain failed");
    });

  return {
    outcome: { kind: "brain", transcript: transcript.text, language },
    answered,
  };
}
