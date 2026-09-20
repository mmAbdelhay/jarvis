import type { ProviderStatus, RateWindow } from "./types.js";
import { remainingPercent } from "./types.js";

type Language = "ar" | "en";

/**
 * Same language-in / string-out shape as git/messages.ts. Ruling P30 governs
 * every string in this file: numbers are interpolated at clause tails, the
 * form is label-value rather than a sentence with a number dropped into it,
 * and no duration is ever counted in words ("3 ساعات" / "قبل يومين") — reset
 * times and read times are absolute clock times, which sidesteps Arabic
 * counted-noun agreement entirely and is also more honest, since a cached
 * reading's reset instant does not drift while the reading ages.
 *
 * Clock times are formatted with the "en-GB" locale in both languages, so the
 * digits match the dashboard clock and the reset time reads identically
 * wherever it appears. Percentages are likewise rendered with plain ASCII
 * digits and a "%" sign in both languages, never "٪" or Eastern Arabic
 * digits: a bare number followed by a symbol carries no grammatical gender
 * or countability of its own (unlike a counted noun — "38%" is a measurement,
 * not "38 files"), so there is no agreement question to get wrong, and using
 * the same glyphs as the reset clock keeps every number in this file reading
 * identically in both languages, which is also what git/messages.ts already
 * does for its own numbers.
 */
function clock(iso: string | number): string {
  const date = typeof iso === "number" ? new Date(iso) : new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A reset within a day of the reading is a clock time; a farther one (Copilot's monthly window) is a day, e.g. "1 Oct". */
function resetLabel(iso: string, readAt: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  if (date.getTime() - readAt < DAY_MS) return clock(iso);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const HEALTH_NOTE: Record<"degraded" | "outage" | "unknown", Record<Language, string>> = {
  degraded: { ar: "الخدمة متعثرة", en: "service degraded" },
  outage: { ar: "الخدمة متوقفة", en: "service down" },
  unknown: { ar: "حالة الخدمة غير معروفة", en: "service status unknown" },
};

const UNKNOWN_CAPACITY: Record<
  "unsupported" | "unavailable" | "never-read",
  Record<Language, string>
> = {
  unsupported: { ar: "لا يوفّر قراءة للسعة", en: "no capacity reading available" },
  // Every source is free and local-ish (a snapshot file, Codex's logs, the
  // signed-in gh — SETUP.md §5); "unavailable" means that account's source
  // has produced nothing yet, so say that rather than "failed".
  unavailable: { ar: "لا توجد قراءة استخدام بعد", en: "no usage reading yet" },
  "never-read": { ar: "لم تُقرأ السعة بعد", en: "capacity not checked yet" },
};

function capacityClause(status: ProviderStatus, language: Language): string {
  const { capacity } = status;
  if (capacity.state === "unknown") return UNKNOWN_CAPACITY[capacity.reason][language];

  const left = remainingPercent(capacity.primary);
  const resets = resetLabel(capacity.primary.resetsAt, capacity.readAt);
  const readAt = clock(capacity.readAt);
  return language === "ar"
    ? `المتبقي ${left}% · يتجدد ${resets} · حتى ${readAt}`
    : `${left}% left · resets ${resets} · as of ${readAt}`;
}

/**
 * One provider, one line. The account id leads (it is what the user says out
 * loud to pick an account), every value that follows is its own tail-anchored
 * clause, and a healthy provider says nothing about health — silence is the
 * good news, and a line that always carries "operational" trains the eye to
 * skip the one word that matters.
 */
export function providerStatusLine(status: ProviderStatus, language: Language): string {
  const parts = [status.id, capacityClause(status, language)];
  if (status.health.state !== "ok") parts.push(HEALTH_NOTE[status.health.state][language]);
  return parts.join(" — ");
}

export function providerReportText(
  statuses: readonly ProviderStatus[],
  language: Language,
): string {
  if (statuses.length === 0) {
    return language === "ar" ? "لا توجد حسابات مُعرّفة." : "No providers are configured.";
  }
  return statuses.map((status) => providerStatusLine(status, language)).join("\n");
}

/**
 * The startup report's capacity half. Deliberately lists only accounts that
 * actually have a reading: at launch the others are either unreadable in
 * principle or simply not paid for yet, and a launch message full of "not
 * checked yet" is noise. Returns "" when there is nothing to say, and the
 * caller then sends no turn at all.
 */
export function capacityReportText(
  statuses: readonly ProviderStatus[],
  language: Language,
): string {
  const known = statuses.filter((status) => status.capacity.state === "known");
  if (known.length === 0) return "";
  const label = language === "ar" ? "السعة المتبقية:" : "Capacity left:";
  return [label, ...known.map((status) => providerStatusLine(status, language))].join("\n");
}

/** Re-exported for callers that only need the window arithmetic. */
export type { RateWindow };
