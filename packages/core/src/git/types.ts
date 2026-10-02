// The spec names `GitProvider` as one of the interfaces `core` depends on
// (Components → core/ — orchestrator). Git is OS access, so `core` declares
// the shape and `platform` implements it over `simple-git`; this is the same
// injected seam as `Spawner`, `CommandRunner` and `SessionStore`.

/** git's own porcelain status letters, plus `?` for untracked. */
export type GitStatusLetter = "M" | "A" | "D" | "R" | "C" | "U" | "?";

export type GitFileChange = {
  /** Repo-relative POSIX path. May be Arabic or mixed-script. */
  path: string;
  status: GitStatusLetter;
  insertions: number;
  deletions: number;
  staged: boolean;
};

export type GitChanges = {
  repoPath: string;
  /** Branch name, or the short SHA when `detached` is true. */
  branch: string;
  detached: boolean;
  files: GitFileChange[];
  insertions: number;
  deletions: number;
  /** The branch this one tracks ("origin/main"), when it tracks one. */
  upstream?: string;
  /** Commits here and not on `upstream`, and the other way round. Both 0
   *  (or absent) without an upstream. */
  ahead?: number;
  behind?: number;
};

// `beforeLine`/`afterLine` are written as explicit `| undefined` rather than
// optional properties because every diff line sets both keys — one of them to
// undefined — and the renderer reads them positionally. Optionals would invite
// conditional spreads at every construction site for no gain.
export type GitDiffLine = {
  kind: "context" | "added" | "removed";
  /** The line's text with the leading +/-/space marker already stripped. */
  text: string;
  beforeLine: number | undefined;
  afterLine: number | undefined;
};

export type GitDiffHunk = {
  /** The verbatim `@@ -a,b +c,d @@ …` header line. */
  header: string;
  lines: GitDiffLine[];
};

export type GitFileDiff = {
  path: string;
  /**
   * True when the file's content is genuinely binary — confirmed by git
   * itself (`Binary files … differ`) or by reading the file and finding a
   * NUL byte. `false` here does not mean the diff is safe to render in
   * full: check `tooLarge` too.
   */
  binary: boolean;
  /**
   * True when the file (untracked) or its diff (tracked) exceeded the
   * provider's size cap and was never read or parsed, so `hunks` is empty
   * and whether the content is really binary is unknown — `binary` stays
   * `false` in this case rather than guessing. Optional so existing
   * consumers that only checked `binary` are unaffected; a consumer that
   * wants to tell a real binary file apart from "too large to show" (e.g.
   * to offer "open externally" instead of "not displayable") must check
   * this field explicitly.
   */
  tooLarge?: boolean;
  hunks: GitDiffHunk[];
};

export type GitCommitResult = {
  /** Short SHA, as git prints it. */
  sha: string;
  filesChanged: number;
};

export type GitFailureCode =
  | "not-a-repo"
  | "nothing-staged"
  | "empty-message"
  | "conflict"
  | "failed"
  // GitRemoteOps' own refusals.
  | "invalid-branch"
  | "no-upstream"
  | "no-remote"
  | "diverged"
  | "rejected"
  | "detached"
  | "no-gh";

export type GitFailure = { code: GitFailureCode; detail: string };

// Git failures are values, not exceptions. The spec's error-handling table
// says a git error is "shown in the Changes view, never blocks the
// assistant" — a returned outcome makes that structural instead of relying
// on every call site remembering a try/catch.
export type GitOutcome<T> = { ok: true; value: T } | { ok: false; error: GitFailure };

export type GitBranches = {
  /** The checked-out branch; the short SHA when `detached`. */
  current: string;
  detached: boolean;
  /** Every local branch, in git's own order. */
  local: string[];
};

export type GitPullResult = {
  /** Whether HEAD moved — false when there was nothing to bring in. */
  updated: boolean;
};

export type GitPushResult = {
  remote: string;
  branch: string;
  /** True when this push also made `remote/branch` the upstream. */
  upstreamSet: boolean;
};

export type GitPullRequest = {
  url: string;
  /** False when one was already open for this branch and is reused. */
  created: boolean;
};

/**
 * The Changes view's branch, pull, push and pull-request controls — a
 * separate seam from GitProvider because these reach the network (a
 * remote, GitHub) and the other five never do. Every method answers with a
 * GitOutcome, never a rejection, like GitProvider's.
 */
export interface GitRemoteOps {
  branches(repoPath: string): Promise<GitOutcome<GitBranches>>;
  /** Checks out `name`, creating it from HEAD first when `create`. Local
   *  changes travel with the switch, as plain `git switch` does; git
   *  itself refuses a switch they would be lost in. */
  switchBranch(repoPath: string, name: string, create: boolean): Promise<GitOutcome<null>>;
  /** Fast-forward only: never a merge commit, never a conflict. */
  pull(repoPath: string): Promise<GitOutcome<GitPullResult>>;
  /** Pushes the current branch; one with no upstream yet is pushed to
   *  `origin` (or the only remote) and starts tracking it. Never forced. */
  push(repoPath: string): Promise<GitOutcome<GitPushResult>>;
  /** The open pull request for the current branch, or a new one (`gh pr
   *  create --fill`) — pushing first when the branch has commits its
   *  remote does not. */
  pullRequest(repoPath: string): Promise<GitOutcome<GitPullRequest>>;
}

export interface GitProvider {
  changes(repoPath: string): Promise<GitOutcome<GitChanges>>;
  diff(repoPath: string, filePath: string): Promise<GitOutcome<GitFileDiff>>;
  stage(repoPath: string, paths: string[]): Promise<GitOutcome<null>>;
  unstage(repoPath: string, paths: string[]): Promise<GitOutcome<null>>;
  commit(repoPath: string, message: string): Promise<GitOutcome<GitCommitResult>>;
}
