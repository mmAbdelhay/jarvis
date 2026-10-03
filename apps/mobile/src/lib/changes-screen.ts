// Pure view-model helpers for app/changes.tsx (M7's session-screen.ts
// pattern: logic that decides *what* to show, lifted out of JSX so it's
// testable without rendering). Fix round 1 addresses three screen-level
// review findings that a pure-store test can't reach on its own: the
// commit draft must survive an offline refusal (Behaviour 3), the
// previously chosen session must reopen on refocus (Behaviour 2), and a
// `failed` phase or a non-remote notice must never be a blank/misleading
// screen (Important 3).
import type { GitFileDiff } from "@jarvis/core";
import {
  ENDED_SESSION_NOTICE,
  type ChangesState,
  MUTATION_OFFLINE_NOTICE,
  type SyncDone,
  MUTATION_SESSION_CHANGED_NOTICE,
  UNSUPPORTED_NOTICE,
} from "./changes-store";
import { t, type Language, type MessageKey } from "./i18n";
import { MALFORMED_REPLY_NOTICE } from "./workspace-results";

/**
 * The session id the Changes screen should reopen when it regains focus.
 * `routeId` (an `?id=` param from a session-detail link) wins the *first*
 * time this screen instance sees it — `lastConsumedRouteId` is the route id
 * the caller already applied, held in a ref that survives across
 * blur/refocus (unlike `routeId` itself, which never changes for the life
 * of this screen instance). Once consumed, later refocuses fall back to
 * the store's own `sessionId`, which survives `close()` (only its
 * subscriptions and visible data are torn down) — otherwise a session link
 * would keep overriding every chip the user taps afterward on each
 * refocus (Fix round 2, New Breakage 1: `routeId` is a stack-entry-lived
 * query param, not a one-shot navigation event, so giving it unconditional
 * precedence reopened the linked session forever, discarding the user's
 * later choice).
 */
export function sessionIdToReopen(
  state: ChangesState,
  routeId: string | undefined,
  lastConsumedRouteId: string | undefined,
): string | undefined {
  if (routeId !== undefined && routeId !== lastConsumedRouteId) return routeId;
  return state.sessionId;
}

/**
 * A commit/stage draft is cleared only once the store reports a real,
 * connected outcome — never on `uncertain` (timeout/mid-flight close) and
 * never while a `notice` is set. Before Fix round 1, an offline refusal set
 * neither flag, so this looked identical to success and the draft was lost
 * (Important 1); the store now always sets a notice on refusal
 * (MUTATION_OFFLINE_NOTICE), so this same check is now correct for that
 * path too.
 * [bite-proof: change the offline branch back to `stale: true` alone (no
 * notice) and `shouldClearDraft` wrongly returns true again — covered by
 * changes-store.test.ts's "gives an offline mutation refusal a distinct
 * notice" test guarding the producer side of this.]
 */
export function shouldClearDraft(state: ChangesState): boolean {
  return !state.uncertain && state.notice === undefined;
}

const NOTICE_KEYS: Readonly<Record<string, MessageKey>> = {
  [ENDED_SESSION_NOTICE]: "changes.endedWarning",
  [MUTATION_OFFLINE_NOTICE]: "changes.offline",
  [MUTATION_SESSION_CHANGED_NOTICE]: "changes.sessionChanged",
  [UNSUPPORTED_NOTICE]: "changes.unsupported",
  [MALFORMED_REPLY_NOTICE]: "changes.malformedReply",
};

/**
 * Turns a store notice into displayed text. The four sentinel tokens the
 * store can produce are translated; anything else is real server text and
 * shown verbatim (global-constraints 7 — server messages display as-is).
 */
export function noticeText(notice: string, language: Language): string {
  const key = NOTICE_KEYS[notice];
  return key ? t(language, key) : notice;
}

/**
 * Text for `phase === "failed"`. A notice (server text or a translated
 * sentinel) is shown when the store set one; otherwise (a bare
 * timeout/offline refresh failure, which carries no notice) this falls
 * back to a generic localized message instead of leaving the screen blank
 * (Important 3).
 */
export function failedText(state: ChangesState, language: Language): string {
  return state.notice !== undefined
    ? noticeText(state.notice, language)
    : t(language, "common.loadFailed");
}

/** The branch's tracking line: `origin/main ↑2 ↓1`, the upstream alone when
 *  in step, or a note that the branch is on no remote yet. */
