// Number formatting for the Dashboard's metric tiles (Task 6). Every
// function here returns Latin digits in both languages — the "Arabic
// digits are not used" rule from the brief — so only bilingual copy (unit
// words, the unavailable string) comes from `t`/`STRINGS`; numeric units
// like "KiB" or "Mbps" are plain ASCII abbreviations, identical in both
// languages, and are not routed through STRINGS: every STRINGS entry must
// differ between ar and en (i18n.test.ts), which an ASCII unit label never
// would.

import type { Language } from "./i18n";
import { t } from "./i18n";

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** Strips a trailing ".0" so an exact multiple reads "8 GiB", not "8.0 GiB". */
function oneDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function formatBytes(bytes: number, _language: Language): string {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let value = safeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${oneDecimal(value)} ${BYTE_UNITS[unitIndex]}`;
}

export function formatPercent(value: number): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  return `${Math.round(safeValue)}%`;
}

export function formatMbps(value: number, _language: Language): string {
  const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
  return `${oneDecimal(safeValue)} Mbps`;
}

export function formatUptime(seconds: number, _language: Language): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatTemperature(c: number | undefined, language: Language): string {
  if (c === undefined) {
    return t(language, "metric.unavailable");
  }
  return `${Math.round(c)}°C`;
}

// Fix round (2026-09-19): the Dashboard/Sessions row "elapsed mono" field
// the boards show (`12m`, `1h 04m`) — a plain duration, Latin digits in
// both languages like every other formatter here. `ms` is clamped to 0 so
// a clock skew or an ended-before-started edge case never renders a
// negative duration.
export function formatSessionElapsed(ms: number): string {
  const totalMinutes = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60_000) : 0;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  }
  return `${minutes}m`;
}

// Fix round (2026-09-19): the Voice transcript's "Spoken · HH:MM" meta line
// — local wall-clock time, 24-hour, zero-padded, Latin digits in both
// languages (the same "no Arabic digits" rule as every other formatter
// here). Local time (not UTC) so it reads as the time the user actually
// saw on their phone.
export function formatClockTime(ms: number): string {
  const date = new Date(Number.isFinite(ms) ? ms : 0);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}
