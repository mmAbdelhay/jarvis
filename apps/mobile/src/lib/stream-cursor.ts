// The UTF-16 stream cursor (Task 4). This is the client half of the M5
// plan's ruling 10 attach contract: `rendered` tracks the UTF-16 code-unit
// offset the caller has already written; `applyChunk`/`applySnapshot` turn
// a server frame into the (possibly trimmed, possibly gap-marked) text to
// write next, never mutating anything themselves — the caller owns
// `rendered` and the sink.
//
// See the mobile milestone 7, task 4 plan (docs/superpowers/plans)
// and docs/superpowers/plans/2026-09-17-jarvis-mobile-5-streams.md ruling
// 10 for the maths this re-derives.

import type { StreamSnapshot } from "@jarvis/core";

export type CursorStep = {
  write: string;
  gapUnits: number;
  reset: boolean;
  rendered: number;
};

/**
 * Slices `source` from `start`, never leaving a lone low surrogate at the
 * front of the result. When `start` lands on the low half of a surrogate
 * pair, the slice begins one unit later and that one unit counts as a gap
 * (never possible when a laptop's offsets are consistent, but must not
 * corrupt the terminal if it ever happens).
 */
function safeSliceFrom(source: string, start: number): { text: string; skipped: number } {
  if (start <= 0) return { text: source, skipped: 0 };
  if (start >= source.length) return { text: "", skipped: 0 };
  const code = source.charCodeAt(start);
  const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
  if (isLowSurrogate) {
    return { text: source.slice(start + 1), skipped: 1 };
  }
  return { text: source.slice(start), skipped: 0 };
}

export function applyChunk(rendered: number, offset: number, chunk: string): CursorStep {
  const end = offset + chunk.length;
  if (end <= rendered) {
    return { write: "", gapUnits: 0, reset: false, rendered };
  }
  if (offset > rendered) {
    return { write: chunk, gapUnits: offset - rendered, reset: false, rendered: end };
  }
  const { text, skipped } = safeSliceFrom(chunk, rendered - offset);
  return { write: text, gapUnits: skipped, reset: false, rendered: end };
}

export function applySnapshot(rendered: number, snapshot: StreamSnapshot): CursorStep {
  const { text, end } = snapshot;
  if (end < rendered) {
    return { write: text, gapUnits: Math.max(0, end - text.length), reset: true, rendered: end };
  }
  if (end === rendered) {
    return { write: "", gapUnits: 0, reset: false, rendered };
  }
  const missing = end - rendered;
  if (missing <= text.length) {
    const { text: sliced, skipped } = safeSliceFrom(text, text.length - missing);
    return { write: sliced, gapUnits: skipped, reset: false, rendered: end };
  }
  return { write: text, gapUnits: missing - text.length, reset: false, rendered: end };
}

export function parseSnapshot(value: unknown): StreamSnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.text !== "string") return undefined;
  if (typeof obj.end !== "number" || !Number.isSafeInteger(obj.end)) return undefined;
  if (obj.end < 0 || obj.end < obj.text.length) return undefined;
  return { text: obj.text, end: obj.end };
}

export function parseStreamChunk(
  payload: unknown,
  keyField: string,
  key: string,
): { chunk: string; offset: number } | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const obj = payload as Record<string, unknown>;
  if (typeof obj[keyField] !== "string" || obj[keyField] !== key) return undefined;
  if (typeof obj.chunk !== "string") return undefined;
  if (typeof obj.offset !== "number" || !Number.isSafeInteger(obj.offset) || obj.offset < 0) {
    return undefined;
  }
  return { chunk: obj.chunk, offset: obj.offset };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function gapMarker(droppedBytes: number | undefined): string {
  const body = droppedBytes === undefined ? "⋯" : `⋯ ${formatBytes(droppedBytes)} ⋯`;
  return `\r\n\x1b[2m${body}\x1b[22m\r\n`;
}
