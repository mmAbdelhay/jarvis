import type { AgentEvent, Card, ConfirmFrom } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { makeWav } from "./__fixtures__/wav.js";
import type { VoiceIo } from "./voice-io.js";
import { createOsVoice } from "./voice-service.js";

const LOCAL: ConfirmFrom = { via: "desktop", allowPassword: true };
const PHONE: ConfirmFrom = { via: "phone:Pixel 8", allowPassword: false };
const CARD: Card = {
  cardId: "c1",
  turnId: "t0",
  expiresAt: 0,
  items: [
    {
      itemId: "item-1",
      tool: "settings.brightness",
      title: "Set brightness to 80%",
      detail: "",
      source: "system",
      risk: "confirm",
      secretFields: [],
    },
  ],
};

function harness(
  heard: { text: string; language: "en" | "ar" },
  over: { locked?: boolean; speak?: boolean } = {},
) {
  const pushes: { channel: string; payload: unknown }[] = [];
  const prompts: { text: string; from?: ConfirmFrom }[] = [];
  const stops: string[] = [];
  const spoken: string[] = [];
  let speechStops = 0;
  const listeners = new Set<(event: AgentEvent) => void>();
  let turn: string | undefined = "t-running";
  const io: VoiceIo = {
    availability: () => ({
      available: true,
      stt: "ggml-base",
      tts: "en_US-amy-medium",
      speak: true,
    }),
    transcribe: async () => heard,
    speak: async (text) => {
      spoken.push(text);
      return true;
    },
    stopSpeaking: () => {
      speechStops++;
    },
  };
  const voice = createOsVoice({
    io,
    agent: {
      prompt: (text, from) => {
        prompts.push({ text, ...(from === undefined ? {} : { from }) });
        turn = "t1";
        return { turnId: "t1" };
      },
      stop: (turnId) => {
        stops.push(turnId);
        return null;
      },
      card: (id) => (id === CARD.cardId ? CARD : undefined),
      isLocked: () => over.locked ?? false,
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      currentTurnId: () => turn,
    },
    push: (channel, payload) => pushes.push({ channel, payload }),
    log: () => {},
    ...(over.speak === undefined ? {} : { speak: over.speak }),
  });
  const emit = (event: AgentEvent) => {
    for (const listener of listeners) listener(event);
  };
  const states = () => pushes.filter((p) => p.channel === "voice:state").map((p) => p.payload);
  return { voice, prompts, stops, spoken, emit, states, speechStops: () => speechStops };
}
const WAV = makeWav(16_000);

describe("createOsVoice (Rafiq M3 §2)", () => {
  it("classifies approve for the visible card and never answers it", async () => {
    const h = harness({ text: "Yes.", language: "en" });
    await expect(
      h.voice.utterance({ lang: "auto", cardId: "c1" }, WAV, { from: LOCAL, speakReply: true }),
    ).resolves.toEqual({
      text: "Yes.",
      lang: "en",
      action: "approve",
    });
    expect(h.states()).toEqual([{ state: "transcribing" }, { state: "idle" }]);
  });

  it("denies in Arabic from the phone", async () => {
    const h = harness({ text: "لا", language: "ar" });
    await expect(
      h.voice.utterance({ lang: "ar", cardId: "c1" }, WAV, { from: PHONE, speakReply: false }),
    ).resolves.toMatchObject({
      action: "deny",
      lang: "ar",
    });
  });

  it("answers ignored for a yes while the screen is locked", async () => {
    const h = harness({ text: "yes", language: "en" }, { locked: true });
    await expect(
      h.voice.utterance({ lang: "auto", cardId: "c1" }, WAV, { from: LOCAL, speakReply: true }),
    ).resolves.toMatchObject({ action: "ignored" });
    expect(h.prompts).toEqual([]);
  });

  it("does not speak replies when speak is off, and reports it in availability", async () => {
    const h = harness({ text: "hello", language: "en" }, { speak: false });
    expect(h.voice.availability()).toMatchObject({ speak: false });
    await h.voice.utterance({ lang: "auto" }, WAV, { from: LOCAL, speakReply: true });
    h.emit({ type: "text", turnId: "t1", delta: "Hi." });
    h.emit({ type: "turn-end", turnId: "t1", reason: "done" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.spoken).toEqual([]);
    expect(h.voice.setSpeak(true)).toBeNull();
    expect(h.voice.availability()).toMatchObject({ speak: true });
    await h.voice.utterance({ lang: "auto" }, WAV, { from: LOCAL, speakReply: true });
    h.emit({ type: "text", turnId: "t1", delta: "Hi." });
    h.emit({ type: "turn-end", turnId: "t1", reason: "done" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.spoken).toEqual(["Hi."]);
  });

  it("a yes for a card that already closed is ignored, never sent as a prompt", async () => {
    const h = harness({ text: "yes", language: "en" });
    await expect(
      h.voice.utterance({ lang: "auto", cardId: "gone" }, WAV, { from: LOCAL, speakReply: true }),
    ).resolves.toMatchObject({
      action: "ignored",
    });
    expect(h.prompts).toEqual([]);
  });

  it("sends anything else as a prompt and reads the answer aloud for the computer", async () => {
    const h = harness({ text: "make the screen brighter", language: "en" });
    await expect(
      h.voice.utterance({ lang: "auto" }, WAV, { from: LOCAL, speakReply: true }),
    ).resolves.toMatchObject({
      action: "prompt",
    });
    expect(h.prompts).toEqual([{ text: "make the screen brighter", from: LOCAL }]);
    h.emit({ type: "text", turnId: "t1", delta: "Brightness " });
    h.emit({ type: "text", turnId: "t1", delta: "is 80%." });
    h.emit({ type: "turn-end", turnId: "t1", reason: "done" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.spoken).toEqual(["Brightness is 80%."]);
    expect(h.states().slice(-2)).toEqual([{ state: "speaking", lang: "en" }, { state: "idle" }]);
  });

  it("never speaks a phone's answer on the computer", async () => {
    const h = harness({ text: "what time is it", language: "en" });
    await h.voice.utterance({ lang: "auto" }, WAV, { from: PHONE, speakReply: false });
    h.emit({ type: "text", turnId: "t1", delta: "Noon." });
    h.emit({ type: "turn-end", turnId: "t1", reason: "done" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.spoken).toEqual([]);
  });

  it("'stop' stops speech and the running turn", async () => {
    const h = harness({ text: "Stop", language: "en" });
    await expect(
      h.voice.utterance({ lang: "auto" }, WAV, { from: LOCAL, speakReply: true }),
    ).resolves.toMatchObject({
      action: "ignored",
    });
    expect(h.stops).toEqual(["t-running"]);
    expect(h.speechStops()).toBeGreaterThanOrEqual(1);
    expect(h.voice.stop()).toBeNull();
  });

  it("refuses audio that is not 16 kHz mono WAV", async () => {
    const h = harness({ text: "yes", language: "en" });
    await expect(
      h.voice.utterance({ lang: "auto" }, makeWav(16_000, { rate: 48_000 }), {
        from: LOCAL,
        speakReply: true,
      }),
    ).rejects.toMatchObject({ code: "bad-request" });
  });
});