export function trackingText(state: ChangesState, language: Language): string {
  const changes = state.changes?.changes;
  if (changes === undefined) return "";
  const { upstream, ahead = 0, behind = 0 } = changes;
  if (upstream === undefined) return t(language, "changes.noUpstream");
  const counts = [ahead > 0 ? `↑${ahead}` : "", behind > 0 ? `↓${behind}` : ""]
    .filter((part) => part !== "")
    .join(" ");
  return counts === "" ? upstream : `${upstream} ${counts}`;
}

/** What a finished sync action says. A pull request's address is shown
 *  beside it by the screen, which also offers to open it. */
export function doneText(done: SyncDone, language: Language): string {
  switch (done.kind) {
    case "pulled":
      return t(language, "changes.pulled");
    case "upToDate":
      return t(language, "changes.upToDate");
    case "pushed":
      return t(language, "changes.pushed");
    case "switched":
      return t(language, "changes.switched");
    case "worktreeRemoved":
      return t(language, "changes.worktreeRemoved");
    case "merged":
      return t(language, "changes.merged", { branch: done.into });
    case "pullRequest":
      return t(language, done.created ? "changes.prCreated" : "changes.prExisting");
  }
}

/**
 * The session the screen opens on when no route id names one: the most
 * recently active live session, else the newest finished one (from the
 * laptop's ended rows and saved history together), else none.
 */
export function defaultChangesSession(
  live: readonly { id: string; lastActivityAt: number }[],
  finished: readonly { id: string; lastActivityAt: number; endedAt?: number }[],
): string | undefined {
  let best: { id: string; at: number } | undefined;
  for (const row of live) {
    if (best === undefined || row.lastActivityAt > best.at) {
      best = { id: row.id, at: row.lastActivityAt };
    }
  }
  if (best !== undefined) return best.id;
  for (const row of finished) {
    const at = row.endedAt ?? row.lastActivityAt;
    if (best === undefined || at > best.at) best = { id: row.id, at };
  }
  return best?.id;
}

/**
 * What "Stage all" does: the unstaged paths to stage, or, when every file
 * is already staged, all of them to unstage (the button then reads
 * "Unstage all").
 */
export function stageAllTargets(files: readonly { path: string; staged: boolean }[]): {
  paths: string[];
  staged: boolean;
} {
  const unstaged = files.filter((file) => !file.staged).map((file) => file.path);
  if (unstaged.length > 0) return { paths: unstaged, staged: true };
  return { paths: files.map((file) => file.path), staged: false };
}

/** The Push button's label: the count of commits ahead only when there are some. */
export function pushLabel(ahead: number | undefined, language: Language): string {
  return ahead !== undefined && ahead > 0
    ? t(language, "changes.pushCount", { count: ahead })
    : t(language, "changes.push");
}

export type TrackingParts =
  | { kind: "none" }
  | { kind: "upstream"; upstream: string; ahead: number; behind: number };

/** The branch's tracking line as parts, so the screen can tone ↑ and ↓ apart. */
export function trackingParts(state: ChangesState): TrackingParts | undefined {
  const changes = state.changes?.changes;
  if (changes === undefined) return undefined;
  if (changes.upstream === undefined) return { kind: "none" };
  return {
    kind: "upstream",
    upstream: changes.upstream,
    ahead: changes.ahead ?? 0,
    behind: changes.behind ?? 0,
  };
}

export type DiffRow = {
  /** Unique within one diff: hunk position, then line position. */
  key: string;
  kind: "hunk" | "added" | "removed" | "context";
  text: string;
};

/** A diff as display rows with no line numbers: each hunk's header followed
 *  by the path, then its lines behind their `+`, `-` or blank marker. */
export function diffRows(diff: Pick<GitFileDiff, "path" | "hunks">): DiffRow[] {
  const rows: DiffRow[] = [];
  diff.hunks.forEach((hunk, hunkIndex) => {
    rows.push({ key: `h${hunkIndex}`, kind: "hunk", text: `${hunk.header} ${diff.path}` });
    hunk.lines.forEach((line, lineIndex) => {
      const marker = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
      rows.push({
        key: `h${hunkIndex}l${lineIndex}`,
        kind: line.kind,
        text: `${marker} ${line.text}`,
      });
    });
  });
  return rows;
}
