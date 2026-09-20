// The Sessions screen's ended-group headers (fix round, 2026-09-19
// redesign): `Sessions.dc.html` shows a "TODAY" header above the ended
// list, but `sessions.tsx` used to render that literal text above every
// ended row regardless of when it actually ended. This buckets ended rows
// by calendar day (local time) — "Today" / "Yesterday" / a plain date —
// and groups them in the order they already arrive in (sessions-store.ts's
// `groupAndSort` sorts `ended` by `endedAt`/`lastActivityAt` descending, so
// same-day rows are always contiguous; this never re-sorts them).

import type { SessionRowView } from "./sessions-store";

export type SessionDateLabel =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "date"; ms: number };

export type SessionDateGroup = { label: SessionDateLabel; rows: SessionRowView[] };

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The timestamp a row's group is keyed on: when it ended, else its last
 *  activity — the same fallback `groupAndSort` already sorts ended rows by. */
function rowMoment(row: SessionRowView): number {
  return row.endedAt ?? row.lastActivityAt;
}

export function sessionDateLabel(ms: number, nowMs: number): SessionDateLabel {
  const dayMs = 86_400_000;
  const today = startOfDay(nowMs);
  const day = startOfDay(ms);
  if (day === today) return { kind: "today" };
  if (day === today - dayMs) return { kind: "yesterday" };
  return { kind: "date", ms: day };
}

function sameLabel(a: SessionDateLabel, b: SessionDateLabel): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "date" && b.kind === "date") return a.ms === b.ms;
  return true;
}

/** Groups `rows` (already sorted, most recent first) into contiguous
 *  same-day buckets. A row out of order relative to its predecessor (which
 *  should not happen given `groupAndSort`'s own sort) still gets a group of
 *  its own rather than being silently merged into the wrong day. */
export function groupEndedByDate(
  rows: readonly SessionRowView[],
  nowMs: number,
): SessionDateGroup[] {
  const groups: SessionDateGroup[] = [];
  for (const row of rows) {
    const label = sessionDateLabel(rowMoment(row), nowMs);
    const last = groups.at(-1);
    if (last !== undefined && sameLabel(last.label, label)) {
      last.rows.push(row);
    } else {
      groups.push({ label, rows: [row] });
    }
  }
  return groups;
}
