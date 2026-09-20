import type { GitChanges, GitFileChange, GitFileDiff } from "@jarvis/core";
import type { TranscriptEntry } from "@jarvis/wire";
import type { Language } from "./i18n";

export type GitViewResult<T> =
  | { ok: true; value: T }
  | { ok: false; text: string; language: Language };

// Fix round 1 (Important 3): a reply that fails to parse has no real server
// message to show — the two failure branches below used to return `text:
// ""`, which is falsy and so silently rendered nothing on every screen that
// checked `notice &&`. Callers recognize this sentinel and show a
// localized "couldn't read that reply" string instead of the empty string
// itself or (worse) real server text that was never sent.
export const MALFORMED_REPLY_NOTICE = "malformed-reply";

export type ChangesView = {
  session: {
    id: string;
    project: string;
    projectPath: string;
    agentId: string;
    lastActivityAt: number;
    endedAt: number | undefined;
  };
  changes: GitChanges;
};

const STATUS_LETTERS = new Set(["M", "A", "D", "R", "C", "U", "?"]);
const LINE_KINDS = new Set(["context", "added", "removed"]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Parses a `GitViewResult<T>` reply strictly: it must already be shaped as
 * `{ok:true,value}` or `{ok:false,text,language}` — anything else is a
 * parse failure, never a bare value handed straight to `parseValue` (M12
 * Task 8, security review: the previous fallback treated any reply that
 * wasn't already enveloped as if it were the bare success value, so a
 * trivial `parseValue` like `(): true => true` — docker-store.ts's/
 * docker-log-stream.ts's action/follow acknowledgements — turned a bare
 * string reply such as `"ok"` into a false `{ok:true,value:true}`).
 */
export function parseGitViewResult<T>(
  value: unknown,
  parseValue: (input: unknown) => T | undefined,
): GitViewResult<T> {
  if (typeof value === "object" && value !== null && "ok" in value) {
    const obj = value as Record<string, unknown>;
    if (
      obj.ok === false &&
      typeof obj.text === "string" &&
      (obj.language === "ar" || obj.language === "en")
    ) {
      return { ok: false, text: obj.text, language: obj.language };
    }
    if (obj.ok === true) {
      const parsed = parseValue(obj.value);
      return parsed === undefined
        ? { ok: false, text: MALFORMED_REPLY_NOTICE, language: "en" }
        : { ok: true, value: parsed };
    }
  }

  return { ok: false, text: MALFORMED_REPLY_NOTICE, language: "en" };
}

function parseFileChange(value: unknown): GitFileChange | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (!isString(obj.path)) return undefined;
  if (!isString(obj.status) || !STATUS_LETTERS.has(obj.status)) return undefined;
  if (!isFiniteNumber(obj.insertions) || !isFiniteNumber(obj.deletions)) return undefined;
  if (typeof obj.staged !== "boolean") return undefined;
  return {
    path: obj.path,
    status: obj.status as GitFileChange["status"],
    insertions: obj.insertions,
    deletions: obj.deletions,
    staged: obj.staged,
  };
}

function parseGitChanges(value: unknown): GitChanges | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (!isString(obj.repoPath) || !isString(obj.branch)) return undefined;
  if (typeof obj.detached !== "boolean") return undefined;
  if (!isFiniteNumber(obj.insertions) || !isFiniteNumber(obj.deletions)) return undefined;
  if (!Array.isArray(obj.files)) return undefined;
  const files: GitFileChange[] = [];
  for (const item of obj.files) {
    const parsed = parseFileChange(item);
    if (parsed === undefined) return undefined;
    files.push(parsed);
  }
  return {
    repoPath: obj.repoPath,
    branch: obj.branch,
    detached: obj.detached,
    files,
    insertions: obj.insertions,
    deletions: obj.deletions,
  };
}

export function parseChangesView(value: unknown): ChangesView | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  const session = obj.session;
  if (typeof session !== "object" || session === null) return undefined;
  const s = session as Record<string, unknown>;
  if (!isString(s.id) || !isString(s.project) || !isString(s.projectPath)) return undefined;
  if (!isString(s.agentId) || !isFiniteNumber(s.lastActivityAt)) return undefined;
  if (s.endedAt !== undefined && !isFiniteNumber(s.endedAt)) return undefined;
  const changes = parseGitChanges(obj.changes);
  if (changes === undefined) return undefined;
  return {
    session: {
      id: s.id,
      project: s.project,
      projectPath: s.projectPath,
      agentId: s.agentId,
      lastActivityAt: s.lastActivityAt,
      endedAt: optionalFiniteNumber(s.endedAt),
    },
    changes,
  };
}

export function parseGitDiffResult(value: unknown): GitFileDiff | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (!isString(obj.path) || typeof obj.binary !== "boolean") return undefined;
  if (obj.tooLarge !== undefined && typeof obj.tooLarge !== "boolean") return undefined;
  if (!Array.isArray(obj.hunks)) return undefined;
  const hunks: GitFileDiff["hunks"] = [];
  for (const hunk of obj.hunks) {
    if (typeof hunk !== "object" || hunk === null) return undefined;
    const h = hunk as Record<string, unknown>;
    if (!isString(h.header) || !Array.isArray(h.lines)) return undefined;
    const lines: GitFileDiff["hunks"][number]["lines"] = [];
    for (const line of h.lines) {
      if (typeof line !== "object" || line === null) return undefined;
      const l = line as Record<string, unknown>;
      if (!isString(l.kind) || !LINE_KINDS.has(l.kind)) return undefined;
      if (!isString(l.text)) return undefined;
      if (l.beforeLine !== undefined && !isFiniteNumber(l.beforeLine)) return undefined;
      if (l.afterLine !== undefined && !isFiniteNumber(l.afterLine)) return undefined;
      lines.push({
        kind: l.kind as GitFileDiff["hunks"][number]["lines"][number]["kind"],
        text: l.text,
        beforeLine: optionalFiniteNumber(l.beforeLine),
        afterLine: optionalFiniteNumber(l.afterLine),
      });
    }
    hunks.push({ header: h.header, lines });
  }
  const diff: GitFileDiff = { path: obj.path, binary: obj.binary, hunks };
  if (obj.tooLarge === true) diff.tooLarge = true;
  return diff;
}

export function parseTranscriptEntries(value: unknown): TranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: TranscriptEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (obj.role !== "user" && obj.role !== "assistant") continue;
    if (typeof obj.text !== "string" || !Array.isArray(obj.tools)) continue;
    entries.push({
      role: obj.role,
      text: obj.text,
      tools: obj.tools.filter((tool): tool is string => typeof tool === "string"),
    });
  }
  return entries;
}
