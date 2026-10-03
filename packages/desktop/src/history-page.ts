import type { Session } from "@jarvis/core";

/**
 * One page of History for a paired phone or browser, which no longer loads
 * every session it has ever seen just to show the first screenful.
 *
 * `history:list` called with no argument still answers the whole list, as
 * the desktop renderer has always read it; called with a page request it
 * answers `{ sessions, more }`. The list is already newest-activity first
 * (session-store.ts), so a page is the run after the cursor: the last row
 * the caller already has, by its activity time and then its id, so two rows
 * active in the same millisecond are never skipped or repeated.
 */
export type HistoryPageRequest = {
  limit: number;
  before?: { lastActivityAt: number; id: string };
  query?: string;
  /** One session by its id, wherever it falls in the list — how a
   *  transcript screen finds a session older than the first page. */
  id?: string;
};

export type HistoryPage = { sessions: Session[]; more: boolean };

export const HISTORY_PAGE_MAX = 200;
const QUERY_MAX = 200;

/** The request, field by field, or undefined when it is not one. */
export function parseHistoryPageRequest(value: unknown): HistoryPageRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const limit = raw["limit"];
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) return undefined;
  const request: HistoryPageRequest = { limit: Math.min(limit, HISTORY_PAGE_MAX) };
  const before = raw["before"];
  if (before !== undefined) {
    if (typeof before !== "object" || before === null) return undefined;
    const cursor = before as Record<string, unknown>;
    if (typeof cursor["lastActivityAt"] !== "number" || typeof cursor["id"] !== "string") {
      return undefined;
    }
    request.before = { lastActivityAt: cursor["lastActivityAt"], id: cursor["id"] };
  }
  const id = raw["id"];
  if (id !== undefined) {
    if (typeof id !== "string" || id === "" || id.length > QUERY_MAX) return undefined;
    request.id = id;
  }
  const query = raw["query"];
  if (query !== undefined) {
    if (typeof query !== "string") return undefined;
    if (query.trim() !== "") request.query = query.slice(0, QUERY_MAX);
  }
  return request;
}

/** Whether `session` sorts after the cursor in newest-first order. */
function afterCursor(session: Session, before: { lastActivityAt: number; id: string }): boolean {
  if (session.lastActivityAt !== before.lastActivityAt) {
    return session.lastActivityAt < before.lastActivityAt;
  }
  return session.id > before.id;
}

function matches(session: Session, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const haystack =
    `${session.summary}\n${session.project ?? ""}\n${session.projectPath}\n${session.agentId}`.toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function historyPage(
  sessions: readonly Session[],
  request: HistoryPageRequest,
): HistoryPage {
  // Same order the list is kept in, with the id breaking ties, so the
  // cursor comparison and the order agree exactly.
  const ordered = [...sessions].sort((a, b) =>
    a.lastActivityAt !== b.lastActivityAt
      ? b.lastActivityAt - a.lastActivityAt
      : a.id < b.id
        ? -1
        : 1,
  );
  const words = (request.query ?? "")
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  const before = request.before;
  const rest = ordered.filter(
    (session) =>
      (request.id === undefined || session.id === request.id) &&
      (before === undefined || afterCursor(session, before)) &&
      matches(session, words),
  );
  return { sessions: rest.slice(0, request.limit), more: rest.length > request.limit };
}
