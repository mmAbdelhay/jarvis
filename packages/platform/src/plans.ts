import { watch as watchDir, type FSWatcher, type Stats } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AgentConfig } from "@jarvis/core";
import { parsePlan, replaceBlock, type PlanBlock } from "@jarvis/core";

/**
 * Where the panel finds plan text: a running session's own reference to a
 * plan file, the plan-mode scratch files an agent writes under
 * `~/.claude/plans`, and the repo's own `docs/superpowers/{specs,plans}`.
 *
 * Everything here mirrors `transcriptDirs` in session-import.ts: same base
 * resolution (`configDir ?? <home>/.claude`), same "missing directory is
 * the ordinary case, not an error" posture. Anthropic-only, for the same
 * reason session import is — Copilot keeps no such scratch directory.
 *
 * All I/O is injected (`fs`), same as every manager in this package: the
 * suite runs against real temp directories rather than a fake, but the seam
 * exists so a future caller can substitute one.
 */

export type PlanSource = "session" | "planMode" | "repo";

export type PlanEntry = {
  path: string;
  name: string;
  source: PlanSource;
  repoKind?: "spec" | "plan";
  /** basename of cwd found in transcript dir, planMode only */
  project?: string;
  mtimeMs: number;
};

export type PlanList = { session?: PlanEntry; planMode: PlanEntry[]; repo: PlanEntry[] };

export type PlanDoc = { path: string; mtimeMs: number; blocks: PlanBlock[] };

export type PlanResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: "forbidden" | "not-found" | "too-large" | "conflict" | "missing-block" | "io";
      detail?: string;
      doc?: PlanDoc;
    };

export type PlanFiles = {
  list(cwd: string | undefined): Promise<PlanList>;
  read(path: string): Promise<PlanResult<PlanDoc>>;
  writeBlock(
    path: string,
    blockId: string,
    newSource: string,
    baseMtimeMs: number,
  ): Promise<PlanResult<PlanDoc>>;
  isAllowed(path: string): Promise<boolean>;
  watch(onChange: (path: string) => void, cwds: () => readonly string[]): () => void;
};

/** Every character that is not `[A-Za-z0-9]` becomes `-`. Mirrors the shape
 *  of the escaped project directory names Claude Code itself writes under
 *  `<configDir>/projects/`, so a session's own plan reference can be found
 *  without ever parsing that directory name back into a path. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

const MAX_PLAN_BYTES = 1024 * 1024;
const SESSION_TAIL_BYTES = 512 * 1024;
const PLAN_LINK = /\/plans\/[A-Za-z0-9._-]+\.md/g;
const WATCH_DEBOUNCE_MS = 150;
const WATCH_RESCAN_MS = 5000;
const PLAN_MODE_LIMIT = 10;
const REPO_LIMIT = 20;

type FsDeps = typeof fsPromises;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Strips any trailing `/` or `\` (but never collapses a bare root). A
 *  `configDir` ending in a separator would otherwise leave `anthropicBases`
 *  holding a string with a redundant trailing slash — harmless everywhere
 *  a path goes through `join()` (it normalizes), but fatal to
 *  `resolveSessionMatch`'s raw `preceding.endsWith(base)` check, which
 *  compares against the base as literal text. */
function stripTrailingSep(value: string): string {
  let end = value.length;
  while (end > 1 && (value[end - 1] === "/" || value[end - 1] === "\\")) end--;
  return value.slice(0, end);
}

/** Every distinct anthropic account's base config directory, in agent order —
 *  the same fallback `transcriptDirs` uses, deduplicated so two agents
 *  sharing a `configDir` (or both falling back to the default) are read once. */
function anthropicBases(agents: readonly AgentConfig[], home: string): string[] {
  const seen = new Set<string>();
  const bases: string[] = [];
  for (const agent of agents) {
    if (agent.vendor !== "anthropic") continue;
    const base = stripTrailingSep(agent.configDir ?? join(home, ".claude"));
    if (seen.has(base)) continue;
    seen.add(base);
    bases.push(base);
  }
  return bases;
}

function plansDirsOf(agents: readonly AgentConfig[], home: string): string[] {
  return anthropicBases(agents, home).map((base) => join(base, "plans"));
}

