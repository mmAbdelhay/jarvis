import { basename, join, resolve, sep } from "node:path";
import type { AgentConfig, SessionStore } from "@jarvis/core";

/**
 * Imports the sessions Jarvis did not start.
 *
 * Every Claude Code session — however it was launched — writes a JSONL
 * transcript to `<configDir>/projects/<escaped-cwd>/<session-id>.jsonl`,
 * carrying every column the `sessions` table has. Jarvis records only the
 * sessions it spawned itself, which on the machine this was designed
 * against is 6 rows against 125 transcripts: the history feature describes
 * about 5% of the work it claims to be a history of.
 *
 * Nothing here has to *produce* that record. It already exists on disk, and
 * this file reads it.
 *
 * Shaped like headlamp.ts: pure helpers first, each pinned by its own test,
 * then a manager whose every piece of I/O arrives through an injected deps
 * object — so the importer is tested against a fake filesystem rather than
 * temp directories and real fs watches.
 */

/**
 * True when `child` is `parent` or lives under it.
 *
 * A separator-aware comparison rather than a bare `startsWith` on the raw
 * strings: `"/a/bc".startsWith("/a/b")` is true and they are unrelated
 * directories. Both the project match and the brain exclusion below depend
 * on getting this right, so it is one function with its own test.
 */
export function isWithin(child: string, parent: string): boolean {
  const a = resolve(child);
  const b = resolve(parent);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Every directory holding transcripts Jarvis knows how to read, with the
 * agent each belongs to.
 *
 * Anthropic-only in v1, and the boundary is here rather than inside the
 * parser: Copilot keeps its sessions in a different format under
 * `~/.copilot/session-state`, and building one importer to serve both
 * formats — with exactly one of them actually written — would be an
 * abstraction designed against a sample size of one. When a second vendor
 * is genuinely wanted, the shape of what varies will be known.
 *
 * An agent with no `configDir` contributes nothing: there is no directory
 * to look in.
 */
export function transcriptDirs(
  agents: readonly AgentConfig[],
): { agentId: string; dir: string }[] {
  return agents.flatMap((agent) =>
    agent.vendor === "anthropic" && agent.configDir !== undefined
      ? [{ agentId: agent.id, dir: join(agent.configDir, "projects") }]
      : [],
  );
}

/** What one transcript says about its session. Everything else a session
 *  row needs — which agent's directory it was found under, which project
 *  its cwd resolves to — is the importer's to supply. */
export type TranscriptSession = {
  id: string;
  /** Read from the `cwd` field, never from the escaped directory name. */
  cwd: string;
  model: string | null;
  branch: string;
  startedAt: number;
  lastActivityAt: number;
  summary: string;
};

/** How much of a first prompt is kept as the row's one-line summary. */
const SUMMARY_MAX = 200;

/**
 * A session row from the *head* of its transcript plus the file's mtime.
 *
 * Bounded by construction. Only the head is parsed, and the loop stops as
 * soon as it has everything it needs — at the first user prompt in
 * practice; `lastActivityAt` is the mtime rather than the last record's
 * timestamp, so nothing ever seeks to the end. A 40MB transcript costs what
 * a 4KB one costs.
 *
 * The escaped directory name in `path` (`-Users-u-projects-jarvis`) is
 * never parsed: a dash in it could be a path separator or a literal dash,
 * and there is no way to tell. `cwd` inside the file is unambiguous and is
 * the only source. `path` is used for exactly one thing — the file's own
 * name *is* the session id, which is precisely what `--session-id`
 * determines — as the fallback for records that carry no `sessionId`.
 *
 * Returns null when the file is not a session transcript Jarvis can record:
 *
 *  - a malformed or truncated record — the whole file is skipped, because a
 *    partially-parsed transcript would be a quietly wrong row, and one bad
 *    file must not cost the other 124;
 *  - no `cwd` anywhere in the head (an older CLI) — the one field with no
 *    fallback.
 *
 * Every field is `typeof`-checked before use: this is a file written by
 * another program, and the same reasoning applies as to a database row.
 */
export function sessionFromTranscript(
  head: string,
  path: string,
  mtime: number,
): TranscriptSession | null {
  const lines = head.split("\n");
  // A head read is cut mid-line by definition, so an unterminated final
  // line is a fragment rather than a malformed record.
  if (!head.endsWith("\n")) lines.pop();

  let id: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let timestamp: string | undefined;
  let model: string | undefined;
  let summary: string | undefined;

  for (const line of lines) {
    if (line.trim() === "") continue;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof record !== "object" || record === null) return null;
    const fields = record as Record<string, unknown>;

    id ??= stringField(fields, "sessionId");
    cwd ??= stringField(fields, "cwd");
    branch ??= stringField(fields, "gitBranch");
    timestamp ??= stringField(fields, "timestamp");

    const message = fields["message"];
    if (typeof message === "object" && message !== null) {
      const body = message as Record<string, unknown>;
      model ??= stringField(body, "model");
      // Never replaced once found: the *first* prompt is what a history row
      // is about, and it is also where the scan is allowed to stop.
      if (summary === undefined && fields["type"] === "user") {
        summary = promptText(body["content"]);
      }
    }

    if (
      id !== undefined &&
      cwd !== undefined &&
      branch !== undefined &&
      timestamp !== undefined &&
      model !== undefined &&
      summary !== undefined
    ) {
      break;
    }
  }

  if (cwd === undefined) return null;

  const startedAt = timestamp === undefined ? NaN : Date.parse(timestamp);

  return {
    id: id ?? basename(path, ".jsonl"),
    cwd,
    model: model ?? null,
    branch: branch ?? "",
    // A transcript whose first timestamp is unreadable still happened, and
    // the file's own mtime is the honest lower bound on when.
    startedAt: Number.isNaN(startedAt) ? mtime : startedAt,
    lastActivityAt: mtime,
    summary: summary ?? "",
  };
}

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The text of a user turn, or undefined when the turn carries none.
 *
 * A `content` array is not always a prompt: a tool result comes back
 * through the *user* role, and "ok" is not what a session was about. Only
 * text blocks count.
 */
