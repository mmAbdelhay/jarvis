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
import { simpleGit, type SimpleGit } from "simple-git";

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

export function createGitProvider(): GitProvider {
  async function open(repoPath: string): Promise<GitOutcome<SimpleGit>> {
    try {
      const git = simpleGit(repoPath);
      const isRepo = await git.checkIsRepo();
      if (!isRepo) return failure("not-a-repo", repoPath);
      return { ok: true, value: git };
    } catch (error) {
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
          const info = await stat(join(repoPath, filePath));
          if (info.size > MAX_DIFF_BYTES) {
            return { ok: true, value: { path: filePath, binary: true, hunks: [] } };
          }
          const buffer = await readFile(join(repoPath, filePath));
          if (buffer.includes(0)) {
            return { ok: true, value: { path: filePath, binary: true, hunks: [] } };
          }
          return { ok: true, value: addedFileDiff(filePath, buffer.toString("utf8")) };
        }

        // Diffed against HEAD rather than the index, so one call shows a
        // change whether it is staged, unstaged, or both — matching
        // `changes()` above, which sums the unstaged and staged summaries
        // for the same file into one row. Showing only one of the two would
        // make the file list and the diff pane disagree about the same file.
        const raw = await git.diff(["HEAD", "--", filePath]);
        if (raw.length > MAX_DIFF_BYTES) {
          return { ok: true, value: { path: filePath, binary: true, hunks: [] } };
        }
        return { ok: true, value: parseUnifiedDiff(filePath, raw) };
      } catch (error) {
        return failure("failed", errorMessage(error));
      }
    },

    async stage(_repoPath, _paths): Promise<GitOutcome<null>> {
      return failure("failed", "not implemented");
    },

    async unstage(_repoPath, _paths): Promise<GitOutcome<null>> {
      return failure("failed", "not implemented");
    },

    async commit(_repoPath, _message): Promise<GitOutcome<GitCommitResult>> {
      return failure("failed", "not implemented");
    },
  };
}
