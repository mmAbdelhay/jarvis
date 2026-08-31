import { describe, expect, it, vi } from "vitest";
import { ChangeTracker } from "./tracker.js";
import type { GitChanges, GitOutcome, GitProvider } from "./types.js";
import type { Session } from "../session/types.js";

function session(id: string, project: string, projectPath: string): Session {
  return {
    id,
    project,
    projectPath,
    agentId: "claude-acme",
    state: "running",
    summary: "",
    startedAt: 0,
    lastActivityAt: 0,
  };
}

function changesFor(repoPath: string, files: number): GitChanges {
  return {
    repoPath,
    branch: "main",
    detached: false,
    files: Array.from({ length: files }, (_unused, index) => ({
      path: `file-${index}.txt`,
      status: "M" as const,
      insertions: 2,
      deletions: 1,
      staged: false,
    })),
    insertions: files * 2,
    deletions: files,
  };
}

function fakeGit(
  handler: (repoPath: string) => GitOutcome<GitChanges>,
): GitProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    changes: async (repoPath) => {
      calls.push(repoPath);
      return handler(repoPath);
    },
    diff: async () => ({ ok: false, error: { code: "failed", detail: "unused" } }),
    stage: async () => ({ ok: true, value: null }),
    unstage: async () => ({ ok: true, value: null }),
    commit: async () => ({ ok: false, error: { code: "failed", detail: "unused" } }),
  };
}