function promptText(content: unknown): string | undefined {
  if (typeof content === "string") return trimSummary(content);
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const fields = block as Record<string, unknown>;
    if (fields["type"] !== "text") continue;
    const text = fields["text"];
    if (typeof text !== "string") continue;
    const trimmed = trimSummary(text);
    if (trimmed !== undefined) return trimmed;
  }
  return undefined;
}

/** One line, bounded: a history row shows a line, and a prompt can be an
 *  essay. Whitespace is collapsed so a multi-line prompt does not arrive as
 *  a row full of newlines. */
function trimSummary(text: string): string | undefined {
  const collapsed = text.replaceAll(/\s+/g, " ").trim();
  return collapsed === "" ? undefined : collapsed.slice(0, SUMMARY_MAX);
}

/**
 * The configured project a session's cwd belongs to, by longest path
 * prefix — or null when it belongs to none.
 *
 * Prefix rather than equality, on principle rather than on current
 * evidence, and the distinction is worth stating plainly: measured against
 * the 125 non-brain transcripts on the machine this was designed for,
 * prefix matching resolves exactly the same 30 sessions equality does. It
 * rescues nothing today. It is still right — a session started in
 * `acme/app` belongs to `acme` by any reasonable reading, and the
 * day one is started there equality would file it under nothing — and it
 * costs one comparison. Anyone tempted to simplify it back to equality
 * should know it was a deliberate choice made with the numbers in hand.
 *
 * Longest wins, so a cwd inside a nested configured project resolves to the
 * more specific one.
 *
 * Null is the dominant outcome — 95 of those 125 — and is a normal result,
 * not an error: most work happens in directories the user never declared,
 * and such a row still has projectPath, summary and resume.
 */
export function resolveProject(
  cwd: string,
  projects: Readonly<Record<string, string>>,
): string | null {
  let best: { name: string; length: number } | null = null;
  for (const [name, path] of Object.entries(projects)) {
    if (!isWithin(cwd, path)) continue;
    const length = resolve(path).length;
    if (best === null || length > best.length) best = { name, length };
  }
  return best === null ? null : best.name;
}

/** One transcript file, with the mtime that dates it. `lastActivityAt`
 *  comes from here rather than from the transcript's last record, which is
 *  what keeps the cost of a 40MB transcript equal to a 4KB one. */
export type TranscriptFile = { path: string; mtime: number };

export type ImportWatcher = { close(): void };

/**
 * Everything the importer touches that is not pure. All of it is injected,
 * the same way headlamp.ts injects its spawner and its context lister: the
 * tests then run against a fake filesystem, with no temp directories, no
 * real watches, and no dependence on what happens to be on the machine.
 */
export type SessionImporterDeps = {
  /** Every `*.jsonl` under one transcripts directory, with mtimes. A
   *  missing or unreadable directory yields [] rather than throwing —
   *  though a rejection is survived too. */
  listFiles: (dir: string) => Promise<TranscriptFile[]>;
  /** At most the first few KB of a file, as text. Never the whole file. */
  readHead: (path: string) => Promise<string>;
  /** Calls back with a transcript that changed. May throw: a watch that
   *  cannot be established costs the live updates, not the backfill. */
  watch: (dir: string, onChange: (file: TranscriptFile) => void) => ImportWatcher;
  now: () => number;
  store: SessionStore;
  /** The session ids SessionManager is currently running. Called per file
   *  rather than captured once: a session can start between two files, and
   *  the importer must never write live state for one of them. */
  ownedIds: () => ReadonlySet<string>;
  agents: readonly AgentConfig[];
  projects: Readonly<Record<string, string>>;
  /** Sessions at or under this path are the brain talking to itself. */
  brainCwd: string;
  importWindowDays: number;
  log?: (message: string) => void;
};

