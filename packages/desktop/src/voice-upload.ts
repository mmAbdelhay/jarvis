// remote:uploadAudio's own body (M8 Task 4): the validated, replay-safe
// handler behind the blob table (remote-blob.ts). It owns exactly one
// thing beyond validation — a per-device replay memory (ruling 9) — and
// hands everything past "here is a wav file" to voice-turn.ts's
// handleUtterance, shared with the desktop recorder.
//
// Global constraints this file exists to uphold:
//   - a phone's bytes are written to one file, audio.m4a, inside a fresh
//     temp directory the caller creates and removes; no phone-supplied
//     string ever becomes part of a path or an argv element (meta's
//     targetSessionId is the only phone string that reaches handleUtterance
//     at all, and only after parseVoiceUploadMeta has validated its shape);
//   - the only phone-supplied value that may appear in a log line is the
//     validated 32-hex turnId — never a transcript, a path or a dependency
//     error's own message;
//   - a laptop-side failure sent to the phone is always the generic
//     voiceTurnFailed text (ruling 17); the real detail never crosses the
//     wire, and is never logged either — but which *step* failed is (Task
//     4 review I1, same pattern as voice-turn.ts's "voice-turn: transcription
//     failed"/"voice-turn: brain failed"): a `failed` outcome logs a
//     site-specific category — `failed:tmpdir`, `failed:write`,
//     `failed:transcode` or `failed:utterance` — never `transcoded.detail`
//     or a caught error's own message/stack.
import { join } from "node:path";
import { isMp4Audio } from "@jarvis/platform";
import { MAX_VOICE_BYTES, parseVoiceUploadMeta, type VoiceUploadResult } from "@jarvis/wire";
import { MESSAGES } from "./messages.js";
import type { BlobHandler } from "./remote-blob.js";
import type { HandledUtterance, UtteranceOutcome, UtteranceRequest } from "./voice-turn.js";

export const TRANSCODE_TIMEOUT_MS = 30_000;
export const TRANSCRIBE_TIMEOUT_MS = 60_000;
export const RECENT_TURNS_PER_DEVICE = 32;
export const RECENT_TURN_TTL_MS = 600_000;

export type VoiceUploadDeps = {
  now(): number;
  makeTempDir(): Promise<string>;
  writeFileExclusive(path: string, bytes: Uint8Array): Promise<void>;
  removeDir(path: string): Promise<void>;
  transcode(input: string, output: string): Promise<{ ok: true } | { ok: false; detail: string }>;
  utterance(request: UtteranceRequest): Promise<HandledUtterance>;
  language: "ar" | "en";
  log(line: string): void;
};

type Entry =
  | { status: "pending"; insertedAt: number }
  | { status: "done"; insertedAt: number; result: VoiceUploadResult };

function mapOutcome(outcome: UtteranceOutcome): VoiceUploadResult {
  switch (outcome.kind) {
    case "failed":
      return { kind: "failed", text: outcome.text, language: outcome.language };
    case "silence":
      return { kind: "silence", text: outcome.text, language: outcome.language };
    case "session":
      return {
        kind: "heard",
        route: "session",
        sessionId: outcome.sessionId,
        transcript: outcome.transcript,
        language: outcome.language,
      };
    case "brain":
      return {
        kind: "heard",
        route: "brain",
        transcript: outcome.transcript,
        language: outcome.language,
      };
  }
}

