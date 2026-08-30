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
  /** True for binary files and for text past the provider's size cap. */
  binary: boolean;
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
  | "failed";

export type GitFailure = { code: GitFailureCode; detail: string };

// Git failures are values, not exceptions. The spec's error-handling table
// says a git error is "shown in the Changes view, never blocks the
// assistant" — a returned outcome makes that structural instead of relying
// on every call site remembering a try/catch.
export type GitOutcome<T> = { ok: true; value: T } | { ok: false; error: GitFailure };

export interface GitProvider {
  changes(repoPath: string): Promise<GitOutcome<GitChanges>>;
  diff(repoPath: string, filePath: string): Promise<GitOutcome<GitFileDiff>>;
  stage(repoPath: string, paths: string[]): Promise<GitOutcome<null>>;
  unstage(repoPath: string, paths: string[]): Promise<GitOutcome<null>>;
  commit(repoPath: string, message: string): Promise<GitOutcome<GitCommitResult>>;
}
