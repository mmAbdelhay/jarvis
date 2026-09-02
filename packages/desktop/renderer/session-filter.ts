import type { Session } from "@jarvis/core";
import { projectLabel } from "./format.js";

/**
 * The project filter's value for "belongs to no configured project".
 *
 * It needs a value of its own because the empty string already means "any
 * project", and this is not a marginal case: 66 of the 95 sessions on the
 * machine this was built for match it. Parenthesised so it cannot be
 * mistaken for a real project name — `projects:` keys are yaml identifiers —
 * and printable, because an invisible sentinel is a bug waiting to happen:
 * the first version of this was a NUL byte nobody could see in the source.
 */
export const NO_PROJECT = "(none)";

export type SessionCriteria = {
  /** Free text, matched against everything the row shows. */
  query: string;
  /** A project name, `NO_PROJECT`, or "" for any. */
  project: string;
  /** An agent id, or "" for any. */
  agent: string;
};

export type SessionSortColumn = "project" | "agent" | "state" | "lastActivityAt";
export type SortDirection = "asc" | "desc";

/**
 * The sessions a set of criteria admits.
 *
 * Search covers every column the table shows rather than the summary alone:
 * the reader is looking for a session they half-remember, and what they
 * remember may be the directory, the branch or which agent ran it just as
 * easily as the words they typed.
 */
export function filterSessions(sessions: Session[], criteria: SessionCriteria): Session[] {
  const query = criteria.query.trim().toLowerCase();
  return sessions.filter((session) => {
    if (criteria.project === NO_PROJECT) {
      if (session.project !== null) return false;
    } else if (criteria.project !== "" && session.project !== criteria.project) {
      return false;
    }
    if (criteria.agent !== "" && session.agentId !== criteria.agent) return false;
    if (query === "") return true;
    return haystack(session).includes(query);
  });
}

/** Everything about a session a reader might search by, lowercased once. */
function haystack(session: Session): string {
  return [
    session.summary,
    projectLabel(session),
    session.projectPath,
    session.agentId,
    session.model ?? "",
    session.branch ?? "",
    session.state,
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * A sorted copy — never a sort in place, because the caller holds the
 * unfiltered list and re-sorting must not scramble it.
 *
 * `project` sorts on the label the table displays rather than the raw field:
 * a session with no project shows its directory, and sorting on the null
 * behind it would clump every such row at one end no matter what the reader
 * sees.
 */
export function sortSessions(
  sessions: Session[],
  column: SessionSortColumn,
  direction: SortDirection,
): Session[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...sessions].sort((a, b) => sign * compare(a, b, column));
}

function compare(a: Session, b: Session, column: SessionSortColumn): number {
  if (column === "lastActivityAt") return a.lastActivityAt - b.lastActivityAt;
  if (column === "agent") return a.agentId.localeCompare(b.agentId);
  if (column === "state") return a.state.localeCompare(b.state);
  return projectLabel(a).localeCompare(projectLabel(b));
}

/** Every agent that actually ran one of these sessions, sorted and unique —
 *  the filter offers what the table contains rather than what the config
 *  declares, so it can never list an agent with nothing behind it. */
export function agentsIn(sessions: Session[]): string[] {
  return [...new Set(sessions.map((session) => session.agentId))].sort((a, b) =>
    a.localeCompare(b),
  );
}