export type SessionImporter = {
  /** One bounded scan of every transcript directory. Resolves to the number
   *  of rows written. */
  backfill(): Promise<number>;
  /** backfill(), then watch each directory for later transcripts. Resolves
   *  to the backfilled count. */
  start(): Promise<number>;
  /** Closes every watcher — called on app quit. */
  stop(): void;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads transcripts into the sessions table, beside the SessionManager that
 * keeps writing the sessions Jarvis itself spawns.
 *
 * The two writers converge on one row per session rather than fighting,
 * because a Jarvis-spawned agent is launched with `--session-id` (pty.ts)
 * and so writes its transcript under the id SessionManager already minted.
 * Which of them owns which columns is the store's `upsertImported`
 * contract, decided here by `ownedIds()`.
 *
 * The scan is bounded three ways: by the import window (file mtime), by
 * reading only each file's head, and by looking only in the directories
 * `transcriptDirs` names. Nothing here polls.
 */
export function createSessionImporter(deps: SessionImporterDeps): SessionImporter {
  const dirs = transcriptDirs(deps.agents);
  const watchers: ImportWatcher[] = [];

  async function importFile(agentId: string, file: TranscriptFile): Promise<boolean> {
    // Cheapest check first, and it is also what keeps the importer from
    // reading the other things that live in these directories.
    if (!file.path.endsWith(".jsonl")) return false;

    let head: string;
    try {
      head = await deps.readHead(file.path);
    } catch {
      // A file listed a moment ago and gone now — a session cleaning up
      // after itself. Not an error worth a line in anyone's log.
      return false;
    }

    const transcript = sessionFromTranscript(head, file.path, file.mtime);
    if (transcript === null) return false;

    // By path, never by a directory name: the exclusion is "this is one of
    // the brain's own sessions", and a hardcoded name silently stops
    // working the day brain.cwd is configured elsewhere. Left in, the
    // brain's monologue outnumbers real sessions two to one and makes
    // history useless.
    if (isWithin(transcript.cwd, deps.brainCwd)) return false;

    const owned = deps.ownedIds().has(transcript.id);

    deps.store.upsertImported(
      {
        id: transcript.id,
        project: resolveProject(transcript.cwd, deps.projects),
        projectPath: transcript.cwd,
        agentId,
        ...(transcript.model === null ? {} : { model: transcript.model }),
        // Never "running". Jarvis cannot see whether a terminal session is
        // alive: Claude Code closes the transcript between writes (lsof
        // shows none held open while sessions run) and session-env
        // directories outlive their sessions, so all that is left is a
        // recency guess — and a guess does not belong in a column that
        // reads as fact. lastActivityAt already carries the recency, so the
        // UI can say "active 4 minutes ago" without Jarvis claiming to know
        // a state it cannot observe.
        state: "done",
        summary: transcript.summary,
        startedAt: transcript.startedAt,
        lastActivityAt: transcript.lastActivityAt,
        endedAt: transcript.lastActivityAt,
        branch: transcript.branch,
      },
      { owned },
    );
    return true;
  }

  async function backfill(): Promise<number> {
    const oldest = deps.now() - deps.importWindowDays * DAY_MS;
    let imported = 0;

    for (const { agentId, dir } of dirs) {
      let files: TranscriptFile[];
      try {
        files = await deps.listFiles(dir);
      } catch (error) {
        // An unreadable configDir means that agent contributes nothing —
        // never that the other agents' sessions are lost too.
        deps.log?.(`Session import: cannot read ${dir} (${message(error)})`);
        continue;
      }

      for (const file of files) {
        if (file.mtime < oldest) continue;
        if (await importFile(agentId, file)) imported += 1;
      }
    }

    return imported;
  }

  return {
    backfill,

    async start() {
      const imported = await backfill();

      for (const { agentId, dir } of dirs) {
        try {
          watchers.push(
            deps.watch(dir, (file) => {
              // Fire and forget: a watch callback has nobody to return a
              // promise to, and a transcript that fails to import is one
              // row missing until the next launch, not a crash.
              void importFile(agentId, file).catch((error) => {
                deps.log?.(`Session import: ${file.path} failed (${message(error)})`);
              });
            }),
          );
        } catch (error) {
          // Logged once, not thrown: what was backfilled is kept and the
          // importer degrades to it. A failed watch must not take down a
          // startup path.
          deps.log?.(`Session import: cannot watch ${dir} (${message(error)})`);
        }
      }

      return imported;
    },

    stop() {
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
