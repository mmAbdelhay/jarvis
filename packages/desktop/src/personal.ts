/**
 * The personal browser: a reserved pseudo-project that the Workspace offers
 * beside the configured ones, for tabs that are nobody's work.
 *
 * Modelled as a project rather than as a second tab system because every
 * part of the Workspace already keys off a project string — the tab store,
 * the session partition, the bookmark file, the tab strip's grouping and
 * colouring, the "which project is selected" switch. A parallel system would
 * have had to reimplement all of it; a reserved key gets it for free, and
 * the only new rule is the one below.
 *
 * The rule: this key is deliberately absent from `config.projects`, which is
 * what "a project" means to the rest of the app. Everything that needs a
 * directory on disk — the Editor, Database, Terminal and API tabs, git
 * polling, the Changes view, session routing — looks the project up in that
 * map and refuses what it does not find, so the personal browser is excluded
 * from all of them without any of them being told about it. config.ts
 * reserves the name so a jarvis.yaml can never smuggle it back in.
 *
 * Session isolation: BrowserHost derives a partition from the project name,
 * so this gets `persist:project-__personal__` — its own cookie jar, its own
 * logins, shared with nothing. That is the deliberate choice: a personal
 * browser holds the user's own signed-in accounts, and a page opened by a
 * work project must not be able to ride them. It costs a second login where
 * the same site is used for both, which is the right trade.
 */
export const PERSONAL_PROJECT = "__personal__";

export function isPersonalProject(project: string): boolean {
  return project === PERSONAL_PROJECT;
}
