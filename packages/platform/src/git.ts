import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { addedFileDiff, parseUnifiedDiff } from "@jarvis/core";
import type {
  GitChanges,
  GitCommitResult,
  GitFailure,
  GitFileChange,
  GitFileDiff,
  GitOutcome,
  GitProvider,
  GitStatusLetter,
} from "@jarvis/core";
import { GitPluginError, simpleGit, type SimpleGit } from "simple-git";
import { resolvesInside } from "./paths.js";

// This module is the only place in the repository that imports simple-git.
// `core` declares GitProvider; everything OS-facing lives here. simple-git
// wraps the real git binary — never reimplement a git behaviour in this file.

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(code: GitFailure["code"], detail: string): GitOutcome<never> {
  return { ok: false, error: { code, detail } };
}

const LETTERS: readonly GitStatusLetter[] = ["M", "A", "D", "R", "C", "U", "?"];

function toLetter(raw: string): GitStatusLetter {
  const found = LETTERS.find((letter) => letter === raw);
  // git's remaining codes (T typechange, and anything a future git adds)
  // are displayed as modifications; the file did change, and inventing a
  // new letter the UI has no colour for would be worse.
  return found ?? "M";
}

type Counts = { insertions: number; deletions: number };

// simple-git's diffSummary (git diff --stat) writes a rename or copy not as
// the new path alone but as "old => new", or — when old and new share a
// directory or a prefix/suffix — as "prefix{old => new}suffix". status.files
// always keys a file by its *new* path (that's what git status --porcelain
// prints), so a counts lookup keyed by the raw diffSummary string never
// matches a renamed or copied file and silently falls back to 0/0. Resolving
// every diffSummary key to the real new path here — once, for every entry,
// regardless of the file's status letter — fixes rename (R) and copy (C)
// alike without special-casing either.
function resolveDiffPath(file: string): string {
  const braced = /^(.*)\{.* => (.*)\}(.*)$/.exec(file);
  if (braced) {
    const [, prefix = "", newMid = "", suffix = ""] = braced;
    return `${prefix}${newMid}${suffix}`;
  }
  const arrow = file.indexOf(" => ");
  if (arrow !== -1) {
    return file.slice(arrow + " => ".length).trim();
  }
  return file;
}

function countsByFile(files: readonly { file: string; binary: boolean }[]): Map<string, Counts> {
  const counts = new Map<string, Counts>();
  for (const entry of files) {
    const path = resolveDiffPath(entry.file);
    if (entry.binary) {
      counts.set(path, { insertions: 0, deletions: 0 });
      continue;
    }
    if ("insertions" in entry && "deletions" in entry) {
      const insertions = typeof entry.insertions === "number" ? entry.insertions : 0;
      const deletions = typeof entry.deletions === "number" ? entry.deletions : 0;
      const existing = counts.get(path) ?? { insertions: 0, deletions: 0 };
      counts.set(path, {
        insertions: existing.insertions + insertions,
        deletions: existing.deletions + deletions,
      });
    }
  }
  return counts;
}

