import type { GitProvider } from "../git/types.js";
import type { DirtyProject } from "./greeting.js";

/**
 * Reads every configured project's working tree once, at launch, to answer
 * the one question the dashboard cannot answer from session state: what did
 * the user leave uncommitted last time.
 *
 * ChangeTracker cannot supply this. It tracks the repositories of *live*
 * sessions, and at launch there are none — every session died with the
 * previous run.
 *
 * Failure is per-project on purpose. A path that is not a repo, or a git
 * call that times out, says nothing about the other projects, and taking the
 * whole greeting down over one of them is the failure P11 hardened
 * ChangeTracker against. The catch covers a provider that throws as well as
 * one that returns a failure: the contract says it resolves, but P15's house
 * rule is not to trust that at the call site when the cost of being wrong is
 * an unhandled rejection.
 */
export async function scanDirtyProjects(
  projects: Readonly<Record<string, string>>,
  git: GitProvider,
): Promise<DirtyProject[]> {
  const entries = Object.entries(projects);

  const scanned = await Promise.all(
    entries.map(async ([project, path]): Promise<DirtyProject | undefined> => {
      let changedFiles: number;
      try {
        const outcome = await git.changes(path);
        if (!outcome.ok) return undefined;
        changedFiles = outcome.value.files.length;
      } catch {
        return undefined;
      }
      // A project with nothing uncommitted is omitted rather than reported as
      // a zero: the line exists to name work waiting for the user, and a list
      // of zeroes buries the one project that has any.
      if (changedFiles === 0) return undefined;
      return { project, changedFiles };
    }),
  );

  return scanned.filter((entry): entry is DirtyProject => entry !== undefined);
}
