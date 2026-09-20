import type { Session, SessionState } from "@jarvis/core";

/**
 * The last process scan's externally-discovered rows, persisted to
 * `sessions-scan.json` beside jarvis.yaml so they still show at the next
 * launch, unchanged, until the user presses Refresh.
 *
 * Pure by design: parsing and serializing live here, file I/O stays at the
 * impure edge in main.ts (`node:fs/promises`).
 */

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "waiting",
  "done",
  "dead",
]);

/**
 * Only `origin: "external"` rows are ever written here — Jarvis's own
 * sessions already live in sessionStore and rebuild themselves from there,
 * so persisting them a second time would just be a second, staler copy.
 */
export function serializeScan(rows: Session[]): string {
  const external = rows.filter((row) => row.origin === "external");
  return JSON.stringify({ version: 1, sessions: external });
}

/**
 * The inverse of serializeScan(), tolerant of anything that made it onto
 * disk: a missing or unreadable file, a future/foreign format, or a single
 * corrupt row. Malformed input never throws — it drops what it can't trust
 * and keeps the rest, because a bad cache must never be fatal to startup.
 */
export function parseScan(text: string): Session[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return [];

  const rows: Session[] = [];
  for (const candidate of sessions) {
    const row = toExternalSession(candidate);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

/** Validates one candidate row and rebuilds it from exactly the fields an
 *  external row carries (see the object literal main.ts's refreshSessions()
 *  builds) — never a cast of whatever extra junk the file might hold. */
function toExternalSession(candidate: unknown): Session | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const row = candidate as Record<string, unknown>;

  if (row.origin !== "external") return undefined;
  if (typeof row.id !== "string" || row.id === "") return undefined;
  if (typeof row.project !== "string" && row.project !== null) return undefined;
  if (typeof row.projectPath !== "string") return undefined;
  if (typeof row.agentId !== "string") return undefined;
  if (typeof row.state !== "string" || !KNOWN_STATES.has(row.state)) return undefined;
  if (typeof row.summary !== "string") return undefined;
  if (typeof row.startedAt !== "number") return undefined;
  if (typeof row.lastActivityAt !== "number") return undefined;

  const session: Session = {
    id: row.id,
    project: row.project,
    projectPath: row.projectPath,
    agentId: row.agentId,
    state: row.state as SessionState,
    summary: row.summary,
    startedAt: row.startedAt,
    lastActivityAt: row.lastActivityAt,
    origin: "external",
  };
  if (typeof row.transcriptPath === "string") session.transcriptPath = row.transcriptPath;
  if (typeof row.pid === "number") session.pid = row.pid;
  return session;
}
