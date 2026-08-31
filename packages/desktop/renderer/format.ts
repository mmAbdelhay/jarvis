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

/** Relative age, as the artboard shows it ("6m ago"). Bilingual (I2): this
 *  string is user-facing (the Changes view header), so it must not be an
 *  English-only lane beside @jarvis/core's and messages.ts's bilingual
 *  tables — same rule, applied here. Kept compact in Arabic (قبل 6د) rather
 *  than fully agreement-correct, matching the artboard's own compact
 *  English form ("6m ago", not "6 minutes ago"). */
export function formatAgo(at: number, now: number, language: "ar" | "en" = "en"): string {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 60) return language === "ar" ? "الآن" : "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return language === "ar" ? `قبل ${minutes} د` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return language === "ar" ? `قبل ${hours} س` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return language === "ar" ? `قبل ${days} يوم` : `${days}d ago`;
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
