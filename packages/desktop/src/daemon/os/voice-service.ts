// voice:utterance / voice:state / voice:stop (Rafiq M3 §2). One recording in,
// one decision out (core voice-intent.ts): approve/deny the visible card, stop,
// or send a prompt — and, for the computer's own push-to-talk, read the final
// answer aloud with Piper when the speak setting is on. approve/deny only
// CLASSIFY (contracts §5 #10): jarvisd never answers the card, the shell sends
// agent:confirm with its ticks. The phone's replies are never spoken here.
// Transcripts are never logged.
//
// No electron here (core/no-electron.test.ts).
import {
  type AgentEvent,
  CONTROL_TEXT,
  type ConfirmFrom,
  decideVoiceAction,
  type VoiceAvailability,
  type VoiceLang,
} from "@jarvis/core";
import {
  MAX_PROMPT_CHARS,
  OS_CONTROL_PUSHES,
  type VoiceStatePush,
  type VoiceUtteranceMeta,
  type VoiceUtteranceResult,
} from "@jarvis/wire";
import { type OsAgent, OsAgentError } from "./agent-service.js";
import { checkWav, type VoiceIo, VoiceUnavailableError } from "./voice-io.js";

export const MAX_SPOKEN_CHARS = 1_500;

export type VoiceOrigin = { from: ConfirmFrom; speakReply: boolean };

export type OsVoice = {
  utterance(
    meta: VoiceUtteranceMeta,
    wav: Uint8Array,
    origin: VoiceOrigin,
  ): Promise<VoiceUtteranceResult>;
  stop(): null;
  /** voice:setSpeak: read local replies aloud (needs an installed voice). */
  setSpeak(on: boolean): null;
  /** The io availability with `speak` = the user's setting. */
  availability(): VoiceAvailability;
  state(): VoiceStatePush;
  resync(): void;
};

export function createOsVoice(deps: {
  io: VoiceIo;
  agent: Pick<OsAgent, "prompt" | "stop" | "card" | "isLocked" | "onEvent" | "currentTurnId">;
  push(channel: string, payload: unknown): void;
  log(line: string): void;
  /** Initial speak setting (default on). */
  speak?: boolean;
}): OsVoice {
  let speakOn = deps.speak ?? true;
  let state: VoiceStatePush = { state: "idle" };
  /** The local voice prompt whose answer will be read aloud. */
  let reply: { turnId: string; lang: VoiceLang; text: string } | undefined;
  let generation = 0;

  function setState(next: VoiceStatePush): void {
    if (next.state === state.state && next.lang === state.lang) return;
    state = next;
    deps.push(OS_CONTROL_PUSHES.voiceState, next);
  }

  function silence(): void {
    generation += 1;
    reply = undefined;
    deps.io.stopSpeaking();
    if (state.state === "speaking") setState({ state: "idle" });
  }

  async function speak(text: string, lang: VoiceLang): Promise<void> {
    const mine = ++generation;
    setState({ state: "speaking", lang });
    try {
      await deps.io.speak(text.slice(0, MAX_SPOKEN_CHARS), lang);
    } catch {
      deps.log("[voice] speech failed");
    } finally {
      if (mine === generation) setState({ state: "idle" });
    }
  }

  deps.agent.onEvent((event: AgentEvent) => {
    if (reply === undefined) return;
    if (event.type === "text" && event.turnId === reply.turnId) {
      reply.text += event.delta;
      return;
    }
    if (event.type === "turn-end" && event.turnId === reply.turnId) {
      const done = reply;
      reply = undefined;
      if (event.reason === "done" && done.text.trim() !== "") void speak(done.text, done.lang);
    }
  });

  return {
    async utterance(meta, wav, origin) {
      if (!checkWav(wav).ok) throw new OsAgentError("bad-request", CONTROL_TEXT.en.badAudio);
      if (!deps.io.availability().available) {
        throw new OsAgentError("unsupported", CONTROL_TEXT.en.voiceUnavailable);
      }
      silence(); // barge-in: a new utterance stops whatever is being said
      setState({ state: "transcribing" });
      let heard: { text: string; language: VoiceLang };
      try {
        heard = await deps.io.transcribe(wav, meta.lang);
      } catch (error) {
        setState({ state: "idle" });
        if (error instanceof VoiceUnavailableError) {
          throw new OsAgentError("unsupported", CONTROL_TEXT.en.voiceUnavailable);
        }
        deps.log("[voice] transcription failed");
        throw new OsAgentError("internal", CONTROL_TEXT.en.transcriptionFailed);
      }
      setState({ state: "idle" });
      const text = heard.text.trim().slice(0, MAX_PROMPT_CHARS);
      const lang = heard.language;
      const decision = decideVoiceAction({
        text,
        ...(meta.cardId === undefined ? {} : { cardId: meta.cardId }),
        ...(meta.ticked === undefined ? {} : { ticked: meta.ticked }),
        card: meta.cardId === undefined ? undefined : deps.agent.card(meta.cardId),
        locked: deps.agent.isLocked(),
      });
      switch (decision.action) {
        case "approve":
        case "deny":
          return { text, lang, action: decision.action };
        case "stop": {
          silence();
          const running = deps.agent.currentTurnId();
          if (running !== undefined) deps.agent.stop(running);
          return { text, lang, action: "ignored" };
        }
        case "prompt": {
          const { turnId } = deps.agent.prompt(decision.text, origin.from);
          if (origin.speakReply && speakOn) reply = { turnId, lang, text: "" };
          return { text, lang, action: "prompt" };
        }
        case "ignored":
          return { text, lang, action: "ignored" };
      }
    },
    stop() {
      silence();
      return null;
    },
    setSpeak(on) {
      speakOn = on;
      if (!on) silence();
      return null;
    },
    availability() {
      const io = deps.io.availability();
      return { ...io, speak: speakOn && io.tts !== null };
    },
    state: () => state,
    resync() {
      deps.push(OS_CONTROL_PUSHES.voiceState, state);
    },
  };
}
