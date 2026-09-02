import { watch as watchDir } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
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
  if (typeof content === "string") return summaryOf(content);
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const fields = block as Record<string, unknown>;
    if (fields["type"] !== "text") continue;
    const text = fields["text"];
    if (typeof text !== "string") continue;
    const trimmed = summaryOf(text);
    if (trimmed !== undefined) return trimmed;
  }
  return undefined;
}

/**
 * A first prompt as a history row should show it.
 *
 * A slash command does not reach the transcript as the user typed it. The
 * CLI records its own markup —
 * `<command-name>/plan</command-name> <command-message>plan</command-message>
 * <command-args>…</command-args>` — and printed raw that fills the row with
 * tags instead of words. On this machine's real history it was 22 of 89
 * imported rows, so a quarter of the feature's output was unreadable.
 *
 * The command and its arguments are recovered as the line the user
 * effectively typed (`/plan add a cluster tab`). Any other markup is
 * stripped to its text rather than shown, because a tag in a summary is
 * never what the reader wants, and an unknown tag is not a reason to give
 * up on the words inside it.
 */
export function summaryOf(text: string): string | undefined {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text);
  if (name !== null) {
    const args = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/.exec(text);
    const argText = args?.[1]?.trim() ?? "";
    const command = name[1] ?? "";
    return trimSummary(argText === "" ? command : `${command} ${argText}`);
  }
  return trimSummary(text.replaceAll(/<[^>]*>/g, " "));
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
        // Where this row came from, so showing the session is a file read
        // rather than a scan of every agent directory for its id.
        transcriptPath: file.path,
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

/**
 * How much of a transcript is read. A head, never the file: this is the
 * whole reason a 40MB transcript costs what a 4KB one costs. 64KB is many
 * times the size of an opening exchange, and small enough that 125 of them
 * is nothing.
 */
export const HEAD_BYTES = 64 * 1024;

/**
 * A transcript as a session's terminal can show it.
 *
 * A session Jarvis spawned has a pty backlog; one started in a terminal has
 * only this file, so without a rendering the view opens blank — which is
 * exactly what it did before this existed.
 *
 * Only the conversation is kept. A transcript is mostly bookkeeping —
 * attachments, mode switches, cost state, file snapshots, 103 attachment
 * records against 50 user turns in the one measured here — and rendering
 * that would bury what the reader came for. Tool calls are named but their
 * arguments and results are dropped: a session's shape is which tools ran,
 * while their output is the terminal scrollback nobody kept.
 *
 * Lines end CRLF because this is written straight into an xterm, where a
 * bare LF moves down without returning to column zero and every line after
 * the first starts mid-screen.
 */
export function renderTranscript(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // One unreadable line is not a reason to lose the other thousand.
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const fields = record as Record<string, unknown>;
    const role = fields["type"];
    if (role !== "user" && role !== "assistant") continue;
    const message = fields["message"];
    if (typeof message !== "object" || message === null) continue;
    const body = transcriptBody((message as Record<string, unknown>)["content"]);
    if (body === "") continue;
    out.push(`${role === "user" ? "› " : ""}${body}`);
  }
  return out.length === 0 ? "" : `${out.join("\r\n\r\n")}\r\n`;
}

/** The readable part of one message's content. */
function transcriptBody(content: unknown): string {
  if (typeof content === "string") return content.replaceAll("\n", "\r\n").trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const fields = block as Record<string, unknown>;
    const kind = fields["type"];
    if (kind === "text") {
      const text = fields["text"];
      if (typeof text === "string" && text.trim() !== "") {
        parts.push(text.replaceAll("\n", "\r\n").trim());
      }
      continue;
    }
    if (kind === "tool_use") {
      const name = fields["name"];
      // The name, never the input: an Edit's input is a whole file and a
      // Bash's is a command whose output is not here anyway.
      parts.push(`[${typeof name === "string" ? name : "tool"}]`);
    }
    // thinking and tool_result are deliberately dropped — see the doc above.
  }
  return parts.join("\r\n");
}

/**
 * Whether a path relative to an agent's `projects/` directory is a session
 * transcript.
 *
 * Sessions live exactly one level down — `<escaped-cwd>/<session-id>.jsonl` —
 * and a recursive listing reaches further than that. Two levels deeper sit
 * the subagent transcripts, which carry their PARENT's `sessionId` and `cwd`:
 * import one and it upserts onto the parent's row, replacing the user's own
 * summary, start time and model with a subagent's. Seen on real data before
 * this guard existed — one session's summary became "You are implementing
 * Task 5 of a plan…", its startedAt an hour late and its model the
 * subagent's — and there were 810 such files against 369 real sessions, so
 * the wrong value won far more often than the right one.
 */
export function isSessionTranscriptEntry(entry: string): boolean {
  if (!entry.endsWith(".jsonl")) return false;
  return entry.split(sep).length === 2;
}

/**
 * The real filesystem behind `listFiles`, `readHead` and `watch`.
 *
 * Kept to the three functions and nothing else, so that what the importer's
 * own tests cannot cover is only the syscalls themselves. Every failure
 * here is "some directory on this machine is not what we expected", and
 * none of them is worth taking a startup path down over.
 */
export function createFsImportDeps(): Pick<
  SessionImporterDeps,
  "listFiles" | "readHead" | "watch"
> {
  return {
    async listFiles(dir) {
      let entries: string[];
      try {
        // Recursive because transcripts sit one level down, in a directory
        // per escaped cwd — a name this code never parses. Recursion goes
        // deeper than that, though, so isSessionTranscriptEntry keeps only
        // the one level that holds sessions.
        entries = await readdir(dir, { recursive: true });
      } catch {
        // A configDir that does not exist yet is the ordinary case for a
        // freshly configured agent, not an error: it contributes nothing.
        return [];
      }

      const files: TranscriptFile[] = [];
      for (const entry of entries) {
        if (!isSessionTranscriptEntry(entry)) continue;
        const path = join(dir, entry);
        try {
          const info = await stat(path);
          if (!info.isFile()) continue;
          files.push({ path, mtime: info.mtimeMs });
        } catch {
          // Listed a moment ago, gone now.
        }
      }
      return files;
    },

    async readHead(path) {
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    },

    watch(dir, onChange) {
      const watcher = watchDir(dir, { recursive: true }, (_event, filename) => {
        if (filename === null || !filename.toString().endsWith(".jsonl")) return;
        const path = join(dir, filename.toString());
        // The stat is what dates the change; a watch event carries no
        // mtime of its own, and mtime is where lastActivityAt comes from.
        void stat(path)
          .then((info) => {
            if (info.isFile()) onChange({ path, mtime: info.mtimeMs });
          })
          .catch(() => {
            // A transcript that vanished between the event and the stat.
          });
      });
      // An error on the watcher (the directory removed under it) must not
      // reach the process as an unhandled 'error' event.
      watcher.on("error", () => watcher.close());
      return { close: () => watcher.close() };
    },
  };
}
