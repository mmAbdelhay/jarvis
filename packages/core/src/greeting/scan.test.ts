import { describe, expect, it } from "vitest";
import type { GitChanges, GitFileChange, GitOutcome, GitProvider } from "../git/types.js";
import { scanDirtyProjects } from "./scan.js";

function file(overrides: Partial<GitFileChange> = {}): GitFileChange {
  return { path: "a.ts", status: "M", insertions: 1, deletions: 0, staged: false, ...overrides };
}

function changes(files: GitFileChange[]): GitChanges {
  return {
    repoPath: "/repo",
    branch: "master",
    detached: false,
    files,
    insertions: 0,
    deletions: 0,
  };
}

/**
 * Only `changes` is ever called by the scan, so the other four methods reject
 * loudly: if the scan ever reaches for one of them, that is a design change
 * the test should fail on rather than absorb.
 */
function gitWith(
  responses: Record<string, GitOutcome<GitChanges>>,
  calls: string[] = [],
): GitProvider {
  const unreachable = () => Promise.reject(new Error("not part of the scan"));
  return {
    changes: (repoPath) => {
      calls.push(repoPath);
      const outcome = responses[repoPath];
      if (outcome === undefined) throw new Error(`no fixture for ${repoPath}`);
      return Promise.resolve(outcome);
    },
    diff: unreachable,
    stage: unreachable,
    unstage: unreachable,
    commit: unreachable,
  };
}

describe("scanDirtyProjects", () => {
  it("reports one entry per project with changed files", async () => {
    const git = gitWith({
      "/p/acme": { ok: true, value: changes([file(), file({ path: "b.ts" })]) },
      "/p/storefront": { ok: true, value: changes([file()]) },
    });

    const dirty = await scanDirtyProjects({ acme: "/p/acme", storefront: "/p/storefront" }, git);

    expect(dirty).toEqual([
      { project: "acme", changedFiles: 2 },
      { project: "storefront", changedFiles: 1 },
    ]);
  });

  it("omits a project with no changes rather than reporting a zero", async () => {
    const git = gitWith({ "/p/clean": { ok: true, value: changes([]) } });

    expect(await scanDirtyProjects({ clean: "/p/clean" }, git)).toEqual([]);
  });

  // A path that is not a repo, or a git call that times out, is a fact about
  // that one project. Losing the whole greeting over it would be the same
  // failure P11 hardened ChangeTracker against.
  it("omits a project whose git read failed, keeping the others", async () => {
    const git = gitWith({
      "/p/broken": { ok: false, error: { code: "not-a-repo", detail: "/p/broken" } },
      "/p/live": { ok: true, value: changes([file()]) },
    });

    const dirty = await scanDirtyProjects({ broken: "/p/broken", live: "/p/live" }, git);

    expect(dirty).toEqual([{ project: "live", changedFiles: 1 }]);
  });

  it("survives a provider that throws instead of returning a failure", async () => {
    const git: GitProvider = {
      ...gitWith({}),
      changes: () => Promise.reject(new Error("boom")),
    };

    expect(await scanDirtyProjects({ any: "/p/any" }, git)).toEqual([]);
  });

  it("reads every project once", async () => {
    const calls: string[] = [];
    const git = gitWith(
      {
        "/p/a": { ok: true, value: changes([file()]) },
        "/p/b": { ok: true, value: changes([]) },
      },
      calls,
    );

    await scanDirtyProjects({ a: "/p/a", b: "/p/b" }, git);

    expect(calls).toEqual(["/p/a", "/p/b"]);
  });
});