/** True when `child` resolves inside `parent` — both already realpath'd, so
 *  this is a plain lexical comparison of two trustworthy strings. */
function isWithinReal(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Whether `real`'s ancestry is `.../docs/superpowers/{specs,plans}/<file>`,
 *  checked as a plain directory-name chain on an already-resolved path. */
function hasRepoAncestry(real: string): boolean {
  const leafDir = dirname(real);
  const kind = basename(leafDir);
  if (kind !== "specs" && kind !== "plans") return false;
  const superpowersDir = dirname(leafDir);
  if (basename(superpowersDir) !== "superpowers") return false;
  const docsDir = dirname(superpowersDir);
  return basename(docsDir) === "docs";
}

async function readdirSafe(fs: FsDeps, dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    // A directory that does not exist yet contributes nothing — the
    // ordinary case for a fresh install or a project with no repo plans.
    return [];
  }
}

async function listMarkdown(
  fs: FsDeps,
  dir: string,
  build: (path: string, name: string, mtimeMs: number) => PlanEntry,
): Promise<PlanEntry[]> {
  const names = await readdirSafe(fs, dir);
  const entries: PlanEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    let info: Stats;
    try {
      info = await fs.stat(path);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    entries.push(build(path, name, info.mtimeMs));
  }
  return entries;
}

