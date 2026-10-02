import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { addedFileDiff, parseUnifiedDiff } from "@jarvis/core";
import { spawn } from "node:child_process";
import type {
  GitBranches,
  GitChanges,
  GitCommitResult,
  GitFailure,
  GitFileChange,
  GitFileDiff,
  GitOutcome,
  GitProvider,
  GitPullRequest,
  GitPullResult,
  GitPushResult,
  GitRemoteOps,
  GitStatusLetter,
  GitWorktree,
  GitWorktreeInfo,
  GitWorktrees,
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
    // Read from the same `git status` call, so it costs nothing. Absent
    // altogether for a branch that tracks nothing, rather than 0/0, so
    // "in step with its remote" and "has no remote" never look the same.
    ...(status.tracking !== null && status.tracking !== ""
      ? { upstream: status.tracking, ahead: status.ahead, behind: status.behind }
      : {}),
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
  // C3: a path beginning with "-" is never a real repo-relative path — it
  // is how git's own argument parser reads an option, and every call site
  // below also passes `--` before its paths as a second, independent
  // guard. `--pathspec-from-file=<file>` in particular would make git read
  // and stage an attacker-chosen list of paths out of a file it names.
  if (filePath.startsWith("-")) return false;
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

/**
 * What a caught git error says.
 *
 * A tripped timeout is worth naming as one. Every git call below is bounded
 * by the timeout plugin, and simple-git reports a tripped bound as "block
 * timeout reached" — true, but it reads as an internal detail rather than as
 * the one thing the reader can act on, which is that git did not answer in
 * time.
 *
 * Which call trips first is not fixed. open()'s checkIsRepo() is the usual
 * one on a slow filesystem, but on a fast machine it can return well inside
 * the bound and a later call times out instead. Both paths have to say the
 * same thing, or the message a user sees depends on their disk — which is
 * exactly how this surfaced: as a test that passed on one machine and failed
 * on another.
 *
 * open() keeps its own wording because it knows the repository path it was
 * opening; these calls do not.
 */
function gitErrorDetail(error: unknown, timeoutMs: number): string {
  return isTimeout(error) ? `git timed out after ${timeoutMs}ms` : errorMessage(error);
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
        return failure("failed", gitErrorDetail(error, timeoutMs));
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
            return {
              ok: true,
              value: { path: filePath, binary: false, tooLarge: true, hunks: [] },
            };
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
        return failure("failed", gitErrorDetail(error, timeoutMs));
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
        // `--` separates paths from options, same reasoning as unstage's
        // `reset -- <paths>` below: insideRepo() already refused a
        // leading "-", this is the second, independent guard.
        await opened.value.add(["--", ...paths]);
        return { ok: true, value: null };
      } catch (error) {
        return failure("failed", gitErrorDetail(error, timeoutMs));
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
        return failure("failed", gitErrorDetail(error, timeoutMs));
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
        return failure("failed", gitErrorDetail(error, timeoutMs));
      }
    },
  };
}

// ---------------------------------------------------------------- remote ops

/** Pull, push and `gh` reach the network; a slow remote on a slow link is
 *  still healthy at a minute, so these get far longer than local calls. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 120_000;

export type GhRunner = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type GitRemoteOptions = {
  timeoutMs?: number;
  /** What git and gh run with — the login-shell PATH in production, so
   *  both are found where the user installed them. A function is read on
   *  every call: that PATH is resolved after startup. */
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  /** Runs `gh` in a directory. Injected so tests never reach GitHub. */
  gh?: GhRunner;
};

/**
 * Nothing here may wait on a person. A credential prompt from git, a
 * credential manager or gh would sit invisibly until the timeout and then
 * report something misleading; with these, each fails at once and says
 * what it needed instead.
 */
const NON_INTERACTIVE: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GH_PROMPT_DISABLED: "1",
};

/**
 * A branch name the user typed, refused before git sees it when it could
 * be read as an option, and otherwise checked by git itself
 * (`check-ref-format --branch`): git's own rules for a ref name are long,
 * version-dependent and not worth restating here.
 */
async function validBranchName(git: SimpleGit, name: string): Promise<boolean> {
  if (name === "" || name.startsWith("-") || name !== name.trim()) return false;
  try {
    await git.raw(["check-ref-format", "--branch", name]);
    return true;
  } catch {
    return false;
  }
}

