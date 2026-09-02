// The completion engine.
//
// Everything here is pure: no file reads, no directory listings, no clock.
// The history text, the directory listing, the cwd and the current time are
// all handed in, which is what makes the whole of the ranking and matching
// testable without a shell, a pty or a home directory — the shape
// headlamp.ts established.

/**
 * One command the user has run. `at` is epoch *seconds*, as zsh writes them.
 *
 * `cwd` is where it ran, and zsh's own history does not record it — only
 * Jarvis's command log does (see parseCommandLog). An entry without one is
 * ordinary, not broken: it simply misses the directory-affinity boost.
 */
export type HistoryEntry = { command: string; at?: number; cwd?: string };

/** `: <epoch>:<elapsed>;<command>` — zsh's EXTENDED_HISTORY line. */
const EXTENDED_LINE = /^: (\d+):\d+;([\s\S]*)$/;

/**
 * zsh history text to entries.
 *
 * Two formats, because a history file holds both: EXTENDED_HISTORY writes
 * the timestamped form, and a file written before the option was set (or by
 * a shell that had it off) holds bare command lines. A line matching
 * neither is kept as a bare command rather than dropped — it is far more
 * likely to be a command containing something surprising than a corrupt
 * record, and an odd suggestion costs less than a missing one.
 *
 * A command spanning lines is written by zsh with a trailing backslash on
 * every line but the last, and is rejoined here into the one entry it is.
 * Such an entry keeps its newlines and is filtered out later by rank(),
 * which will not offer a suggestion that would submit itself.
 */
export function parseZshHistory(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  let continued: string | undefined;

  for (const raw of text.split("\n")) {
    const line = continued === undefined ? raw : `${continued}\n${raw}`;
    if (line.endsWith("\\")) {
      continued = line.slice(0, -1);
      continue;
    }
    continued = undefined;
    if (line === "") continue;

    const match = EXTENDED_LINE.exec(line);
    if (match === null) {
      entries.push({ command: line });
      continue;
    }
    const command = match[2] ?? "";
    if (command === "") continue;
    entries.push({ command, at: Number(match[1]) });
  }

  // A file whose last line was left mid-continuation still yields it.
  if (continued !== undefined && continued !== "") entries.push({ command: continued });
  return entries;
}

/**
 * Jarvis's own command log — `<epoch>\t<cwd>\t<command>`, one line per
 * command, appended by the preexec hook the ZDOTDIR wrapper installs.
 *
 * It exists for exactly one reason: directory affinity. zsh's history
 * records no working directory, so without this there is no way to know
 * that `./scripts/port-forward-dev2.sh` belongs to one repo and is noise in
 * every other. The log is Jarvis's, written beside the user's history and
 * never into it.
 *
 * Only the first two tabs separate fields: a command may contain tabs of
 * its own, and splitting on all of them would corrupt it.
 */
export function parseCommandLog(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const firstTab = line.indexOf("\t");
    if (firstTab < 0) continue;
    const secondTab = line.indexOf("\t", firstTab + 1);
    if (secondTab < 0) continue;

    const at = Number(line.slice(0, firstTab));
    if (!Number.isFinite(at)) continue;
    const cwd = line.slice(firstTab + 1, secondTab);
    const command = line.slice(secondTab + 1);
    if (command === "") continue;
    entries.push({ command, at, cwd });
  }
  return entries;
}
