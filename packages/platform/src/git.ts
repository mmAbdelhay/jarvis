import { simpleGit, type SimpleGit } from "simple-git";
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

function countsByFile(files: readonly { file: string; binary: boolean }[]): Map<string, Counts> {
  const counts = new Map<string, Counts>();
  for (const entry of files) {
    if (entry.binary) {
      counts.set(entry.file, { insertions: 0, deletions: 0 });
      continue;
    }
    if ("insertions" in entry && "deletions" in entry) {
      const insertions = typeof entry.insertions === "number" ? entry.insertions : 0;
      const deletions = typeof entry.deletions === "number" ? entry.deletions : 0;
      const existing = counts.get(entry.file) ?? { insertions: 0, deletions: 0 };
      counts.set(entry.file, {
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

    async diff(_repoPath, _filePath): Promise<GitOutcome<GitFileDiff>> {
      return failure("failed", "not implemented");
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
