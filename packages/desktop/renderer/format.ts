const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const ARABIC_RANGE = /[؀-ۿݐ-ݿ]/;

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), UNITS.length - 1);
  const value = bytes / 1000 ** exponent;
  const unit = UNITS[exponent] ?? "B";
  return exponent === 0 ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
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