async function readChanges(git: SimpleGit, repoPath: string): Promise<GitChanges> {
  const status = await git.status();
  // Two summaries: unstaged (worktree vs index) and staged (index vs HEAD).
  // A file can appear in both; the counts are summed so the totals match
  // what a person would see running `git diff` and `git diff --cached`.
  const [unstaged, staged] = await Promise.all([git.diffSummary(), git.diffSummary(["--cached"])]);
  const counts = countsByFile([...unstaged.files, ...staged.files]);

  const files: GitFileChange[] = status.files.map((file) => {
    const indexLetter = file.index.trim();
    const workingLetter = file.working_dir.trim();
    const isStaged = indexLetter !== "" && indexLetter !== "?";
    const letter = isStaged ? indexLetter : workingLetter === "" ? indexLetter : workingLetter;
    const count = counts.get(file.path) ?? { insertions: 0, deletions: 0 };
    return {
      path: file.path,
      status: toLetter(letter),
      insertions: count.insertions,
      deletions: count.deletions,
      staged: isStaged,
    };
  });

  const detached = status.detached;
  const branch =
    status.current !== null && status.current !== "" && !detached
      ? status.current
      : (await git.revparse(["--short", "HEAD"])).trim();

  return {
    repoPath,
    branch,
    detached,
    files,
    insertions: files.reduce((total, file) => total + file.insertions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}

// A file bigger than this is reported as `binary: true` rather than shipped
// to the renderer. The renderer builds one DOM node per line; an unbounded
// generated file would freeze the window, and the diff is not readable at
// that size anyway.
const MAX_DIFF_BYTES = 2_000_000;

/**
 * Rejects a path that would read outside the repository. The path arrives
 * from the renderer and from the brain, so neither may be trusted to have
 * come from the changed-file list we produced.
 */
function insideRepo(filePath: string): boolean {
  if (isAbsolute(filePath)) return false;
  const normalized = normalize(filePath);
  return !normalized.startsWith("..") && normalized !== ".";
}

/**
 * insideRepo() above is a lexical check only — it never touches the
 * filesystem, so it cannot see that an untracked path inside the repo is a
 * symlink whose target resolves *outside* it (ruling P17: an agent, which
 * routinely creates files as part of the product, can plant a symlink to
 * e.g. ~/.ssh/id_rsa; the untracked-file branch below would then read the
 * link's target and hand its contents to the Changes view).
 *
 * The filesystem half of that check lives in paths.ts, shared with the
 * workspace's document reader: two copies of a security check are how the
 * two drift apart.
 */

// A huge repo, a stalled index lock, or a network-mounted .git can make the
// real git binary never return. GitOutcome has no way to express "still
// running" — a hang here is the one gap the discriminated union can't
// cover — so every spawned git process is bounded by simple-git's own
// timeout plugin. The default is generous (a slow-but-healthy repo on a
// loaded machine should not be misreported as broken); callers can override
// it, same as core/registry/health.ts's DEFAULT_HEALTH_TIMEOUT_MS.
export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

function isTimeout(error: unknown): boolean {
  return error instanceof GitPluginError && error.plugin === "timeout";
}

export function createGitProvider(timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS): GitProvider {
  async function open(repoPath: string): Promise<GitOutcome<SimpleGit>> {
    try {
      const git = simpleGit(repoPath, { timeout: { block: timeoutMs } });
      const isRepo = await git.checkIsRepo();
      if (!isRepo) return failure("not-a-repo", repoPath);
      return { ok: true, value: git };
    } catch (error) {
      if (isTimeout(error)) {
        // A timeout here says nothing about whether repoPath is a repo —
        // the check simply never got an answer — so it must not be folded
        // into "not-a-repo", which would tell the user the wrong thing.
        // "failed" is the closest existing GitFailureCode; there is no
        // dedicated timeout code (GitFailureCode is consumed by fifteen
        // downstream tasks, so this task does not add one).
        return failure("failed", `git timed out after ${timeoutMs}ms opening ${repoPath}`);
      }
      // A missing directory, a permissions problem, or no git binary at all.
      // The spec requires this to be shown, never to blow up the caller.
      return failure("not-a-repo", `${repoPath}: ${errorMessage(error)}`);
    }
  }

  return {
    async changes(repoPath) {
      const opened = await open(repoPath);
      if (!opened.ok) return opened;
      try {
        return { ok: true, value: await readChanges(opened.value, repoPath) };
      } catch (error) {
        return failure("failed", errorMessage(error));
      }
    },

    async diff(repoPath, filePath): Promise<GitOutcome<GitFileDiff>> {
      if (!insideRepo(filePath)) {
        return failure("failed", `path outside the repository: ${filePath}`);
      }
      const opened = await open(repoPath);
      if (!opened.ok) return opened;
      const git = opened.value;

      try {
        const status = await git.status();
        const untracked = status.not_added.some((path) => path === filePath);

        if (untracked) {
          if (!(await resolvesInside(repoPath, filePath))) {
            return failure("failed", `path outside the repository: ${filePath}`);
          }
          const info = await stat(join(repoPath, filePath));
          if (info.size > MAX_DIFF_BYTES) {
            return { ok: true, value: { path: filePath, binary: false, tooLarge: true, hunks: [] } };
          }
          const buffer = await readFile(join(repoPath, filePath));
          if (buffer.includes(0)) {
            return { ok: true, value: { path: filePath, binary: true, hunks: [] } };
          }
          return { ok: true, value: addedFileDiff(filePath, buffer.toString("utf8")) };
        }

        // A renamed file is keyed by its *new* path in status.files, but
        // carries the pre-rename path in `.from` (present only for a rename
        // or copy). Diffing by the new path alone (`git diff HEAD -- <new>`)
        // cannot see the rename — the new path never existed at HEAD — so
        // it reports the whole file as freshly added, contradicting
        // changes()'s correct 0/0 for a pure rename. Passing *both* paths as
        // pathspecs, with `-M` to force rename detection regardless of the
        // repository's `diff.renames` setting, makes git match the rename
        // and diff only its real content delta (verified against real git:
        // nothing for a pure rename, only the edited lines for a rename
        // with edits).
        const entry = status.files.find((file) => file.path === filePath);
        const fromPath = entry?.from;
        const renamed = fromPath !== undefined && fromPath !== filePath;

        // Diffed against HEAD rather than the index, so one call shows a
        // change whether it is staged, unstaged, or both — matching
        // `changes()` above, which sums the unstaged and staged summaries
        // for the same file into one row. Showing only one of the two would
        // make the file list and the diff pane disagree about the same file.
        const raw = renamed
          ? await git.diff(["-M", "HEAD", "--", fromPath, filePath])
          : await git.diff(["HEAD", "--", filePath]);

        // Measured in real bytes (not UTF-16 code units) so the cap means
        // the same thing here as it does on the untracked branch above,
        // where it is compared against stat()'s byte size — otherwise
        // non-ASCII content (e.g. Arabic) gets up to double the effective
        // cap on this branch.
        if (Buffer.byteLength(raw, "utf8") > MAX_DIFF_BYTES) {
          return { ok: true, value: { path: filePath, binary: false, tooLarge: true, hunks: [] } };
        }
        return { ok: true, value: parseUnifiedDiff(filePath, raw) };
      } catch (error) {
        return failure("failed", errorMessage(error));
      }
    },

    async stage(repoPath, paths): Promise<GitOutcome<null>> {
      // An empty list must never become a bare `git add`, which would stage
      // the whole worktree — the opposite of what the caller asked for.
      if (paths.length === 0) return { ok: true, value: null };
      const outsidePath = paths.find((path) => !insideRepo(path));
      if (outsidePath !== undefined) {
        return failure("failed", `path outside the repository: ${outsidePath}`);
      }
      const opened = await open(repoPath);
      if (!opened.ok) return opened;
      try {
        await opened.value.add(paths);
        return { ok: true, value: null };
      } catch (error) {
        return failure("failed", errorMessage(error));
      }
    },

    async unstage(repoPath, paths): Promise<GitOutcome<null>> {
      if (paths.length === 0) return { ok: true, value: null };
      const outsidePath = paths.find((path) => !insideRepo(path));
      if (outsidePath !== undefined) {
        return failure("failed", `path outside the repository: ${outsidePath}`);
      }
      const opened = await open(repoPath);
      if (!opened.ok) return opened;
      try {
        // `--` separates paths from revisions, so a file literally named
        // like a branch cannot be misread as one. On an unborn HEAD (no
        // commits yet) `git reset -- <paths>` still works: git resets the
        // index entries against the empty tree instead of failing.
        await opened.value.reset(["--", ...paths]);
        return { ok: true, value: null };
      } catch (error) {
        return failure("failed", errorMessage(error));
      }
    },

    async commit(repoPath, message): Promise<GitOutcome<GitCommitResult>> {
      if (message.trim() === "") return failure("empty-message", "");
      const opened = await open(repoPath);
      if (!opened.ok) return opened;
      const git = opened.value;

      try {
        const status = await git.status();
        if (status.conflicted.length > 0) {
          return failure("conflict", status.conflicted.join(", "));
        }

        const staged = await git.diffSummary(["--cached"]);
        if (staged.files.length === 0) return failure("nothing-staged", repoPath);

        // simple-git's commit() passes the message as a `-m` argument to the
        // spawned git binary, never through a shell, so newlines, quotes and
        // a leading `-` all survive intact without any escaping here.
        const result = await git.commit(message);
        // A rejected pre-commit hook makes the git binary exit non-zero, but
        // simple-git's commit() does not throw for that — it resolves with
        // an empty CommitResult (`commit: ""`) parsed from git's stderr
        // instead of the usual "[branch sha] message" stdout line. That
        // empty sha is the one reliable signal that nothing actually landed;
        // treating it as success would report a commit that never happened.
        if (result.commit === "") {
          return failure("failed", "git rejected the commit (a hook may have failed)");
        }
        // Both the sha and the files-changed count are read from git's own
        // report of the commit it just made — `result.summary.changes` is
        // parsed from the real "N files changed" line git prints, not
        // assembled from what we intended to commit before calling commit().
        // That holds for the first commit on an unborn HEAD too, where there
        // is no parent to diff against.
        const sha = (await git.revparse(["--short", "HEAD"])).trim();
        return {
          ok: true,
          value: { sha, filesChanged: result.summary.changes },
        };
      } catch (error) {
        return failure("failed", errorMessage(error));
      }
    },
  };
}