export function createVoiceUploadHandler(deps: VoiceUploadDeps): BlobHandler {
  // deviceId -> turnId -> Entry, in insertion order — Map preserves the
  // order a key was first set even when its value is later replaced
  // (pending -> done), which is what makes "evict the oldest done entry"
  // a plain forward iteration rather than a second sort.
  const devices = new Map<string, Map<string, Entry>>();

  function deviceEntries(deviceId: string): Map<string, Entry> {
    let entries = devices.get(deviceId);
    if (entries === undefined) {
      entries = new Map();
      devices.set(deviceId, entries);
    }
    return entries;
  }

  // M12 Task 7 (M8 T4-a review carry, tracked in the M9 T3 ledger): never
  // evicts a `pending` entry, however old its reservation looks — a write
  // still genuinely in flight (writeFileExclusive/transcode/utterance, all
  // real time) must keep its slot regardless of what the clock does, the
  // same discipline file-upload.ts's own pruneExpired uses. Only a
  // committed `done` entry past the TTL is ever pruned here.
  function pruneStale(entries: Map<string, Entry>, now: number): void {
    for (const [turnId, entry] of entries) {
      if (entry.status === "done" && now - entry.insertedAt > RECENT_TURN_TTL_MS) {
        entries.delete(turnId);
      }
    }
  }

  // Never evicts a pending entry — a Retry racing an eviction must never
  // lose track of a turn that is genuinely still in flight.
  function evictOldestDoneIfOverCap(entries: Map<string, Entry>): void {
    for (const [turnId, entry] of entries) {
      if (entries.size <= RECENT_TURNS_PER_DEVICE) return;
      if (entry.status === "done") entries.delete(turnId);
    }
  }

  return async (args, bytes, origin) => {
    const started = deps.now();
    const deviceId = origin.deviceId;
    const language = deps.language;

    // The one log line per call (global constraints, rule 5.8): never the
    // transcript, never a meta value other than the already-validated
    // turnId, never a dependency's own error message or a filesystem path.
    // `kind` is the outcome's own kind for everything but a `failed` one,
    // where it is instead a fixed site category (`failed:tmpdir` etc.) —
    // still no error message, stderr or path, just which step failed.
    function logOutcome(kind: string, turnId: string | undefined): void {
      try {
        const elapsed = deps.now() - started;
        deps.log(
          `voice-upload: ${kind} device=${deviceId} turn=${turnId ?? "-"} bytes=${bytes.length} ms=${elapsed}`,
        );
      } catch {
        // Diagnostics can't break an upload.
      }
    }

    const meta = args.length === 1 ? parseVoiceUploadMeta(args[0]) : undefined;
    if (
      meta === undefined ||
      bytes.length < 1 ||
      bytes.length > MAX_VOICE_BYTES ||
      !isMp4Audio(bytes)
    ) {
      const result: VoiceUploadResult = {
        kind: "invalid",
        text: MESSAGES.voiceUploadInvalid(language),
        language,
      };
      logOutcome("invalid", meta?.turnId);
      return result;
    }

    const entries = deviceEntries(deviceId);
    pruneStale(entries, deps.now());

    const existing = entries.get(meta.turnId);
    if (existing !== undefined) {
      if (existing.status === "pending") {
        const result: VoiceUploadResult = {
          kind: "busy",
          text: MESSAGES.voiceUploadBusy(language),
          language,
        };
        logOutcome("busy", meta.turnId);
        return result;
      }
      logOutcome("replayed", meta.turnId);
      return existing.result;
    }

    for (const entry of entries.values()) {
      if (entry.status === "pending") {
        const result: VoiceUploadResult = {
          kind: "busy",
          text: MESSAGES.voiceUploadBusy(language),
          language,
        };
        logOutcome("busy", meta.turnId);
        return result;
      }
    }

    const insertedAt = deps.now();
    entries.set(meta.turnId, { status: "pending", insertedAt });
    evictOldestDoneIfOverCap(entries);

    let dir: string;
    try {
      dir = await deps.makeTempDir();
    } catch {
      entries.delete(meta.turnId);
      const result: VoiceUploadResult = {
        kind: "failed",
        text: MESSAGES.voiceTurnFailed(language),
        language,
      };
      logOutcome("failed:tmpdir", meta.turnId);
      return result;
    }

    try {
      const inputPath = join(dir, "audio.m4a");
      const outputPath = join(dir, "audio.wav");
      let outcomeResult: VoiceUploadResult;
      let logKind: string;
      // Tracks which step is in flight so a throw anywhere in this block
      // can be blamed on the right one without ever logging the error
      // itself — set immediately before the await it names.
      let site: "write" | "transcode" | "utterance" = "write";
      try {
        await deps.writeFileExclusive(inputPath, bytes);
        site = "transcode";
        const transcoded = await deps.transcode(inputPath, outputPath);
        if (!transcoded.ok) {
          outcomeResult = { kind: "failed", text: MESSAGES.voiceTurnFailed(language), language };
          logKind = "failed:transcode";
        } else {
          site = "utterance";
          const handled = await deps.utterance({
            wavPath: outputPath,
            targetSessionId: meta.targetSessionId,
            origin: { kind: "remote", replyTo: meta.turnId },
          });
          outcomeResult = mapOutcome(handled.outcome);
          logKind = outcomeResult.kind;
        }
      } catch {
        outcomeResult = { kind: "failed", text: MESSAGES.voiceTurnFailed(language), language };
        logKind = `failed:${site}`;
      }

      if (outcomeResult.kind === "failed" || outcomeResult.kind === "invalid") {
        entries.delete(meta.turnId);
      } else {
        entries.set(meta.turnId, { status: "done", insertedAt, result: outcomeResult });
      }
      logOutcome(logKind, meta.turnId);
      return outcomeResult;
    } finally {
      // Whisper has finished reading the wav by the time handleUtterance's
      // own promise resolves, so it is always safe to remove the temp
      // directory here — including when a step above threw. main.ts's
      // removeDir already swallows its own rejection; this catch is
      // defensive so a future removeDir that forgets to would still never
      // propagate past this handler (review M7).
      try {
        await deps.removeDir(dir);
      } catch {
        // Cleanup can't fail the upload's own response.
      }
    }
  };
}
