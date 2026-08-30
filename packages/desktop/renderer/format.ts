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

export function detectLanguage(text: string): "ar" | "en" {
  return ARABIC_RANGE.test(text) ? "ar" : "en";
}
