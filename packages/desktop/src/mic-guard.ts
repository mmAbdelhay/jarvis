// The one microphone is shared by the voice turn (Alt+Space) and the chat's
// dictation: whichever holds it, the other is refused, never queued. Kept as
// its own small seam so both directions can be tested without the app.

export type MicGuardDeps = {
  /** A dictation is starting, recording or stopping. */
  dictationActive(): boolean;
  /** The voice turn's recorder is running. */
  voiceRecording(): boolean;
  startRecording(): void;
  /** Tells the windows the voice turn is listening. */
  announce(listening: boolean): void;
};

export function createMicGuard(deps: MicGuardDeps): {
  /** Starts the voice turn unless a dictation holds the microphone. */
  startVoice(): void;
  /** What dictation asks before it records. */
  voiceHoldsMicrophone(): boolean;
} {
  return {
    startVoice() {
      if (deps.dictationActive()) return;
      deps.startRecording();
      deps.announce(true);
    },
    voiceHoldsMicrophone: () => deps.voiceRecording(),
  };
}
