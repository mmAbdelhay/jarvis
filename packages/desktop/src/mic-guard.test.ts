import { describe, expect, it, vi } from "vitest";
import { createMicGuard } from "./mic-guard.js";

function setup(state: { dictating?: boolean; recording?: boolean } = {}) {
  const s = { dictating: state.dictating ?? false, recording: state.recording ?? false };
  const startRecording = vi.fn(() => {
    s.recording = true;
  });
  const announce = vi.fn();
  const guard = createMicGuard({
    dictationActive: () => s.dictating,
    voiceRecording: () => s.recording,
    startRecording,
    announce,
  });
  return { s, guard, startRecording, announce };
}

describe("one microphone for the voice turn and dictation", () => {
  it("starts a voice turn when nothing else holds the microphone", () => {
    const t = setup();
    t.guard.startVoice();
    expect(t.startRecording).toHaveBeenCalledTimes(1);
    expect(t.announce).toHaveBeenCalledWith(true);
  });

  it("refuses a voice turn while a dictation is recording, without a sound or a signal", () => {
    const t = setup({ dictating: true });
    t.guard.startVoice();
    expect(t.startRecording).not.toHaveBeenCalled();
    expect(t.announce).not.toHaveBeenCalled();
  });

  it("tells dictation the microphone is busy while a voice turn records", () => {
    const t = setup();
    expect(t.guard.voiceHoldsMicrophone()).toBe(false);
    t.guard.startVoice();
    expect(t.guard.voiceHoldsMicrophone()).toBe(true);
  });

  it("goes both ways in one session: voice, then dictation refused, then free again", () => {
    const t = setup();
    t.guard.startVoice();
    expect(t.guard.voiceHoldsMicrophone()).toBe(true);
    t.s.recording = false;
    expect(t.guard.voiceHoldsMicrophone()).toBe(false);
    t.s.dictating = true;
    t.guard.startVoice();
    expect(t.startRecording).toHaveBeenCalledTimes(1);
  });
});
