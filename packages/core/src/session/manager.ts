import { randomUUID } from "node:crypto";
import type {
  ProcessHandle,
  Session,
  SessionOutput,
  SessionStore,
  Spawner,
  StartInput,
} from "./types.js";

/**
 * How much of each session's output is retained so the Session view can show
 * a backlog when it is opened partway through a run (and after the session
 * has already exited). A cap in characters rather than lines because a single
 * line has no bounded length — an agent printing one enormous JSON blob must
 * not be able to grow this without limit. 256 KiB is a few thousand lines of
 * ordinary CLI output: enough that opening a session mid-run shows real
 * context, small enough that a dozen long-lived sessions stay cheap.
 */
const MAX_LOG_CHARS = 256 * 1024;

export class SessionManager {
  readonly #spawn: Spawner;
  readonly #store: SessionStore | undefined;
  readonly #sessions = new Map<string, Session>();
  readonly #processes = new Map<string, ProcessHandle>();
  readonly #listeners = new Set<(sessions: Session[]) => void>();
  // Retained output per session, oldest chunk first, trimmed from the front
  // once the session's total passes MAX_LOG_CHARS. Kept after a session ends
  // on purpose: the most common reason to open a session's transcript is to
  // find out why it stopped.
  readonly #logs = new Map<string, string[]>();
  readonly #logSizes = new Map<string, number>();
  readonly #outputListeners = new Set<(output: SessionOutput) => void>();

  // `store` is optional so every existing `new SessionManager(spawner)`
  // call site (production and test) keeps working unchanged; passing one
  // wires session history persistence with no polling — every state
  // transition already flows through #persist below.
  constructor(spawn: Spawner, store?: SessionStore) {
    this.#spawn = spawn;
    this.#store = store;
  }

