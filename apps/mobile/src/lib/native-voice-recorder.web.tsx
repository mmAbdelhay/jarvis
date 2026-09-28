// The browser build's recorder (Task 13): MediaRecorder over
// getUserMedia, in place of `expo-audio`. Decisions live in
// voice-recorder.ts (mime preference, permission mapping, bit rate); the
// 120 s cap, the 4 MiB limit and retry/discard all stay in
// voice-controller.ts, exactly as on native — this file only produces a
// `Recording` whose `format` names the container actually recorded
// ("m4a" for audio/mp4, "webm" for audio/webm;codecs=opus), which the
// upload meta carries so the laptop decodes the right thing.
//
// The recording is an in-memory Blob registered in `webBlobs`; its
// `blob:` url stands in for the native `file://` uri, and the web
// `RecordingFiles` (native-recording-files.web.ts) reads/sizes/removes it.
import { useMemo } from "react";
import { realClock } from "./clock";
import {
  type MicPermission,
  type Recording,
  type RecordingFormat,
  type VoiceRecorder,
  WEB_RECORDING_BITS_PER_SECOND,
  webMicPermission,
  webRecordingCandidates,
} from "./voice-recorder";
import { webBlobs } from "./web-blob-registry";

type ActiveRecording = {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  mimeType: string;
  format: RecordingFormat;
  startedAt: number;
};

async function microphoneState(): Promise<string | undefined> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state;
  } catch {
    // No Permissions API, or it does not know "microphone" (older Safari).
    return undefined;
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function isTypeSupported(mimeType: string): boolean {
  return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType);
}

function waitForStop(recorder: MediaRecorder): Promise<void> {
  return new Promise((resolve) => {
    if (recorder.state === "inactive") {
      resolve();
      return;
    }
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.addEventListener("error", () => resolve(), { once: true });
    recorder.stop();
  });
}

function createWebVoiceRecorder(): VoiceRecorder {
  let active: ActiveRecording | undefined;

  return {
    async permission(): Promise<MicPermission> {
      return webMicPermission(await microphoneState());
    },

    async requestPermission(): Promise<MicPermission> {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stopTracks(stream);
        return "granted";
      } catch {
        // A dismissed prompt leaves the state at "prompt" (ask again next
        // time); a refusal the browser remembers reads back as "denied".
        const mapped = webMicPermission(await microphoneState());
        return mapped === "undetermined" ? "denied" : mapped;
      }
    },

    async start(): Promise<void> {
      if (active !== undefined) return;
      const candidates = webRecordingCandidates(isTypeSupported);
      if (candidates.length === 0) {
        throw new Error("web recorder: no supported audio format");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // The preferred format, then one retry with the next — the native
      // recorder's one-retry rule.
      for (const candidate of candidates) {
        try {
          const recorder = new MediaRecorder(stream, {
            mimeType: candidate.mimeType,
            audioBitsPerSecond: WEB_RECORDING_BITS_PER_SECOND,
          });
          const chunks: Blob[] = [];
          recorder.addEventListener("dataavailable", (event) => {
            if (event.data.size > 0) chunks.push(event.data);
          });
          recorder.start();
          active = {
            recorder,
            stream,
            chunks,
            mimeType: recorder.mimeType || candidate.mimeType,
            format: candidate.format,
            startedAt: realClock.now(),
          };
          return;
        } catch {
          // Try the next candidate.
        }
      }
      stopTracks(stream);
      throw new Error("web recorder: could not start");
    },

    async stop(): Promise<Recording | undefined> {
      const current = active;
      if (current === undefined) return undefined;
      active = undefined;
      // Snapshotted before stopping, as on native.
      const durationMs = realClock.now() - current.startedAt;
      try {
        await waitForStop(current.recorder);
      } finally {
        stopTracks(current.stream);
      }
      const blob = new Blob(current.chunks, { type: current.mimeType });
      if (blob.size === 0 || !durationMs) return undefined;
      // No logging of the blob url here or anywhere in this file.
      return { uri: webBlobs.add(blob), durationMs, format: current.format };
    },

    elapsedMs(): number {
      return active === undefined ? 0 : realClock.now() - active.startedAt;
    },
  };
}

export function useNativeVoiceRecorder(): VoiceRecorder {
  return useMemo(createWebVoiceRecorder, []);
}
