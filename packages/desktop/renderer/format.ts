const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const ARABIC_RANGE = /[؀-ۿݐ-ݿ]/;

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), UNITS.length - 1);
  const value = bytes / 1000 ** exponent;
  const unit = UNITS[exponent] ?? "B";
  return exponent === 0 ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
}

/**
 * Formats a used/total byte pair for a single-line tile (e.g. the DISK tile),
 * matching the artboard's "312 / 994 GB" pattern: the unit is shown once, on
 * the total, using the total's unit for both numbers rather than letting each
 * side pick its own (which can print the unit twice, e.g. "312.0 GB / 994.0 GB").
 */
export function formatDiskUsage(
  usedBytes: number,
  totalBytes: number,
): { used: string; total: string } {
  const totalFormatted = formatBytes(totalBytes);
  const unit = totalFormatted.slice(totalFormatted.indexOf(" ") + 1);
  const exponent = UNITS.indexOf(unit as (typeof UNITS)[number]);
  if (exponent <= 0 || usedBytes <= 0) {
    return { used: usedBytes <= 0 ? "0" : `${Math.round(usedBytes)}`, total: `/ ${totalFormatted}` };
  }
  const usedValue = usedBytes / 1000 ** exponent;
  return { used: usedValue.toFixed(1), total: `/ ${totalFormatted}` };
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) return `${days}d ${String(hours).padStart(2, "0")}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

// Counted-noun tables for formatAgo's Arabic branch, one per unit, each
// governed by the preposition "قبل" (before/ago) — a harf jarr, so the dual
// here is the *genitive* dual (-ين), e.g. "قبل يومين", not the nominative
// dual (-ان) that a standalone label (arabicSessionsCount in messages.ts)
// would use. See messages.ts's arabicFilesCount for the fuller version of
// this same governed-vs-standalone distinction — same rule, applied here to
// three nouns instead of one.
//
// A first draft of this file mixed register — abbreviations for minutes/
// hours ("قبل 6 د", "قبل 1 س") beside a full word for days ("قبل 1 يوم") —
// which also meant the abbreviated forms never got a dual or plural at all
// (always "قبل 2 س" instead of "قبل ساعتين"). Full words throughout fixes
// both: it reads naturally in Arabic (unlike the English "m/h" abbreviation
// convention) and gives every unit the same singular/dual/3-10-plural/11+
// table.
function arabicMinutesAgo(count: number): string {
  if (count === 1) return "دقيقة";
  if (count === 2) return "دقيقتين";
  if (count <= 10) return `${count} دقائق`;
  return `${count} دقيقة`;
}

function arabicHoursAgo(count: number): string {
  if (count === 1) return "ساعة";
  if (count === 2) return "ساعتين";
  if (count <= 10) return `${count} ساعات`;
  return `${count} ساعة`;
}

function arabicDaysAgo(count: number): string {
  if (count === 1) return "يوم";
  if (count === 2) return "يومين";
  if (count <= 10) return `${count} أيام`;
  return `${count} يومًا`;
}

/** Relative age, as the artboard shows it ("6m ago"). Bilingual (I2): this
 *  string is user-facing (the Changes view header), so it must not be an
 *  English-only lane beside @jarvis/core's and messages.ts's bilingual
 *  tables — same rule, applied here. The English form stays the artboard's
 *  own compact shape ("6m ago", not "6 minutes ago"); the Arabic branch uses
 *  full, grammatically correct counted-noun forms instead of mirroring that
 *  abbreviation — see the tables above for why. */
export function formatAgo(at: number, now: number, language: "ar" | "en" = "en"): string {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 60) return language === "ar" ? "الآن" : "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return language === "ar" ? `قبل ${arabicMinutesAgo(minutes)}` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return language === "ar" ? `قبل ${arabicHoursAgo(hours)}` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return language === "ar" ? `قبل ${arabicDaysAgo(days)}` : `${days}d ago`;
}

export function detectLanguage(text: string): "ar" | "en" {
  return ARABIC_RANGE.test(text) ? "ar" : "en";
}

// Matches the clock's own en-GB, 24h formatting (startClock in app.ts) so a
// history row's "ended" timestamp reads consistently with the topbar clock.
export function formatEndedAt(epochMs: number): string {
  const date = new Date(epochMs);
  const day = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const time = date.toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit" });
  return `${day} · ${time}`;
}
