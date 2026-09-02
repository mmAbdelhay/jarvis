import { basename } from "node:path";

/**
 * What to call a session in the UI.
 *
 * `project` is null whenever the session's cwd matched no entry in
 * `projects:` — the *normal* case for a session started by typing an agent
 * into a terminal, not an error. Measured against the transcripts on the
 * machine this was designed for, 95 of 125 sessions resolve to no project
 * at all, so this fallback is the label most imported rows will carry.
 *
 * The directory's base name is what a user would themselves call that
 * directory. One function rather than a `?? basename(...)` at each of the
 * four call sites, so the rule is pinned by a test and changing it changes
 * every surface at once.
 */
export function sessionLabel(session: { project: string | null; projectPath: string }): string {
  if (session.project !== null && session.project !== "") return session.project;
  // basename("/") is "" — a path with no base name at all is its own best
  // description, and an empty label would render as a blank row.
  const base = basename(session.projectPath);
  return base === "" ? session.projectPath : base;
}