  start(input: StartInput): Session {
    const now = Date.now();
    const id = randomUUID();
    const session: Session = {
      id,
      project: input.project,
      projectPath: input.projectPath,
      agentId: input.agent.id,
      ...(input.agent.model === undefined ? {} : { model: input.agent.model }),
      state: "starting",
      summary: "",
      startedAt: now,
      lastActivityAt: now,
    };

    this.#sessions.set(id, session);

    let handle: ProcessHandle;
    try {
      handle = this.#spawn(input.agent, input.projectPath);
    } catch (error) {
      this.#sessions.delete(id);
      throw error;
    }
    this.#processes.set(id, handle);
    handle.onOutput((chunk) => this.#onOutput(id, chunk));
    handle.onExit((code) => this.#onExit(id, code));

    this.#persist(session);
    this.#emit();
    return session;
  }

  /**
   * Submits a line of text to a session, as if it had been typed and
   * entered. The terminator is a carriage return, not a newline: sessions
   * run under a pty, where CR is what the Enter key sends and what a line
   * editor waits for — an LF is passed through as ordinary whitespace and
   * the line simply sits there unsubmitted.
   */
  send(id: string, text: string): void {
    const handle = this.#processes.get(id);
    if (handle === undefined) throw new Error(`No session ${id}`);
    handle.write(`${text}\r`);
  }

  /**
   * Raw input, written to the process exactly as given — no trailing
   * newline, no translation. This is what a terminal's keystrokes travel
   * through (including control bytes: Ctrl-C, arrow keys, Escape), which
   * `send` above cannot express because it always appends a newline.
   * Unknown ids are ignored rather than throwing: keystrokes can be in
   * flight from the renderer at the instant a session exits, and losing a
   * race with a dead process is not an error worth surfacing to the user.
   */
  write(id: string, data: string): void {
    this.#processes.get(id)?.write(data);
  }

  /**
   * Tell one session's terminal its new size. Ignored for a session whose
   * process is not running under a pty (no `resize`) and for unknown ids —
   * the renderer resizes on every layout change, including ones that land
   * after a session has ended.
   */
  resize(id: string, cols: number, rows: number): void {
    this.#processes.get(id)?.resize?.(cols, rows);
  }

  kill(id: string): void {
    const handle = this.#processes.get(id);
    if (handle === undefined) throw new Error(`No session ${id}`);
    handle.kill();
    this.#update(id, { state: "dead" });
  }

  list(): Session[] {
    return [...this.#sessions.values()];
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  onChange(listener: (sessions: Session[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Live output, chunk by chunk, for every session at once — the subscriber
   * filters by `sessionId`. One stream rather than a per-session
   * subscription because the only consumer (the IPC layer) forwards
   * everything to a single renderer channel anyway, and a per-session
   * subscription would need its own teardown on every session exit.
   */
  onOutput(listener: (output: SessionOutput) => void): () => void {
    this.#outputListeners.add(listener);
    return () => this.#outputListeners.delete(listener);
  }

  /**
   * The retained transcript for one session, as a single string. An unknown
   * id (or a session that has produced no output yet) returns "" rather than
   * throwing: the Session view asks for this the moment a row is clicked,
   * which routinely happens before the agent has printed its first line.
   */
  log(id: string): string {
    return (this.#logs.get(id) ?? []).join("");
  }

  #onOutput(id: string, chunk: string): void {
    this.#appendLog(id, chunk);
    for (const listener of [...this.#outputListeners]) listener({ sessionId: id, chunk });
    const summary = lastNonEmptyLine(chunk);
    this.#update(id, {
      state: "running",
      ...(summary === undefined ? {} : { summary }),
    });
  }

  #appendLog(id: string, chunk: string): void {
    const chunks = this.#logs.get(id) ?? [];
    chunks.push(chunk);
    let size = (this.#logSizes.get(id) ?? 0) + chunk.length;
    // Drop whole chunks from the front until the retained total fits. The
    // last chunk is never dropped, so a single chunk larger than the cap is
    // truncated from its own front rather than vanishing entirely — losing
    // the newest output would defeat the point of the transcript.
    while (size > MAX_LOG_CHARS && chunks.length > 1) {
      size -= chunks.shift()?.length ?? 0;
    }
    if (size > MAX_LOG_CHARS) {
      const only = chunks[0] ?? "";
      chunks[0] = only.slice(only.length - MAX_LOG_CHARS);
      size = MAX_LOG_CHARS;
    }
    this.#logs.set(id, chunks);
    this.#logSizes.set(id, size);
  }

  #onExit(id: string, code: number): void {
    this.#update(id, { state: code === 0 ? "done" : "dead", exitCode: code });
  }

  #update(id: string, patch: Partial<Session>): void {
    const existing = this.#sessions.get(id);
    if (existing === undefined) return;
    if (existing.state === "dead" || existing.state === "done") return;
    const next: Session = { ...existing, ...patch, lastActivityAt: Date.now() };
    if ((next.state === "dead" || next.state === "done") && next.endedAt === undefined) {
      next.endedAt = next.lastActivityAt;
    }
    this.#sessions.set(id, next);
    this.#persist(next);
    this.#emit();
  }

  #persist(session: Session): void {
    this.#store?.upsert(session);
  }

  #emit(): void {
    const snapshot = this.list();
    for (const listener of [...this.#listeners]) listener(snapshot);
  }
}

/**
 * Matches ANSI escape sequences: CSI (colour, cursor moves, erases), OSC
 * (window title and other string commands, terminated by BEL or ST), and
 * the short two-character escapes. A pty-hosted agent draws its whole UI
 * out of these, so a summary taken from raw output would otherwise be a
 * row of cursor-positioning noise rather than words.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\-_])/g;

/**
 * The last line of output with anything to say, for the dashboard row's
 * one-line summary. Escape sequences are stripped first, and lines left
 * with nothing but box-drawing or whitespace are skipped: a terminal UI
 * redraws its frame constantly, and "│" is not a summary of anything.
 */
function lastNonEmptyLine(chunk: string): string | undefined {
  const lines = chunk
    .replace(ANSI_PATTERN, "")
    // A pty ends lines with CRLF, and a redraw uses bare CR to return to
    // the start of the line — both split here so neither shows up as a
    // stray character inside the summary.
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !isDecorationOnly(line));
  return lines.at(-1);
}

// Box-drawing, block and geometric-shape ranges, plus the spinner glyphs
// and bullets a CLI animates with. A line made only of these is chrome.
const DECORATION_ONLY = /^[\s\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2022\u00B7\u283F-\u28FF*=_.-]+$/;

function isDecorationOnly(line: string): boolean {
  return DECORATION_ONLY.test(line);
}
