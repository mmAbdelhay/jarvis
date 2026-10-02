// What the Home screen's capacity cards show, read from the laptop's
// `providers:update` push (each account's current window) and `usage:history`
// (the same window's remaining percent over the last day). Parsed field by
// field: a reading that does not have the shape is left out, never guessed.

export type CapacityCard = {
  id: string;
  /** Which window the figure is: "5h" for Claude and Codex, "month" for
   *  Copilot's premium-request allowance. */
  window: "5h" | "month" | "window";
  /** Remaining, 0–100, floored — never more than is really left. */
  left: number;
  /** Epoch ms the window resets. */
  resetsAt: number;
};

export type CapacityTrend = { id: string; points: number[] };

const WINDOW_BY_VENDOR: Record<string, CapacityCard["window"]> = {
  anthropic: "5h",
  openai: "5h",
  github: "month",
};

export function parseProviderCapacity(value: unknown): CapacityCard[] {
  if (!Array.isArray(value)) return [];
  const cards: CapacityCard[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const provider = item as Record<string, unknown>;
    if (typeof provider.id !== "string") continue;
    const capacity = provider.capacity;
    if (typeof capacity !== "object" || capacity === null) continue;
    const known = capacity as Record<string, unknown>;
    if (known.state !== "known") continue;
    const primary = known.primary;
    if (typeof primary !== "object" || primary === null) continue;
    const window = primary as Record<string, unknown>;
    if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
    if (typeof window.resetsAt !== "string") continue;
    const resetsAt = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetsAt)) continue;
    const vendor = typeof provider.vendor === "string" ? provider.vendor : "";
    cards.push({
      id: provider.id,
      window: WINDOW_BY_VENDOR[vendor] ?? "window",
      left: Math.floor(Math.max(0, Math.min(100, 100 - window.usedPercent))),
      resetsAt,
    });
  }
  return cards;
}

/** At most this many bars in a card's trend: enough to show a shape, few
 *  enough that each bar is still a few points wide on a phone. */
export const TREND_BARS = 12;

/**
 * Each account's remaining-percent history, reduced to TREND_BARS evenly
 * spaced readings (oldest first). An account with fewer readings keeps
 * the ones it has.
 */
export function parseCapacityTrends(value: unknown): CapacityTrend[] {
  if (typeof value !== "object" || value === null) return [];
  const capacity = (value as Record<string, unknown>).capacity;
  if (!Array.isArray(capacity)) return [];
  const trends: CapacityTrend[] = [];
  for (const item of capacity) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || !Array.isArray(entry.points)) continue;
    const lefts: number[] = [];
    for (const point of entry.points) {
      if (typeof point !== "object" || point === null) continue;
      const left = (point as Record<string, unknown>).left;
      if (typeof left === "number" && Number.isFinite(left)) {
        lefts.push(Math.max(0, Math.min(100, left)));
      }
    }
    if (lefts.length === 0) continue;
    trends.push({ id: entry.id, points: sample(lefts, TREND_BARS) });
  }
  return trends;
}

function sample(values: number[], count: number): number[] {
  if (values.length <= count) return values;
  const step = (values.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, index) => values[Math.round(index * step)] ?? 0);
}

/** "1h 40m", "25m", or "<1m" until `resetsAt`; undefined once it has
 *  passed (the reading is stale and the card says nothing about resets). */
export function resetsIn(resetsAt: number, now: number): string | undefined {
  const minutes = Math.floor((resetsAt - now) / 60_000);
  if (minutes < 0) return undefined;
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (hours >= 48) return `${Math.floor(hours / 24)}d`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
