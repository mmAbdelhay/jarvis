// The one field-by-field parser for a wire `Session` value (M12 Task 8):
// before this, history-store.ts, sessions-store.ts and dashboard-store.ts
// each hand-rolled their own copy of the same field checks (id, project,
// projectPath, agentId, state, summary, startedAt, lastActivityAt, and the
// optional trailing fields), which could — and did — drift out of sync.
// Every store that reads a `Session`-shaped value off the wire now calls
// this and derives its own narrower view (a row, a summary) from the
// result; no other function in apps/mobile/src may be named `parseSession`
// (session-parse.test.ts's own source scan proves it).
//
// Never a spread: every field is read, checked and copied one at a time,
// so a payload carrying extra or renamed fields can never pass through to
// a typed value.

import type { Session, SessionState } from "@jarvis/core";

const SESSION_STATES = new Set<SessionState>(["starting", "running", "waiting", "done", "dead"]);

export function parseSession(value: unknown): Session | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string") return undefined;
  if (typeof obj.project !== "string" && obj.project !== null) return undefined;
  if (typeof obj.projectPath !== "string") return undefined;
  if (typeof obj.agentId !== "string") return undefined;
  if (typeof obj.state !== "string" || !SESSION_STATES.has(obj.state as SessionState)) {
    return undefined;
  }
  if (typeof obj.summary !== "string") return undefined;
  if (typeof obj.startedAt !== "number" || !Number.isFinite(obj.startedAt)) return undefined;
  if (typeof obj.lastActivityAt !== "number" || !Number.isFinite(obj.lastActivityAt)) {
    return undefined;
  }
  const session: Session = {
    id: obj.id,
    project: obj.project,
    projectPath: obj.projectPath,
    agentId: obj.agentId,
    state: obj.state as SessionState,
    summary: obj.summary,
    startedAt: obj.startedAt,
    lastActivityAt: obj.lastActivityAt,
  };
  if (typeof obj.model === "string") session.model = obj.model;
  if (typeof obj.endedAt === "number" && Number.isFinite(obj.endedAt)) {
    session.endedAt = obj.endedAt;
  }
  if (typeof obj.exitCode === "number" && Number.isFinite(obj.exitCode)) {
    session.exitCode = obj.exitCode;
  }
  if (typeof obj.transcriptPath === "string") session.transcriptPath = obj.transcriptPath;
  if (typeof obj.branch === "string") session.branch = obj.branch;
  if (typeof obj.insertions === "number" && Number.isFinite(obj.insertions)) {
    session.insertions = obj.insertions;
  }
  if (typeof obj.deletions === "number" && Number.isFinite(obj.deletions)) {
    session.deletions = obj.deletions;
  }
  if (typeof obj.changedFiles === "number" && Number.isFinite(obj.changedFiles)) {
    session.changedFiles = obj.changedFiles;
  }
  if (obj.origin === "jarvis" || obj.origin === "external") session.origin = obj.origin;
  if (typeof obj.pid === "number" && Number.isFinite(obj.pid)) session.pid = obj.pid;
  return session;
}
