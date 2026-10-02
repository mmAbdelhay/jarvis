// The Sessions screen's search and filter chips: which rows a query and a
// status chip keep, and how many each chip would show. Pure, so the screen
// only draws what this decides.
import type { SessionState } from "@jarvis/core";
import type { SessionRowView } from "./sessions-store";

export type StatusFilter = "all" | "waiting" | "running" | "done";

const STATUS_STATES: Record<Exclude<StatusFilter, "all">, ReadonlySet<SessionState>> = {
  waiting: new Set(["waiting"]),
  running: new Set(["starting", "running"]),
  done: new Set(["done", "dead"]),
};

export function matchesStatus(row: Pick<SessionRowView, "state">, status: StatusFilter): boolean {
  return status === "all" || STATUS_STATES[status].has(row.state);
}

/** Every word of the query must appear in the summary, the label (project
 *  and agent) or the agent id, ignoring case: "api claude" finds Claude's
 *  sessions in the api project. */
export function matchesQuery(
  row: Pick<SessionRowView, "summary" | "label" | "agentId">,
  query: string,
): boolean {
  const words = query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return true;
  const haystack = `${row.summary}\n${row.label}\n${row.agentId}`.toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function filterRows<T extends SessionRowView>(
  rows: readonly T[],
  query: string,
  status: StatusFilter,
): T[] {
  return rows.filter((row) => matchesStatus(row, status) && matchesQuery(row, query));
}

/** Each chip's count under the current query, so a chip never promises
 *  rows the search has already hidden. */
export function statusCounts(
  rows: readonly SessionRowView[],
  query: string,
): Record<StatusFilter, number> {
  const matching = rows.filter((row) => matchesQuery(row, query));
  return {
    all: matching.length,
    waiting: matching.filter((row) => matchesStatus(row, "waiting")).length,
    running: matching.filter((row) => matchesStatus(row, "running")).length,
    done: matching.filter((row) => matchesStatus(row, "done")).length,
  };
}