describe("ChangeTracker", () => {
  it("starts empty and reads no repository until refreshed", () => {
    const git = fakeGit((repoPath) => ({ ok: true, value: changesFor(repoPath, 1) }));
    const tracker = new ChangeTracker({ git, sessions: { list: () => [session("a", "p", "/p")] } });

    expect(tracker.snapshot()).toEqual([]);
    expect(git.calls).toEqual([]);
  });

  it("reports counts per session after a refresh", async () => {
    const git = fakeGit((repoPath) => ({ ok: true, value: changesFor(repoPath, 3) }));
    const tracker = new ChangeTracker({
      git,
      sessions: { list: () => [session("a", "acme", "/projects/acme")] },
    });

    await tracker.refresh();

    expect(tracker.snapshot()).toEqual([
      {
        sessionId: "a",
        project: "acme",
        repoPath: "/projects/acme",
        branch: "main",
        detached: false,
        files: 3,
        insertions: 6,
        deletions: 3,
      },
    ]);
  });

  it("reads each repository once even when two sessions share it", async () => {
    const git = fakeGit((repoPath) => ({ ok: true, value: changesFor(repoPath, 1) }));
    const tracker = new ChangeTracker({
      git,
      sessions: { list: () => [session("a", "p", "/p"), session("b", "p", "/p")] },
    });

    await tracker.refresh();

    expect(git.calls).toEqual(["/p"]);
    expect(tracker.snapshot().map((entry) => entry.sessionId)).toEqual(["a", "b"]);
  });

  // Pins: one session's provider failure alongside another's success must
  // not lose the other session's counts (Phase 1 Task 4's Promise.all bug).
  it("drops a session whose repository cannot be read, and keeps the others", async () => {
    const git = fakeGit((repoPath) =>
      repoPath === "/bad"
        ? { ok: false, error: { code: "not-a-repo", detail: repoPath } }
        : { ok: true, value: changesFor(repoPath, 1) },
    );
    const tracker = new ChangeTracker({
      git,
      sessions: { list: () => [session("a", "good", "/good"), session("b", "bad", "/bad")] },
    });

    await tracker.refresh();

    expect(tracker.snapshot().map((entry) => entry.sessionId)).toEqual(["a"]);
  });

  // Pins: a provider that *throws* instead of returning a GitOutcome (never
  // observed from the real provider, but not something Promise.all can be
  // trusted to tolerate) must degrade only that repo's entry, not reject
  // the whole refresh and lose every other session's counts (Phase 1's
  // Promise.all bug, again — this time at a package boundary).
  it("survives a repository whose provider throws instead of returning an outcome", async () => {
    const git: GitProvider = {
      changes: async (repoPath) => {
        if (repoPath === "/bad") throw new Error("boom");
        return { ok: true, value: changesFor(repoPath, 1) };
      },
      diff: async () => ({ ok: false, error: { code: "failed", detail: "unused" } }),
      stage: async () => ({ ok: true, value: null }),
      unstage: async () => ({ ok: true, value: null }),
      commit: async () => ({ ok: false, error: { code: "failed", detail: "unused" } }),
    };
    const tracker = new ChangeTracker({
      git,
      sessions: { list: () => [session("a", "good", "/good"), session("b", "bad", "/bad")] },
    });

    await tracker.refresh();

    expect(tracker.snapshot()).toEqual([
      {
        sessionId: "a",
        project: "good",
        repoPath: "/good",
        branch: "main",
        detached: false,
        files: 1,
        insertions: 2,
        deletions: 1,
      },
    ]);
  });

  it("notifies subscribers with the new snapshot", async () => {
    const git = fakeGit((repoPath) => ({ ok: true, value: changesFor(repoPath, 2) }));
    const tracker = new ChangeTracker({ git, sessions: { list: () => [session("a", "p", "/p")] } });
    const seen = vi.fn();
    tracker.onChange(seen);

    await tracker.refresh();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]?.[0]).toEqual(tracker.snapshot());
  });

  it("isolates a throwing subscriber from the others", async () => {
    const git = fakeGit((repoPath) => ({ ok: true, value: changesFor(repoPath, 1) }));
    const tracker = new ChangeTracker({ git, sessions: { list: () => [session("a", "p", "/p")] } });
    const good = vi.fn();
    tracker.onChange(() => {
      throw new Error("subscriber blew up");
    });
    tracker.onChange(good);

    await tracker.refresh();

    expect(good).toHaveBeenCalledTimes(1);
  });

  // Pins: overlapping refreshes (a timer firing while an explicit call is
  // still in flight, or vice versa) must not interleave reads or let an
  // older snapshot land after a newer one.
  it("does not start a second read while one is in flight", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const git: GitProvider = {
      changes: async (repoPath) => {
        calls.push(repoPath);
        await gate;
        return { ok: true, value: changesFor(repoPath, 1) };
      },
      diff: async () => ({ ok: false, error: { code: "failed", detail: "unused" } }),
      stage: async () => ({ ok: true, value: null }),
      unstage: async () => ({ ok: true, value: null }),
      commit: async () => ({ ok: false, error: { code: "failed", detail: "unused" } }),
    };
    const tracker = new ChangeTracker({ git, sessions: { list: () => [session("a", "p", "/p")] } });

    const first = tracker.refresh();
    const second = tracker.refresh();
    release();
    await Promise.all([first, second]);

    expect(calls).toEqual(["/p"]);
  });

  it("forgets a repository that has gone away", async () => {
    let sessions = [session("a", "p", "/p")];
    const git = fakeGit((repoPath) => ({ ok: true, value: changesFor(repoPath, 1) }));
    const tracker = new ChangeTracker({ git, sessions: { list: () => sessions } });

    await tracker.refresh();
    expect(tracker.snapshot()).toHaveLength(1);

    sessions = [];
    await tracker.refresh();
    expect(tracker.snapshot()).toEqual([]);
  });

  // Pins: a session ending while its own refresh is still in flight must
  // not resurrect it in the snapshot once the read completes — snapshot()
  // always filters against the *live* session list, not the list refresh()
  // captured when it started.
  it("drops a session that ended while its repository read was in flight", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sessions = [session("a", "p", "/p")];
    const git: GitProvider = {
      changes: async (repoPath) => {
        await gate;
        return { ok: true, value: changesFor(repoPath, 1) };
      },
      diff: async () => ({ ok: false, error: { code: "failed", detail: "unused" } }),
      stage: async () => ({ ok: true, value: null }),
      unstage: async () => ({ ok: true, value: null }),
      commit: async () => ({ ok: false, error: { code: "failed", detail: "unused" } }),
    };
    const tracker = new ChangeTracker({ git, sessions: { list: () => sessions } });

    const refreshing = tracker.refresh();
    // The session ends (e.g. SessionManager.kill) before the git read
    // resolves.
    sessions = [];
    release();
    await refreshing;

    expect(tracker.snapshot()).toEqual([]);
  });

  // Pins: a listener that unsubscribes (itself or another listener) while
  // #emit is iterating must not corrupt that iteration or skip a remaining
  // listener — #emit iterates a copy of the set, same as SessionManager.
  // Controller ruling P28: SessionManager never removes an ended session
  // from its list (only its state changes), so without this the snapshot
  // would keep rejoining a finished session against its repo's *current*
  // git state on every refresh — main.ts's persistence writer would then
  // rewrite that session's history row forever, including work from
  // sessions that started after it ended.
  it("freezes a session's entry once it reaches a terminal state, even though it stays in the session list", async () => {
    const git = fakeGit((repoPath) => ({ ok: true, value: changesFor(repoPath, 3) }));
    const ended: Session = { ...session("a", "p", "/p"), state: "done", endedAt: 100 };
    const tracker = new ChangeTracker({ git, sessions: { list: () => [ended] } });

    await tracker.refresh();

    expect(tracker.snapshot()).toEqual([]);
  });

  it("keeps a live session's entry while a different, ended session sharing its repo is dropped", async () => {
    const git = fakeGit((repoPath) => ({ ok: true, value: changesFor(repoPath, 3) }));
    const ended: Session = { ...session("a", "p", "/p"), state: "done", endedAt: 100 };
    const live = session("b", "p", "/p");
    const tracker = new ChangeTracker({ git, sessions: { list: () => [ended, live] } });

    await tracker.refresh();

    expect(tracker.snapshot().map((entry) => entry.sessionId)).toEqual(["b"]);
  });

  it("delivers to every listener even when one unsubscribes another during the emit", async () => {
    const git = fakeGit((repoPath) => ({ ok: true, value: changesFor(repoPath, 1) }));
    const tracker = new ChangeTracker({ git, sessions: { list: () => [session("a", "p", "/p")] } });
    const untouched = vi.fn();
    const late = vi.fn();

    let unsubscribeLate = (): void => {};
    tracker.onChange(() => {
      unsubscribeLate();
    });
    tracker.onChange(untouched);
    unsubscribeLate = tracker.onChange(late);

    await tracker.refresh();

    expect(untouched).toHaveBeenCalledTimes(1);
    // `late` was still subscribed when this emit's iteration snapshot was
    // taken, so it is still delivered to for this call even though another
    // listener unsubscribed it mid-emit.
    expect(late).toHaveBeenCalledTimes(1);

    await tracker.refresh();

    // But the unsubscribe took effect for the *next* emit.
    expect(late).toHaveBeenCalledTimes(1);
    expect(untouched).toHaveBeenCalledTimes(2);
  });
});
