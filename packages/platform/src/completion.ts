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

/** One thing the dropdown may offer. `value` is the *whole* replacement
 *  line, not a fragment: every consumer clears what is typed and writes
 *  this, so a history entry arrives with its arguments intact. */
export type Suggestion = { value: string; kind: "history" | "spec" | "path"; score: number };

/**
 * Frecency's half-life. Each occurrence of a command is worth one point
 * decayed by its age, so a fortnight-old run counts half of today's.
 *
 * A fortnight rather than a day: the frequency list this design was built
 * from is dominated by a handful of commands run across whole sprints, and
 * a half-life short enough to forget last week would rank by "what I did
 * this morning" instead of by what this user actually works on.
 */
const HALF_LIFE_SECONDS = 14 * 24 * 60 * 60;

/** An entry with no timestamp comes from a history written without
 *  EXTENDED_HISTORY. Scored as one half-life old — present, but never
 *  outranking something known to be recent. */
const UNDATED_AGE_SECONDS = HALF_LIFE_SECONDS;

/**
 * Directory affinity, applied multiplicatively to an occurrence that
 * happened in this directory.
 *
 * Deliberately large. `./scripts/port-forward-dev2.sh` and
 * `./docker-entrypoint.sh` are among the most-run commands on this machine
 * and belong to exactly one repo each; a boost small enough to be
 * outvoted by frequency elsewhere would leave them buried in the projects
 * where they mean nothing.
 */
const CWD_AFFINITY = 8;

/** A suggestion is written to the pty verbatim when accepted. A newline in
 *  one would submit a command the user never pressed Enter on, and an
 *  escape byte would let a history entry drive the terminal — so neither is
 *  ever offered, whatever the history holds. */
const UNSAFE_TO_OFFER = /[\u0000-\u001f\u007f]/;

function recencyWeight(at: number | undefined, now: number): number {
  const age = at === undefined ? UNDATED_AGE_SECONDS : Math.max(0, now - at);
  return 2 ** (-age / HALF_LIFE_SECONDS);
}

/**
 * History entries matching `input`, best first.
 *
 * The score is frecency — every run of a command contributes a
 * recency-decayed point — multiplied by the directory affinity for the runs
 * that happened here. Ties break on the shorter command, which is the one
 * with less to delete if it was not what was wanted.
 *
 * Matching is a case-insensitive prefix. Fuzzy matching is deliberately
 * absent: with eighty distinct commands, a prefix already narrows to a
 * handful, and fuzzy matching's cost is offering something that does not
 * look like what you typed.
 */
export function rank(
  input: string,
  entries: readonly HistoryEntry[],
  cwd: string,
  now: number,
): Suggestion[] {
  if (input.trim() === "") return [];
  const needle = input.toLowerCase();

  const scores = new Map<string, number>();
  for (const entry of entries) {
    const { command } = entry;
    if (command === input) continue;
    if (UNSAFE_TO_OFFER.test(command)) continue;
    if (!command.toLowerCase().startsWith(needle)) continue;
    const weight = recencyWeight(entry.at, now) * (entry.cwd === cwd ? CWD_AFFINITY : 1);
    scores.set(command, (scores.get(command) ?? 0) + weight);
  }

  return [...scores]
    .map(([value, score]) => ({ value, kind: "history" as const, score }))
    .sort((a, b) => b.score - a.score || a.value.length - b.value.length);
}
