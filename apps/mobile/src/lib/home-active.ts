// The "Active" list on phone Home: the live sessions, the ones waiting for
// the user first. Pure, so the ordering and the sub line are unit tested.
import type { ChangeCount, ChangeCountsView } from "./change-counts";
import type { SessionSummary } from "./dashboard-store";
import { formatSessionElapsed } from "./format";
import { type Language, t } from "./i18n";

export type ActiveRow = {
  id: string;
  title: string;
  project: string | null;
  agentId: string;
  waiting: boolean;
  /** Found by the process scan: outside Jarvis, so it cannot be opened. */
  external: boolean;
  startedAt: number;
  counts?: ChangeCount;
};

function isLive(session: SessionSummary): boolean {
  return session.state === "starting" || session.state === "running" || session.state === "waiting";
}

/** Live sessions, waiting first, then the most recently started. */
export function activeRows(
  sessions: readonly SessionSummary[],
  counts: ChangeCountsView,
): ActiveRow[] {
  return sessions
    .filter(isLive)
    .map((session) => {
      const known = Object.hasOwn(counts, session.id) ? counts[session.id] : undefined;
      return {
        id: session.id,
        title: session.summary,
        project: session.project,
        agentId: session.agentId,
        waiting: session.state === "waiting",
        external: session.origin === "external",
        startedAt: session.startedAt,
        ...(known === undefined ? {} : { counts: known }),
      };
    })
    .sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.startedAt - a.startedAt);
}

/** How many agents Home's headline says are working: every running or
 *  waiting session, the ones found outside Jarvis included. */
export function workingCount(sessions: readonly SessionSummary[]): number {
  return sessions.filter((session) => session.state === "running" || session.state === "waiting")
    .length;
}

/** Phone row title: a session's summary, or for one found outside Jarvis
 *  (whose summary is the same generic line for every row) its project, else
 *  its agent. */
export function activeTitle(row: ActiveRow): string {
  if (!row.external) return row.title;
  return row.project !== null && row.project !== "" ? row.project : row.agentId;
}

/** "project · agent · waiting" or "project · agent · running 14m"; an
 *  external row drops the project, which is already its title. */
export function activeSubtitle(language: Language, row: ActiveRow, now: number): string {
  const status = row.external
    ? t(language, "sessions.external")
    : row.waiting
      ? t(language, "home.waiting")
      : t(language, "home.running", { time: formatSessionElapsed(now - row.startedAt) });
  return [row.external ? null : row.project, row.agentId, status]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
}
