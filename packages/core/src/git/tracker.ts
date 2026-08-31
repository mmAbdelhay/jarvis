import type { Session } from "../session/types.js";
import type { GitChanges, GitProvider } from "./types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type SessionChanges = {
  sessionId: string;
  project: string;
  repoPath: string;
  branch: string;
  detached: boolean;
  files: number;
  insertions: number;
  deletions: number;
};

export type ChangeTrackerOptions = {
  git: GitProvider;
  // Structural, not the SessionManager class: the tracker needs exactly one
  // method, and depending on the whole manager would make it untestable
  // without spawning processes.
  sessions: { list(): Session[] };
};

export class ChangeTracker {
  readonly #options: ChangeTrackerOptions;
  readonly #byRepo = new Map<string, GitChanges>();
  readonly #listeners = new Set<(changes: SessionChanges[]) => void>();
  #refreshing = false;

  constructor(options: ChangeTrackerOptions) {
    this.#options = options;
  }

  /** Synchronous by design: the orchestrator's per-turn context and the
   *  renderer's session rows both need these numbers without awaiting git.
   *  Reads the live session list every call, so a session that has since
   *  ended (or never existed) never appears here even if its repo is still
   *  cached from a stale refresh. */
  snapshot(): SessionChanges[] {
    const result: SessionChanges[] = [];
    for (const session of this.#options.sessions.list()) {
      // Controller ruling P28: once a session reaches a terminal state
      // (`done`/`dead`, signalled by `endedAt`), its entry here freezes —
      // it stops appearing in this snapshot at all, forever, even though
      // SessionManager keeps the session in its list. Without this, a
      // session that ended is still joined against its `projectPath`'s
      // *current* git state on every refresh (`#byRepo` is keyed by repo,
      // not by session), and main.ts's persistence writer — the only
      // consumer of this snapshot's non-live path — rewrites that session's
      // history row with the repository's live state every ~5s forever,
      // including work from sessions that started long after this one
      // ended. A frozen session's last honest counts are whatever
      // SessionStore already recorded for it before it ended; nothing here
      // may overwrite that again.
      if (session.endedAt !== undefined) continue;
      const changes = this.#byRepo.get(session.projectPath);
      if (changes === undefined) continue;
      result.push({
        sessionId: session.id,
        project: session.project,
        repoPath: session.projectPath,
        branch: changes.branch,
        detached: changes.detached,
        files: changes.files.length,
        insertions: changes.insertions,
        deletions: changes.deletions,
      });
    }
    return result;
  }

  async refresh(): Promise<void> {
    // Phase 1 shipped an unguarded setInterval metrics read that could
    // deliver samples out of order under load (deferred minor, R30). Git is
    // slower than a metrics read, so the guard is here from the start: a
    // refresh already in flight makes any concurrent call a no-op rather
    // than letting two reads interleave or an older one land last.
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      const repoPaths = [
        ...new Set(this.#options.sessions.list().map((session) => session.projectPath)),
      ];

      // Each repo's read is caught individually rather than trusting
      // GitProvider's contract never to throw. The real provider
      // (platform/git.ts) never does today, but Promise.all rejects the
      // whole aggregation the instant any one of its promises rejects —
      // Phase 1 already paid for exactly this: a non-Error rejection from
      // one agent's health check took down every agent's health status.
      // Catching here makes one repo's unexpected throw degrade only that
      // repo's entry, never the whole snapshot.
      const results = await Promise.all(
        repoPaths.map(async (repoPath) => {
          try {
            return { repoPath, outcome: await this.#options.git.changes(repoPath) };
          } catch (error) {
            return {
              repoPath,
              outcome: {
                ok: false as const,
                error: { code: "failed" as const, detail: errorMessage(error) },
              },
            };
          }
        }),
      );

      this.#byRepo.clear();
      for (const { repoPath, outcome } of results) {
        // A repository that cannot be read simply has no counts. The spec
        // requires a git problem never to block the assistant, and the
        // Changes view reports the failure in detail when it is opened.
        if (outcome.ok) this.#byRepo.set(repoPath, outcome.value);
      }
    } finally {
      this.#refreshing = false;
    }

    this.#emit();
  }

  onChange(listener: (changes: SessionChanges[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    const snapshot = this.snapshot();
    // Iterate a copy, same as SessionManager#emit: a listener added or
    // removed (by itself or another listener) during this emit must not
    // corrupt or extend the iteration in progress.
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Same isolation rule SessionManager and Orchestrator already apply:
        // one throwing subscriber must not starve the others.
      }
    }
  }
}