async function listPlanMode(fs: FsDeps, plansDirs: readonly string[]): Promise<PlanEntry[]> {
  const entries: PlanEntry[] = [];
  for (const dir of plansDirs) {
    entries.push(
      ...(await listMarkdown(fs, dir, (path, name, mtimeMs) => ({
        path,
        name,
        source: "planMode",
        mtimeMs,
      }))),
    );
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.slice(0, PLAN_MODE_LIMIT);
}

async function listRepo(fs: FsDeps, cwd: string): Promise<PlanEntry[]> {
  const kinds: { dir: string; repoKind: "spec" | "plan" }[] = [
    { dir: join(cwd, "docs", "superpowers", "specs"), repoKind: "spec" },
    { dir: join(cwd, "docs", "superpowers", "plans"), repoKind: "plan" },
  ];
  const entries: PlanEntry[] = [];
  for (const { dir, repoKind } of kinds) {
    entries.push(
      ...(await listMarkdown(fs, dir, (path, name, mtimeMs) => ({
        path,
        name,
        source: "repo",
        repoKind,
        mtimeMs,
      }))),
    );
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.slice(0, REPO_LIMIT);
}

/** At most the last `maxBytes` of `path`, as text. Mirrors `readHead` in
 *  session-import.ts, tail instead of head: the plan a session last touched
 *  is named near the end of its transcript, not the start. */
async function readTail(fs: FsDeps, path: string, maxBytes: number): Promise<string> {
  const info = await fs.stat(path);
  const start = Math.max(0, info.size - maxBytes);
  const handle = await fs.open(path, "r");
  try {
    const length = info.size - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

type SessionCandidate = { path: string; name: string; mtimeMs: number };

/** Resolves one `/plans/<file>.md` regex match against the known bases: the
 *  text immediately before the match must end with a base directory, which
 *  together with the match's own leading `/plans/` reconstructs exactly
 *  `<base>/plans/<file>.md` — a path this module actually knows about,
 *  rather than any substring that happens to look like one. */
async function resolveSessionMatch(
  fs: FsDeps,
  bases: readonly string[],
  text: string,
  match: RegExpMatchArray,
): Promise<SessionCandidate | null> {
  if (match.index === undefined) return null;
  const preceding = text.slice(0, match.index);
  const filename = match[0].slice("/plans/".length);
  for (const base of bases) {
    if (!preceding.endsWith(base)) continue;
    const candidate = join(base, "plans", filename);
    try {
      const info = await fs.stat(candidate);
      if (info.isFile()) return { path: candidate, name: filename, mtimeMs: info.mtimeMs };
    } catch {
      // Named in the transcript, gone from disk since.
    }
    return null;
  }
  return null;
}

/** The plan a session was last working on, or null when its transcript
 *  names none still on disk. Scans only the single newest transcript across
 *  every base for `cwd`'s escaped project directory — one file, its last
 *  512 KiB, same bound `readHead` uses for the same reason: cost equal to a
 *  4 KB transcript regardless of how large the real one is. */
async function findSessionEntry(
  fs: FsDeps,
  bases: readonly string[],
  cwd: string,
): Promise<SessionCandidate | null> {
  const slug = claudeProjectSlug(cwd);
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const base of bases) {
    const dir = join(base, "projects", slug);
    const names = await readdirSafe(fs, dir);
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      let info: Stats;
      try {
        info = await fs.stat(path);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      if (newest === null || info.mtimeMs > newest.mtimeMs)
        newest = { path, mtimeMs: info.mtimeMs };
    }
  }
  if (newest === null) return null;

  const text = await readTail(fs, newest.path, SESSION_TAIL_BYTES);
  const matches = [...text.matchAll(PLAN_LINK)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    if (match === undefined) continue;
    const resolved = await resolveSessionMatch(fs, bases, text, match);
    if (resolved !== null) return resolved;
  }
  return null;
}

/**
 * The platform seam for the plan panel: discovery (`list`), the path guard
 * every read and write goes through (`isAllowed`), atomic read/write
 * (`read`, `writeBlock`), and change notification (`watch`).
 *
 * Shaped like every other manager in this package — `createCodeServerManager`,
 * `createDbGateManager` — a factory over injected deps, so the IPC layer that
 * calls this owns no I/O of its own.
 */
export function createPlanFiles(deps: {
  agents: () => readonly AgentConfig[];
  home: string;
  fs?: typeof import("node:fs/promises");
  now?: () => number;
}): PlanFiles {
  const { agents, home } = deps;
  const fs = deps.fs ?? fsPromises;

  async function resolveAllowed(path: string): Promise<string | null> {
    if (!isAbsolute(path)) return null;

    let real: string;
    try {
      real = await fs.realpath(path);
    } catch {
      return null;
    }
    if (!real.endsWith(".md")) return null;

    let info: Stats;
    try {
      info = await fs.stat(real);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;

    for (const dir of plansDirsOf(agents(), home)) {
      let realDir: string;
      try {
        realDir = await fs.realpath(dir);
      } catch {
        continue;
      }
      if (isWithinReal(real, realDir)) return real;
    }

    return hasRepoAncestry(real) ? real : null;
  }

  async function statOrReason(
    path: string,
  ): Promise<{ ok: true; info: Stats } | { ok: false; result: PlanResult<PlanDoc> }> {
    try {
      return { ok: true, info: await fs.stat(path) };
    } catch (error) {
      if (isEnoent(error)) return { ok: false, result: { ok: false, reason: "not-found" } };
      return { ok: false, result: { ok: false, reason: "io", detail: String(error) } };
    }
  }

  // Per-file write queue, keyed by realpath: `writeBlock` reads the current
  // mtime, decides ok/conflict, and writes, and two concurrent calls for the
  // same file must not both read the same stale mtime and both decide "ok" —
  // a lost update. Each call's own turn waits for the previous one *on that
  // file* to fully settle before it starts; unrelated files are never
  // blocked by each other. The map entry is removed once no call is
  // queued behind it, so it never grows for files no longer being written.
  const writeQueues = new Map<string, Promise<void>>();

  async function withWriteQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = writeQueues.get(key) ?? Promise.resolve();
    let releaseNext: () => void = () => {};
    const nextTurn = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    writeQueues.set(key, nextTurn);
    try {
      await prior.catch(() => {});
      return await fn();
    } finally {
      releaseNext();
      if (writeQueues.get(key) === nextTurn) writeQueues.delete(key);
    }
  }

  return {
    async list(cwd) {
      const bases = anthropicBases(agents(), home);
      const plansDirs = bases.map((base) => join(base, "plans"));
      const planMode = await listPlanMode(fs, plansDirs);

      if (cwd === undefined) return { session: undefined, planMode, repo: [] };

      const found = await findSessionEntry(fs, bases, cwd);
      let session: PlanEntry | undefined;
      if (found !== null) {
        session = { path: found.path, name: found.name, source: "session", mtimeMs: found.mtimeMs };
        const idx = planMode.findIndex((entry) => entry.path === found.path);
        if (idx !== -1) planMode.splice(idx, 1);
      }

      const repo = await listRepo(fs, cwd);
      return { session, planMode, repo };
    },

    async isAllowed(path) {
      return (await resolveAllowed(path)) !== null;
    },

    async read(path) {
      // Every I/O call below targets `real` (the guard's own resolved
      // path), never the caller's `path` again — the guard already proved
      // `real` is the file that was actually vetted, and re-deriving it
      // from `path` a second time (a second `realpath`/symlink traversal)
      // would just be a second TOCTOU window for no benefit. `path` itself
      // is used only for what the caller gets back.
      const real = await resolveAllowed(path);
      if (real === null) return { ok: false, reason: "forbidden" };

      let handle: Awaited<ReturnType<FsDeps["open"]>>;
      try {
        handle = await fs.open(real, "r");
      } catch (error) {
        if (isEnoent(error)) return { ok: false, reason: "not-found" };
        return { ok: false, reason: "io", detail: String(error) };
      }
      try {
        const info = await handle.stat();
        // Read at most one byte past the cap: enough to tell "too large"
        // apart from "exactly at the cap" without ever buffering a whole
        // oversized file just to reject it.
        const buffer = Buffer.alloc(MAX_PLAN_BYTES + 1);
        // A single `read()` call is not guaranteed to fill the buffer even
        // when the file has that many bytes left — a short read (an
        // interrupted syscall, a network filesystem, a pipe-like special
        // file) is legal and silently truncated the content here before
        // this loop existed. Keep reading at the current offset until
        // either the buffer is full (then the too-large check below fires)
        // or a read returns 0 bytes, which is the actual EOF.
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (result.bytesRead === 0) break;
          bytesRead += result.bytesRead;
        }
        if (bytesRead > MAX_PLAN_BYTES) return { ok: false, reason: "too-large" };
        const content = buffer.subarray(0, bytesRead).toString("utf8");
        return {
          ok: true,
          value: { path, mtimeMs: info.mtimeMs, blocks: parsePlan(content) },
        };
      } catch (error) {
        return { ok: false, reason: "io", detail: String(error) };
      } finally {
        await handle.close();
      }
    },

    async writeBlock(path, blockId, newSource, baseMtimeMs) {
      const real = await resolveAllowed(path);
      if (real === null) return { ok: false, reason: "forbidden" };

      // Everything past this point — the mtime check, the read, the write —
      // runs one call at a time per file, serialized on `real`. Without
      // this, two concurrent calls could both stat the same pre-write
      // mtime, both see it match their own `baseMtimeMs`, and both decide
      // "ok" — the second one's write silently discarding the first's.
      return withWriteQueue(real, async () => {
        const statted = await statOrReason(real);
        if (!statted.ok) return statted.result;
        if (statted.info.size > MAX_PLAN_BYTES) return { ok: false, reason: "too-large" };

        let content: string;
        try {
          content = await fs.readFile(real, "utf8");
        } catch (error) {
          return { ok: false, reason: "io", detail: String(error) };
        }
        const blocks = parsePlan(content);
        const doc: PlanDoc = { path, mtimeMs: statted.info.mtimeMs, blocks };

        if (statted.info.mtimeMs !== baseMtimeMs) return { ok: false, reason: "conflict", doc };

        const block = blocks.find((candidate) => candidate.id === blockId);
        if (block === undefined) return { ok: false, reason: "missing-block", doc };

        const updated = replaceBlock(content, block, newSource);
        if (Buffer.byteLength(updated, "utf8") > MAX_PLAN_BYTES) {
          return { ok: false, reason: "too-large" };
        }

        const dir = dirname(real);
        // A name unique per call (pid + random suffix), not just per file:
        // the in-process queue above already serializes calls from this
        // process, but a *second* process (another Jarvis window) writing
        // the same plan has no shared queue, and a shared temp name would
        // let one process's write clobber the other's mid-write. `wx`
        // additionally refuses to write through an existing file of that
        // exact name, rather than silently truncating it.
        const tempPath = join(
          dir,
          `.${basename(real)}.${process.pid}-${randomBytes(6).toString("hex")}.jarvis-tmp`,
        );
        try {
          // `mode` here is only a starting point: the OS filters file
          // creation through the process umask (a default 022 turns a
          // requested 0o664 into 0o644), so it does not reliably reproduce
          // the original file's mode on its own. The `chmod` right after
          // is what actually makes the temp file's mode match — umask
          // applies to creation, never to an explicit `chmod`.
          await fs.writeFile(tempPath, updated, {
            encoding: "utf8",
            flag: "wx",
            mode: statted.info.mode & 0o777,
          });
          await fs.chmod(tempPath, statted.info.mode & 0o777);
          await fs.rename(tempPath, real);
        } catch (error) {
          await fs.rm(tempPath, { force: true }).catch(() => {});
          return { ok: false, reason: "io", detail: String(error) };
        }

        const newStatted = await statOrReason(real);
        if (!newStatted.ok) return newStatted.result;
        return {
          ok: true,
          value: { path, mtimeMs: newStatted.info.mtimeMs, blocks: parsePlan(updated) },
        };
      });
    },

    watch(onChange, cwds) {
      let disposed = false;
      let loggedError = false;
      const timers = new Map<string, NodeJS.Timeout>();
      // Keyed by directory, so a later rescan can tell which directories
      // are already watched (leave alone) versus gone (close) versus new
      // (attach) — a plain array couldn't answer any of those.
      const activeWatchers = new Map<string, FSWatcher>();

      const logOnce = (message: string): void => {
        if (loggedError) return;
        loggedError = true;
        console.error(message);
      };

      const scheduleChange = (path: string): void => {
        const existing = timers.get(path);
        if (existing !== undefined) clearTimeout(existing);
        timers.set(
          path,
          setTimeout(() => {
            timers.delete(path);
            onChange(path);
          }, WATCH_DEBOUNCE_MS),
        );
      };

      const attach = (dir: string): void => {
        if (disposed || activeWatchers.has(dir)) return;
        let watcher: FSWatcher;
        try {
          watcher = watchDir(dir, (_event, filename) => {
            const name = filename?.toString() ?? "";
            if (!name.endsWith(".md")) return;
            scheduleChange(join(dir, name));
          });
        } catch {
          // `dirExists` already confirmed this directory is there, so a
          // throw here is a genuine race or permission problem, not the
          // ordinary "doesn't exist yet" case.
          logOnce(`[plans] failed to watch ${dir}`);
          return;
        }
        watcher.on("error", () => {
          logOnce(`[plans] watch error on ${dir}`);
          watcher.close();
          // Only remove the map entry if it's still *this* watcher: a
          // rescan could already have detached this one and attached a
          // fresh watcher for `dir` before this stale error arrives, and
          // that later watcher's entry must not be deleted out from under
          // it by an earlier one's error handler.
          if (activeWatchers.get(dir) === watcher) activeWatchers.delete(dir);
        });
        if (disposed) {
          watcher.close();
          return;
        }
        activeWatchers.set(dir, watcher);
      };

      const detach = (dir: string): void => {
        const watcher = activeWatchers.get(dir);
        if (watcher === undefined) return;
        watcher.close();
        activeWatchers.delete(dir);
      };

      const dirExists = async (dir: string): Promise<boolean> => {
        try {
          return (await fs.stat(dir)).isDirectory();
        } catch {
          return false;
        }
      };

      // Every plans dir, plus every existing `<cwd>/docs/superpowers/
      // {specs,plans}` for the *current* `cwds()` — re-read on every
      // reconcile, not just at setup, since the set of open projects and
      // the directories that exist under them both change over time.
      const reconcile = async (): Promise<void> => {
        if (disposed) return;
        const candidates = [
          ...plansDirsOf(agents(), home),
          ...cwds().flatMap((cwd) =>
            (["specs", "plans"] as const).map((kind) => join(cwd, "docs", "superpowers", kind)),
          ),
        ];
        const desired = new Set<string>();
        for (const dir of candidates) {
          if (await dirExists(dir)) desired.add(dir);
        }
        if (disposed) return;

        for (const dir of desired) attach(dir);
        for (const dir of [...activeWatchers.keys()]) {
          if (!desired.has(dir)) detach(dir);
        }
      };

      void reconcile();
      const rescan = setInterval(() => void reconcile(), WATCH_RESCAN_MS);

      return () => {
        disposed = true;
        clearInterval(rescan);
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        for (const watcher of activeWatchers.values()) watcher.close();
        activeWatchers.clear();
      };
    },
  };
}
