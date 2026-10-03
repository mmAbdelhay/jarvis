// The Sessions list is the laptop's live sessions plus its saved history,
// as one list: a session that is both appears once, as the live row. Pure,
// so the merge, the ordering and the flags are unit tested.
import type { Session, SessionState } from "@jarvis/core";
import type { SessionRowView } from "./sessions-store";
import { sessionLabelOf } from "./sessions-store";

export type MergedRow = SessionRowView & {
  /** "history" rows exist only in the saved history: no live detail to open. */
  source: "live" | "history";
  /** Brought in from an agent's own transcript rather than run in Jarvis. */
  imported: boolean;
};

const LIVE_STATES = new Set<SessionState>(["starting", "running", "waiting"]);

export function isLiveState(state: SessionState): boolean {
  return LIVE_STATES.has(state);
}

/** A row counts as active only while the laptop reports it live. */
export function isActiveRow(row: Pick<MergedRow, "source" | "state">): boolean {
  return row.source === "live" && isLiveState(row.state);
}

/** When a finished row ended, else its last activity. */
export function rowMoment(row: Pick<SessionRowView, "endedAt" | "lastActivityAt">): number {
  return row.endedAt ?? row.lastActivityAt;
}

/** A saved session as a row. A saved session that claims to be live but is
 *  not in the live list has lost its process: it is shown as ended. */
export function historyRow(session: Session): SessionRowView {
  const row: SessionRowView = {
    id: session.id,
    label: sessionLabelOf(session.project, session.projectPath),
    summary: session.summary,
    state: isLiveState(session.state) ? "dead" : session.state,
    agentId: session.agentId,
    project: session.project,
    projectPath: session.projectPath,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
  };
  if (session.endedAt !== undefined) row.endedAt = session.endedAt;
  if (session.origin !== undefined) row.origin = session.origin;
  if (session.transcriptPath !== undefined) row.transcriptPath = session.transcriptPath;
  if (session.branch !== undefined) row.branch = session.branch;
  if (session.insertions !== undefined) row.insertions = session.insertions;
  if (session.deletions !== undefined) row.deletions = session.deletions;
  if (session.changedFiles !== undefined) row.changedFiles = session.changedFiles;
  return row;
}

function flag(row: SessionRowView, source: MergedRow["source"]): MergedRow {
  return { ...row, source, imported: row.transcriptPath !== undefined };
}

/**
 * The union by id; the live row wins a clash. Order: active rows first
 * (waiting before running, then the most recent activity), then the rest
 * newest first by when they ended.
 */
export function mergeSessions(
  live: readonly SessionRowView[],
  history: readonly Session[],
): MergedRow[] {
  const byId = new Map<string, MergedRow>();
  for (const row of live) byId.set(row.id, flag(row, "live"));
  for (const session of history) {
    if (!byId.has(session.id)) byId.set(session.id, flag(historyRow(session), "history"));
  }
  const rows = [...byId.values()];
  const active = rows
    .filter(isActiveRow)
    .sort(
      (a, b) =>
        Number(b.state === "waiting") - Number(a.state === "waiting") ||
        b.lastActivityAt - a.lastActivityAt,
    );
  const rest = rows.filter((row) => !isActiveRow(row)).sort((a, b) => rowMoment(b) - rowMoment(a));
  return [...active, ...rest];
}

/** The merged row for an id, so a selection is "present" when it is live or
 *  in the loaded history. */
/** The selected row: the one in `rows`, else `remembered` when it is that
 *  same id — a wide-pane selection a search has since filtered out of the
 *  loaded history keeps its pane rather than reading "not found". */
export function selectedRow(
  rows: readonly MergedRow[],
  id: string | undefined,
  remembered: MergedRow | undefined,
): MergedRow | undefined {
  const found = findRow(rows, id);
  if (found !== undefined) return found;
  return id !== undefined && remembered?.id === id ? remembered : undefined;
}

export function findRow(rows: readonly MergedRow[], id: string | undefined): MergedRow | undefined {
  return id === undefined ? undefined : rows.find((row) => row.id === id);
}
