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

/**
 * The sessions Changes can show: the laptop's own sessions list, live and
 * ended. git:changes looks a session up there, so History-only and
 * imported sessions are left out rather than offered and then refused.
 */
export function changesSessions<Row>(view: {
  active: readonly Row[];
  ended: readonly Row[];
}): Row[] {
  return [...view.active, ...view.ended];
}

/** The changed files split into the two lists wide Changes shows. Order
 *  within each list is the order git reported. */
export function groupFiles<File extends { staged: boolean }>(
  files: readonly File[],
): { staged: File[]; unstaged: File[] } {
  return {
    staged: files.filter((file) => file.staged),
    unstaged: files.filter((file) => !file.staged),
  };
}

/** What "Unstage all" acts on: only the staged paths. */
export function unstageAllTargets(files: readonly { path: string; staged: boolean }[]): string[] {
  return files.filter((file) => file.staged).map((file) => file.path);
}

/** What the group's "Stage all" acts on: only the unstaged paths. */
export function stageGroupTargets(files: readonly { path: string; staged: boolean }[]): string[] {
  return files.filter((file) => !file.staged).map((file) => file.path);
}

/** The wide commit button: "Commit 2 files", pluralised for Arabic too
 *  (one, two, 3-10, 11+); "Commit" while nothing is staged. */
export function commitFilesLabel(count: number, language: Language): string {
  if (count <= 0) return t(language, "changes.commit");
  if (count === 1) return t(language, "changes.commitOne");
  if (language === "ar") {
    if (count === 2) return t(language, "changes.commitTwo");
    const tail = count % 100;
    return t(language, tail >= 3 && tail <= 10 ? "changes.commitFiles" : "changes.commitMany", {
      count,
    });
  }
  return t(language, "changes.commitFiles", { count });
}

/** A line number as the diff gutter shows it: right-aligned in 4 columns,
 *  blank when the side has no such line. */
export function gutterNumber(line: number | undefined): string {
  return (line === undefined ? "" : String(line)).padStart(4, " ");
}

export type NumberedDiffRow =
  | { key: string; kind: "hunk"; text: string }
  | {
      key: string;
      kind: "added" | "removed" | "context";
      /** The new file's line number (the old file's for a removed line). */
      number: number | undefined;
      text: string;
    };

/** A diff as unified display rows with line numbers: each line carries the
 *  number git gave it, so numbering continues across hunks by itself. */
export function numberedDiffRows(diff: Pick<GitFileDiff, "path" | "hunks">): NumberedDiffRow[] {
  const rows: NumberedDiffRow[] = [];
  diff.hunks.forEach((hunk, hunkIndex) => {
    rows.push({ key: `h${hunkIndex}`, kind: "hunk", text: `${hunk.header} ${diff.path}` });
    hunk.lines.forEach((line, lineIndex) => {
      rows.push({
        key: `h${hunkIndex}l${lineIndex}`,
        kind: line.kind,
        number: line.kind === "removed" ? line.beforeLine : line.afterLine,
        text: line.text,
      });
    });
  });
  return rows;
}

export type SplitSide = {
  kind: "added" | "removed" | "context";
  number: number | undefined;
  text: string;
};

export type SplitDiffRow =
  | { key: string; kind: "hunk"; text: string }
  | { key: string; kind: "pair"; left: SplitSide | undefined; right: SplitSide | undefined };

/** A diff as side-by-side rows. Context shows on both sides; a run of
 *  removed lines is paired in order with the added run that follows it, and
 *  the shorter run is padded with empty cells. Old line numbers on the
 *  left, new on the right. */
export function splitDiffRows(diff: Pick<GitFileDiff, "path" | "hunks">): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  diff.hunks.forEach((hunk, hunkIndex) => {
    rows.push({ key: `h${hunkIndex}`, kind: "hunk", text: `${hunk.header} ${diff.path}` });
    let removed: SplitSide[] = [];
    let added: SplitSide[] = [];
    let pair = 0;
    const flush = () => {
      const count = Math.max(removed.length, added.length);
      for (let index = 0; index < count; index++) {
        rows.push({
          key: `h${hunkIndex}p${pair++}`,
          kind: "pair",
          left: removed[index],
          right: added[index],
        });
      }
      removed = [];
      added = [];
    };
    for (const line of hunk.lines) {
      if (line.kind === "removed") {
        // A removal after additions starts a new change run.
        if (added.length > 0) flush();
        removed.push({ kind: "removed", number: line.beforeLine, text: line.text });
      } else if (line.kind === "added") {
        added.push({ kind: "added", number: line.afterLine, text: line.text });
      } else {
        flush();
        rows.push({
          key: `h${hunkIndex}p${pair++}`,
          kind: "pair",
          left: { kind: "context", number: line.beforeLine, text: line.text },
          right: { kind: "context", number: line.afterLine, text: line.text },
        });
      }
    }
    flush();
  });
  return rows;
}
