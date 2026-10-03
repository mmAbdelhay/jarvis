// The wide Home's pure rules: the header sub line, the Laptop meters' tone,
// the Sessions tile's caption count, tile widths and the per-project tools.
import { type Language, t } from "./i18n";

/** The Laptop tile's fill: accent below 70, warning 70-89, danger from 90. */
export function meterTone(percent: number): "accent" | "warning" | "danger" {
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warning";
  return "accent";
}

/** "1 waiting for your answer · MacBook connected": the waiting text (or the
 *  all-clear) plus the connection text when there is one. */
export function homeSubtitle(
  language: Language,
  waiting: number,
  connection: string | undefined,
): string {
  const first =
    waiting === 0
      ? t(language, "home.allClear")
      : t(language, "home.waitingCount", { count: waiting });
  return connection === undefined || connection === "" ? first : `${first} · ${connection}`;
}

/** The Sessions tile's caption count: the last bucket (today), 0 when none. */
export function todayCount(counts: readonly number[]): number {
  return counts.length === 0 ? 0 : (counts[counts.length - 1] ?? 0);
}

/** How many days the Sessions tile shows. */
export const SESSIONS_DAYS = 14;

/** Exactly `days` buckets, oldest first: padded with empty days on the left
 *  so the tile keeps its shape before the laptop has reported a history. */
export function tileDays(counts: readonly number[], days: number): number[] {
  const last = counts.slice(-days);
  return [...new Array<number>(days - last.length).fill(0), ...last];
}

/** The needs-you banner holds up to three buttons; more options stack. */
export function bannerFits(optionCount: number): boolean {
  return optionCount <= 3;
}

/** One tile's pixel width: the row is `inner` wide with `gap` between tiles. */
export function tileWidth(inner: number, columns: number, gap: number): number {
  return Math.max(0, Math.floor((inner - gap * (columns - 1)) / columns));
}

export type ProjectTool = "terminal" | "docker" | "api" | "editor";

/** Every project gets the same tools: no per-project capability data exists. */
export const PROJECT_TOOLS: readonly ProjectTool[] = ["terminal", "docker", "api", "editor"];
