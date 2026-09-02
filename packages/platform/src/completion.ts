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

/** What Jarvis knows about one generic command, by hand. */
export type CommandSpec = {
  command: string;
  subcommands: readonly string[];
  flags: readonly string[];
};

/**
 * The whole spec table — six commands, written out here.
 *
 * Fig's corpus is deliberately not vendored. It is hundreds of files that
 * must be kept current, and it would not contain `globex-dependabot`,
 * `saml2aws`, `./docker-entrypoint.sh` or `./scripts/port-forward-dev2.sh`
 * — four of the five most-run commands on this machine, and the ones a
 * completion engine is most worth having. History covers those; this table
 * only supplements the generic tools where knowing the flags genuinely
 * helps, and a command missing from it loses nothing that history had.
 *
 * The subcommands and flags are the ones that appear in this user's own
 * history, not the full surface of each tool: a list nobody uses is a list
 * that pushes the useful entry off the end of the dropdown.
 */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    command: "git",
    subcommands: [
      "add", "branch", "checkout", "cherry-pick", "commit", "diff", "fetch", "log", "merge",
      "pull", "push", "rebase", "reset", "restore", "stash", "status", "switch", "worktree",
    ],
    flags: ["--amend", "--force-with-lease", "--no-verify", "--staged", "-b"],
  },
  {
    command: "docker",
    subcommands: ["build", "compose", "exec", "images", "logs", "ps", "pull", "push", "run"],
    flags: ["--build", "--rm", "-d", "-f", "-it"],
  },
  {
    command: "npm",
    subcommands: ["ci", "install", "publish", "run", "test", "version"],
    flags: ["--legacy-peer-deps", "--save-dev", "--workspaces"],
  },
  {
    command: "pnpm",
    subcommands: ["add", "build", "dlx", "install", "remove", "run", "test", "typecheck"],
    flags: ["--filter", "--frozen-lockfile", "-r", "-w"],
  },
  {
    command: "gh",
    subcommands: ["auth", "issue", "pr", "release", "repo", "run", "workflow"],
    flags: ["--json", "--web"],
  },
  {
    command: "go",
    subcommands: ["build", "fmt", "get", "install", "mod", "run", "test", "vet"],
    flags: ["-race", "-v", "./..."],
  },
];

/** The whitespace-separated tokens of a line, plus whether the line ends in
 *  a space — which is the difference between "completing this token" and
 *  "starting the next one". */
function tokenize(input: string): { tokens: string[]; atNewToken: boolean } {
  const tokens = input.split(/\s+/).filter((token) => token !== "");
  return { tokens, atNewToken: input === "" || /\s$/.test(input) };
}

/**
 * Subcommands and flags for the command the line starts with.
 *
 * Only offers once the command name is complete and followed by a space:
 * `gi` is a prefix of `git` but not yet a command, and offering `git
 * status` there would be history's job, not this table's.
 *
 * Subcommands are offered only in the first argument position. `git commit
 * sta` is a path or a message fragment, not a second subcommand, and
 * suggesting one there would be noise on every commit.
 */
export function specSuggestions(input: string, specs: readonly CommandSpec[]): Suggestion[] {
  const { tokens, atNewToken } = tokenize(input);
  if (tokens.length === 0) return [];
  const spec = specs.find((candidate) => candidate.command === tokens[0]);
  if (spec === undefined) return [];
  if (tokens.length === 1 && !atNewToken) return [];

  const fragment = atNewToken ? "" : (tokens[tokens.length - 1] ?? "");
  const argumentIndex = atNewToken ? tokens.length : tokens.length - 1;

  const candidates = fragment.startsWith("-")
    ? spec.flags
    : argumentIndex === 1
      ? spec.subcommands
      : [];

  const head = input.slice(0, input.length - fragment.length);
  return candidates
    .filter((candidate) => candidate.startsWith(fragment) && candidate !== fragment)
    .sort()
    .map((candidate) => ({ value: `${head}${candidate}`, kind: "spec" as const, score: 0 }));
}

/**
 * The directory part of the last token, when that token looks like a path —
 * and undefined when it does not.
 *
 * This is what the caller needs *before* it can complete a path: it says
 * which single directory to list, so a keystroke costs one readdir of the
 * directory being typed rather than a walk of anything.
 *
 * "Looks like a path" means it contains a slash or starts with `~`. A bare
 * word is left alone: it is far more often a subcommand than a filename,
 * and history already completes it.
 */
export function pathPrefix(input: string): string | undefined {
  const { tokens, atNewToken } = tokenize(input);
  const token = atNewToken ? "" : (tokens[tokens.length - 1] ?? "");
  if (token === "") return undefined;
  if (!token.includes("/") && !token.startsWith("~")) return undefined;
  const cut = token.lastIndexOf("/");
  return cut < 0 ? undefined : token.slice(0, cut + 1);
}

/**
 * The last token completed against `listing` — the entries of the directory
 * `pathPrefix` named, with a trailing `/` on the directories.
 *
 * The listing is passed in rather than read: this stays pure, and the
 * caller is the only one that knows what "this terminal's cwd" means.
 */
export function completePath(input: string, listing: readonly string[]): Suggestion[] {
  const prefix = pathPrefix(input);
  if (prefix === undefined) return [];

  const { tokens } = tokenize(input);
  const token = tokens[tokens.length - 1] ?? "";
  const fragment = token.slice(prefix.length);
  const head = input.slice(0, input.length - token.length);

  return listing
    .filter((entry) => entry.toLowerCase().startsWith(fragment.toLowerCase()) && entry !== fragment)
    .sort()
    .map((entry) => ({ value: `${head}${prefix}${entry}`, kind: "path" as const, score: 0 }));
}

/** How many suggestions the dropdown may show. Eight is roughly a third of
 *  a terminal's height — enough to hold the answer, small enough that the
 *  list never becomes the screen. */
const DEFAULT_LIMIT = 8;

/**
 * The composed engine: history first, then specs, then paths.
 *
 * The order is the priority the design argues for. History is what this
 * user actually runs, arguments included; the spec table is a supplement
 * for the generic tools; paths complete what neither can know. A value
 * offered by an earlier source is not repeated by a later one, so the
 * sources degrade into each other rather than leaving a hole when one has
 * nothing to say.
 *
 * Blank input returns nothing, which is what keeps the dropdown shut at a
 * bare prompt.
 */
export function suggest(
  input: string,
  context: {
    history: readonly HistoryEntry[];
    specs: readonly CommandSpec[];
    listing: readonly string[];
    cwd: string;
    now: number;
    limit?: number;
  },
): Suggestion[] {
  if (input.trim() === "") return [];

  const all = [
    ...rank(input, context.history, context.cwd, context.now),
    ...specSuggestions(input, context.specs),
    ...completePath(input, context.listing),
  ];

  const seen = new Set<string>();
  const unique: Suggestion[] = [];
  for (const suggestion of all) {
    if (suggestion.value === input) continue;
    if (seen.has(suggestion.value)) continue;
    seen.add(suggestion.value);
    unique.push(suggestion);
  }
  return unique.slice(0, context.limit ?? DEFAULT_LIMIT);
}
