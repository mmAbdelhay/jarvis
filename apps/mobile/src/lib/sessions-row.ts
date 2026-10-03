// What one Sessions row says, decided apart from drawing it: its look
// (active, waiting, done), the time on its trailing edge, its sub line and
// the +/- totals. Pure, so each rule is unit tested.
import type { ChangeCountsView } from "./change-counts";
import { formatSessionElapsed } from "./format";
import { type Language, t } from "./i18n";
import { isActiveRow, type MergedRow, rowMoment } from "./sessions-merge";

export type RowVariant = "active" | "waiting" | "done";

export function rowVariant(row: Pick<MergedRow, "source" | "state">): RowVariant {
  if (!isActiveRow(row)) return "done";
  return row.state === "waiting" ? "waiting" : "active";
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** 24-hour "22:10", Latin digits in both languages. */
function clockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The time at the row's trailing edge: how long an active row has run, how
 * long a session that ended today lasted, and the clock time an older one
 * ended at.
 */
export function rowTimeLabel(row: MergedRow, now: number): string {
  if (isActiveRow(row)) return formatSessionElapsed(now - row.startedAt);
  const moment = rowMoment(row);
  if (sameDay(moment, now)) return formatSessionElapsed(moment - row.startedAt);
  return clockTime(moment);
}

/** "api · claude-main", plus "done", "imported" or "outside Jarvis" when the
 *  row is not simply live in Jarvis. */
export function rowSubtitle(language: Language, row: MergedRow): string {
  const status = row.imported
    ? t(language, "sessions.imported").toLocaleLowerCase()
    : row.origin === "external" && isActiveRow(row)
      ? t(language, "sessions.external")
      : isActiveRow(row)
        ? undefined
        : t(
            language,
            row.state === "dead" ? "sessions.state.dead" : "sessions.state.done",
          ).toLocaleLowerCase();
  return [row.label, row.agentId, status]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
}

export type RowCounts = { insertions: number; deletions: number };

/** The +/- totals: the laptop's live push when it has the session, else the
 *  totals saved with a finished one. Nothing when both are zero or unknown. */
export function rowCounts(row: MergedRow, live: ChangeCountsView): RowCounts | undefined {
  const pushed = Object.hasOwn(live, row.id) ? live[row.id] : undefined;
  const counts =
    pushed !== undefined
      ? { insertions: pushed.insertions, deletions: pushed.deletions }
      : row.insertions === undefined && row.deletions === undefined
        ? undefined
        : { insertions: row.insertions ?? 0, deletions: row.deletions ?? 0 };
  if (counts === undefined || (counts.insertions === 0 && counts.deletions === 0)) return undefined;
  return counts;
}

/** A row Resume can act on: finished, and tied to a project. */
export function resumable(row: Pick<MergedRow, "state" | "project">): boolean {
  return (row.state === "done" || row.state === "dead") && row.project !== null;
}