function defaultGh(env: () => NodeJS.ProcessEnv, timeoutMs: number): GhRunner {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn("gh", args, { cwd, env: env(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`gh timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
}

/** The last https:// URL gh printed — `gh pr create` ends with the new
 *  pull request's address, after any warnings it chose to print first. */
function lastUrl(text: string): string | undefined {
  const urls = text.match(/https:\/\/\S+/g);
  return urls?.at(-1);
}

export function createGitRemoteOps(options: GitRemoteOptions = {}): GitRemoteOps {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  const env = (): NodeJS.ProcessEnv => {
    const base = typeof options.env === "function" ? options.env() : options.env;
    return { ...(base ?? process.env), ...NON_INTERACTIVE };
  };
  const gh = options.gh ?? defaultGh(env, timeoutMs);

  async function open(repoPath: string): Promise<GitOutcome<SimpleGit>> {
    try {
      const git = simpleGit(repoPath, {
        timeout: { block: timeoutMs },
        // simple-git vets an environment handed to it explicitly, and
        // refuses the askpass, editor, pager, ssh and credential settings
        // a user's own shell commonly carries (an editor's GIT_ASKPASS, a
        // GIT_SSH_COMMAND). That environment is the user's login shell,
        // the very one createGitProvider's git inherits without being
        // asked — passing it explicitly, to add NON_INTERACTIVE, must not
        // make git behave differently from the user's own terminal. Every
        // argument this module passes is fixed or validated; nothing here
        // forwards a `-c` from outside.
        unsafe: {
          allowUnsafeAskPass: true,
          allowUnsafeCredentialHelper: true,
          allowUnsafeEditor: true,
          allowUnsafePager: true,
          allowUnsafeSshCommand: true,
          allowUnsafeConfigPaths: true,
          allowUnsafeConfigEnvCount: true,
        },
      }).env(env());
      if (!(await git.checkIsRepo())) return failure("not-a-repo", repoPath);
      return { ok: true, value: git };
    } catch (error) {
      return failure("not-a-repo", `${repoPath}: ${gitErrorDetail(error, timeoutMs)}`);
    }
  }

  async function push(repoPath: string): Promise<GitOutcome<GitPushResult>> {
    const opened = await open(repoPath);
    if (!opened.ok) return opened;
    const git = opened.value;
    try {
      const status = await git.status();
      const branch = status.current;
      if (status.detached || branch === null || branch === "") return failure("detached", "");
      if (status.tracking !== null && status.tracking !== "") {
        const remote = status.tracking.split("/")[0] ?? "origin";
        try {
          await git.raw(["push"]);
        } catch (error) {
          const detail = gitErrorDetail(error, timeoutMs);
          return /rejected|non-fast-forward|fetch first/i.test(detail)
            ? failure("rejected", detail)
            : failure("failed", detail);
        }
        return { ok: true, value: { remote, branch, upstreamSet: false } };
      }
      // No upstream yet: `origin` when there is one, else the only remote.
      // With several and no origin, which one is meant is not ours to guess.
      const remotes = (await git.getRemotes()).map((remote) => remote.name);
      const remote = remotes.includes("origin")
        ? "origin"
        : remotes.length === 1
          ? remotes[0]
          : undefined;
      if (remote === undefined) return failure("no-remote", remotes.join(", "));
      await git.raw(["push", "--set-upstream", remote, branch]);
      return { ok: true, value: { remote, branch, upstreamSet: true } };
    } catch (error) {
      return failure("failed", gitErrorDetail(error, timeoutMs));
    }
  }

  return {
    async branches(repoPath): Promise<GitOutcome<GitBranches>> {
      const opened = await open(repoPath);
      if (!opened.ok) return opened;
      try {
        const summary = await opened.value.branchLocal();
        return {
          ok: true,
          value: { current: summary.current, detached: summary.detached, local: summary.all },
        };
      } catch (error) {
        return failure("failed", gitErrorDetail(error, timeoutMs));
      }
    },

    async switchBranch(repoPath, name, create): Promise<GitOutcome<null>> {
      const opened = await open(repoPath);
      if (!opened.ok) return opened;
      const git = opened.value;
      try {
        if (!(await validBranchName(git, name))) return failure("invalid-branch", name);
        if (!create) {
          const local = await git.branchLocal();
          if (!local.all.includes(name)) return failure("invalid-branch", name);
        }
        // Plain `switch`: uncommitted changes come along, and git refuses
        // on its own when they would be overwritten — its message says
        // which files, which is the useful thing to show.
        await git.raw(create ? ["switch", "--create", name] : ["switch", name]);
        return { ok: true, value: null };
      } catch (error) {
        return failure("failed", gitErrorDetail(error, timeoutMs));
      }
    },

    async pull(repoPath): Promise<GitOutcome<GitPullResult>> {
      const opened = await open(repoPath);
      if (!opened.ok) return opened;
      const git = opened.value;
      try {
        const status = await git.status();
        if (status.detached) return failure("detached", "");
        if (status.tracking === null || status.tracking === "") return failure("no-upstream", "");
        const before = (await git.revparse(["HEAD"])).trim();
        try {
          // Fast-forward only: a pull from a button must never start a
          // merge, write a merge commit or leave conflicts in the tree.
          await git.raw(["pull", "--ff-only"]);
        } catch (error) {
          const detail = gitErrorDetail(error, timeoutMs);
          return /fast-forward|diverg/i.test(detail)
            ? failure("diverged", detail)
            : failure("failed", detail);
        }
        const after = (await git.revparse(["HEAD"])).trim();
        return { ok: true, value: { updated: before !== after } };
      } catch (error) {
        return failure("failed", gitErrorDetail(error, timeoutMs));
      }
    },

    push,

    async pullRequest(repoPath): Promise<GitOutcome<GitPullRequest>> {
      const opened = await open(repoPath);
      if (!opened.ok) return opened;
      try {
        const status = await opened.value.status();
        if (status.detached) return failure("detached", "");
        // A pull request is of what the remote has: commits only this
        // machine holds go up first, so the pull request is not missing
        // them.
        if (status.tracking === null || status.tracking === "" || status.ahead > 0) {
          const pushed = await push(repoPath);
          if (!pushed.ok) return pushed;
        }
      } catch (error) {
        return failure("failed", gitErrorDetail(error, timeoutMs));
      }

      try {
        const existing = await gh(["pr", "view", "--json", "url,state"], repoPath);
        if (existing.code === 0) {
          const parsed = JSON.parse(existing.stdout) as { url?: unknown; state?: unknown };
          if (typeof parsed.url === "string" && parsed.state === "OPEN") {
            return { ok: true, value: { url: parsed.url, created: false } };
          }
        }
        const created = await gh(["pr", "create", "--fill"], repoPath);
        const url = lastUrl(created.stdout);
        if (created.code !== 0 || url === undefined) {
          const detail = (created.stderr || created.stdout).trim();
          return /auth login|not logged|authenticat/i.test(detail)
            ? failure("no-gh", detail)
            : failure("failed", detail);
        }
        return { ok: true, value: { url, created: true } };
      } catch (error) {
        // ENOENT: there is no gh on this PATH at all.
        const detail = errorMessage(error);
        return /ENOENT/.test(detail) ? failure("no-gh", "gh") : failure("failed", detail);
      }
    },
  };
}

// ------------------------------------------------------------------ worktrees

export type GitWorktreeOptions = {
  /** Where new worktrees go, one directory each. Outside every repository
   *  on purpose: a worktree inside its own repo would show up as an
   *  untracked directory in the main checkout's Changes view. */
  root: string;
  timeoutMs?: number;
};

/** A label turned into something safe as both a branch segment and a
 *  directory name on every OS. */
function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? "session" : slug;
}

export function createGitWorktrees(options: GitWorktreeOptions): GitWorktrees {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const gitAt = (dir: string): SimpleGit => simpleGit(dir, { timeout: { block: timeoutMs } });

  /** Tracked changes only: an untracked file is not lost by a merge or a
   *  removal git would refuse, and a build directory nobody ignored must
   *  not block either. */
  async function trackedChanges(git: SimpleGit): Promise<string[]> {
    const status = await git.status();
    return status.files.filter((file) => file.index !== "?").map((file) => file.path);
  }

  async function info(path: string): Promise<GitOutcome<GitWorktreeInfo | null>> {
    try {
      const git = gitAt(path);
      if (!(await git.checkIsRepo())) return { ok: true, value: null };
      const [gitDir, commonDir] = (
        await git.raw(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])
      )
        .trim()
        .split("\n")
        .map((line) => line.trim());
      // A main checkout's git dir *is* its common dir; a linked worktree's
      // lives under the common dir's `worktrees/`.
      if (gitDir === undefined || commonDir === undefined || gitDir === commonDir) {
        return { ok: true, value: null };
      }
      // A worktree of a bare repository has no main checkout to merge into.
      if (basename(commonDir) !== ".git") return { ok: true, value: null };
      const base = dirname(commonDir);
      const branch = (await git.raw(["branch", "--show-current"])).trim();
      const baseBranch = (await gitAt(base).raw(["branch", "--show-current"])).trim();
      return { ok: true, value: { base, branch, baseBranch } };
    } catch (error) {
      return failure("failed", gitErrorDetail(error, timeoutMs));
    }
  }

  return {
    async create(repoPath, label): Promise<GitOutcome<GitWorktree>> {
      try {
        const git = gitAt(repoPath);
        if (!(await git.checkIsRepo())) return failure("not-a-repo", repoPath);
        const top = (await git.revparse(["--show-toplevel"])).trim();
        // A project configured as a subdirectory of its repository runs in
        // the same subdirectory of the worktree. Asked of git rather than
        // computed with relative(top, repoPath): git spells `top` its own
        // way (macOS's /private/var for /var, Windows' long name for a
        // RUNNER~1 short one), and a relative path across two spellings
        // climbs back out to the main checkout.
        const prefix = (await git.revparse(["--show-prefix"])).trim();
        const inside = prefix.replace(/\/+$/, "");
        const slug = slugify(label);
        const branch = `jarvis/${slug}`;
        const dir = join(options.root, `${slugify(basename(top))}-${slug}`);
        await mkdir(options.root, { recursive: true });
        // `--` after the options: the branch and directory are ours, but a
        // fixed separator costs nothing and keeps either from ever being
        // read as an option.
        await git.raw(["worktree", "add", "-b", branch, "--", dir, "HEAD"]);
        return { ok: true, value: { path: inside === "" ? dir : join(dir, inside), branch } };
      } catch (error) {
        return failure("failed", gitErrorDetail(error, timeoutMs));
      }
    },

    info,

    async mergeBack(path): Promise<GitOutcome<{ into: string }>> {
      const found = await info(path);
      if (!found.ok) return found;
      if (found.value === null) return failure("not-a-worktree", path);
      const { base, branch, baseBranch } = found.value;
      if (baseBranch === "") return failure("detached", base);
      try {
        if ((await trackedChanges(gitAt(path))).length > 0) return failure("worktree-dirty", "");
        const baseGit = gitAt(base);
        const dirty = await trackedChanges(baseGit);
        if (dirty.length > 0) return failure("base-dirty", dirty.slice(0, 5).join(", "));
        let detail = "";
        try {
          await baseGit.raw(["merge", "--no-ff", "--no-edit", branch]);
        } catch (error) {
          detail = gitErrorDetail(error, timeoutMs);
        }
        // simple-git does not reject a merge that stopped on conflicts — git
        // reports those on stdout — so the tree itself is the answer. Never
        // leave the main checkout mid-merge: back out completely and say so.
        const conflicted = (await baseGit.status()).conflicted;
        if (conflicted.length > 0 || detail !== "") {
          await baseGit.raw(["merge", "--abort"]).catch(() => undefined);
          return failure("conflict", conflicted.length > 0 ? conflicted.join(", ") : detail);
        }
        return { ok: true, value: { into: baseBranch } };
      } catch (error) {
        return failure("failed", gitErrorDetail(error, timeoutMs));
      }
    },

    async remove(path): Promise<GitOutcome<null>> {
      const found = await info(path);
      if (!found.ok) return found;
      if (found.value === null) return failure("not-a-worktree", path);
      try {
        const top = (await gitAt(path).revparse(["--show-toplevel"])).trim();
        if ((await trackedChanges(gitAt(path))).length > 0) return failure("worktree-dirty", "");
        // No --force: git refuses on its own anything it would lose.
        await gitAt(found.value.base).raw(["worktree", "remove", "--", top]);
        return { ok: true, value: null };
      } catch (error) {
        return failure("failed", gitErrorDetail(error, timeoutMs));
      }
    },
  };
}
