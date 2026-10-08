// @jarvis/platform/voice: what the Jarvis OS daemon loads for push-to-talk
// (Rafiq M3 §2) — Jarvis's own whisper and Piper wrappers, nothing else.
// Nothing here may import node-pty, node:sqlite or the Agent SDK;
// desktop/src/daemon/os/os-bundle-graph.test.ts holds the line.
export { parseWhisperOutput, type Transcript, transcribe, type WhisperConfig } from "../stt.js";
export {
  audioPlayer,
  defaultProcessRunner,
  onPath,
  type PiperConfig,
  PiperSpeech,
  type ProcessRunner,
  type SpokenProcess,
} from "../piper.js";
export { type LimitedRunResult, runCommandWithLimits } from "../spawn.js";
