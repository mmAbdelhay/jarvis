import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  COMMAND_SPECS,
  parseCommandLog,
  pathPrefix,
  suggest,
  type CommandHistoryEntry,
} from "@jarvis/platform";

// The impure half of terminal autocomplete.
//
// completion.ts is pure by design and knows nothing about files; this is
// the layer that reads the history, reads Jarvis's command log, lists one
// directory, and hands the lot to suggest(). Everything it does is wrapped:
// a completion that cannot read a file returns fewer suggestions, never an
// error — the terminal it belongs to has to keep working.

export type CompletionSource = {
  /** The values to offer for `input` typed at a prompt in `cwd`. Each one
   *  is a whole replacement line. */
  suggest(cwd: string, input: string): Promise<string[]>;
  /** The most recent commands Jarvis's own log holds, newest first and
   *  deduplicated — what ↑/↓ in the command editor walk. Reading Jarvis's
   *  log rather than reaching into zsh's line editor is what keeps the line
   *  the DOM composed and the line zsh believes it is editing the same line. */
  history(limit: number): Promise<string[]>;
};

export type CompletionSourceDeps = {
  readHistory: () => Promise<string>;
  /** How to read the user's history file. zsh and bash write different
   *  formats, and the shell whose history file was named in config decides
   *  which — see parseZshHistory and parseBashHistory. Injected rather than
   *  chosen here so this stays the impure half and nothing more. */
  parseHistory: (text: string) => CommandHistoryEntry[];
  readCommandLog: () => Promise<string>;
  /** The entries of one directory, with a trailing `/` on the directories. */
  listDirectory: (path: string) => Promise<string[]>;
  /** Epoch milliseconds. */
  now: () => number;
  /** How long a parsed history may be reused. */
  cacheMs?: number;
};

/** A keystroke must not cost a re-read and re-parse of a history file with
 *  a thousand-odd entries in it. Five seconds is short enough that a
 *  command run in another terminal is offered almost immediately, and long
 *  enough that typing a word costs one read at most. */
const DEFAULT_CACHE_MS = 5_000;

/** Never rank against an unbounded file. A history that has grown to
 *  hundreds of thousands of lines would otherwise turn every keystroke
 *  into a full scan, and the entries that matter are the recent ones —
 *  which are at the end. */
const MAX_ENTRIES = 20_000;

export function createCompletionSource(deps: CompletionSourceDeps): CompletionSource {
  const cacheMs = deps.cacheMs ?? DEFAULT_CACHE_MS;
  let cached: CommandHistoryEntry[] | undefined;
  let cachedAt = 0;

  /** A read that failed contributes nothing rather than failing the whole
   *  suggestion: an unreadable history must still leave specs and paths. */
  async function readOr(read: () => Promise<string>): Promise<string> {
    try {
      return await read();
    } catch {
      return "";
    }
  }

  async function entries(): Promise<CommandHistoryEntry[]> {
    const at = deps.now();
    if (cached !== undefined && at - cachedAt < cacheMs) return cached;

    const [history, log] = await Promise.all([
      readOr(deps.readHistory),
      readOr(deps.readCommandLog),
    ]);
    // The log comes last so that, at equal score, the entry carrying a cwd
    // is the one whose spelling survives de-duplication.
    cached = [...deps.parseHistory(history), ...parseCommandLog(log)].slice(-MAX_ENTRIES);
    cachedAt = at;
    return cached;
  }

  async function listing(cwd: string, input: string): Promise<string[]> {
    const prefix = pathPrefix(input);
    // No path-shaped token means no directory read at all — the common case
    // for every keystroke of a subcommand.
    if (prefix === undefined) return [];
    try {
      return await deps.listDirectory(resolveDirectory(cwd, prefix));
    } catch {
      return [];
    }
  }

  return {
    async suggest(cwd, input) {
      if (input.trim() === "") return [];
      const [history, entriesInDirectory] = await Promise.all([entries(), listing(cwd, input)]);
      return suggest(input, {
        history,
        specs: COMMAND_SPECS,
        listing: entriesInDirectory,
        cwd,
        // The engine works in epoch seconds, as zsh's history does.
        now: Math.floor(deps.now() / 1000),
      }).map((suggestion) => suggestion.value);
    },

    async history(limit) {
      if (limit <= 0) return [];
      // Read fresh, past the suggestion cache: the command you just ran is
      // the one you are most likely to want back, and a five-second-old
      // snapshot would not have it yet. It costs one read per prompt.
      const log = await readOr(deps.readCommandLog);
      const entries = parseCommandLog(log);
      const seen = new Set<string>();
      const commands: string[] = [];
      for (let i = entries.length - 1; i >= 0 && commands.length < limit; i -= 1) {
        const command = entries[i]?.command;
        if (command === undefined || command === "" || seen.has(command)) continue;
        seen.add(command);
        commands.push(command);
      }
      return commands;
    },
  };
}

/** The directory a typed path prefix names, from the terminal's own cwd. */
function resolveDirectory(cwd: string, prefix: string): string {
  if (prefix.startsWith("~/")) return join(homedir(), prefix.slice(2));
  if (prefix === "~/") return homedir();
  return isAbsolute(prefix) ? resolve(prefix) : resolve(cwd, prefix);
}

/** Reads a file, or nothing at all. The caller treats an absent history the
 *  same as an empty one, which is the whole error handling this needs. */
export function createFileReader(path: string): () => Promise<string> {
  return async () => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  };
}

/**
 * One directory's entries, directories marked with a trailing slash so the
 * dropdown can offer `scripts/` and keep completing inside it.
 *
 * `withFileTypes` rather than a stat per entry: a directory of a few
 * hundred files is listed on a keystroke, and one syscall is the budget.
 */
export function createDirectoryLister(): (path: string) => Promise<string[]> {
  return async (path) => {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  };
}
