import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "./manager.js";
import type { ProcessHandle, Session, SessionStore, Spawner } from "./types.js";
import type { AgentConfig } from "../registry/types.js";

class FakeStore implements SessionStore {
  rows = new Map<string, Session>();
  upsert(session: Session): void {
    this.rows.set(session.id, session);
  }
  // SessionManager never calls this — the transcript importer does — but a
  // fake that only implements the parts the caller happens to use stops
  // being a stand-in for the real store.
  imported: { session: Session; owned: boolean }[] = [];
  upsertImported(session: Session, options: { owned: boolean }): void {
    this.imported.push({ session, owned: options.owned });
    if (options.owned) return;
    this.rows.set(session.id, session);
  }
  history(): Session[] {
    return [...this.rows.values()];
  }
  updateGit(
    sessionId: string,
    git: { branch: string; insertions: number; deletions: number; changedFiles: number },
  ): void {
    const existing = this.rows.get(sessionId);
    if (existing === undefined) return;
    this.rows.set(sessionId, { ...existing, ...git });
  }
}

const agent: AgentConfig = { id: "claude-mm", command: "claude-mm", model: "opus" };

class FakeProcess implements ProcessHandle {
  written: string[] = [];
  killed = false;
  resizes: { cols: number; rows: number }[] = [];
  #output: ((chunk: string) => void)[] = [];
  #exit: ((code: number) => void)[] = [];

  write(data: string): void { this.written.push(data); }
  kill(): void { this.killed = true; }
  resize(cols: number, rows: number): void { this.resizes.push({ cols, rows }); }
  onOutput(listener: (chunk: string) => void): void { this.#output.push(listener); }
  onExit(listener: (code: number) => void): void { this.#exit.push(listener); }

  emitOutput(chunk: string): void { for (const l of this.#output) l(chunk); }
  emitExit(code: number): void { for (const l of this.#exit) l(code); }
}

describe("SessionManager", () => {
  let fake: FakeProcess;
  let spawner: Spawner;

  beforeEach(() => {
    fake = new FakeProcess();
    spawner = () => fake;
  });

  it("starts a session in the starting state", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({ project: "acme", projectPath: "/p/acme", agent });
    expect(session.state).toBe("starting");
    expect(session.project).toBe("acme");
    expect(session.agentId).toBe("claude-mm");
    expect(session.model).toBe("opus");
  });

  // The id has to reach the CLI (as --session-id) so that the transcript
  // the session writes lands under the id Jarvis already minted. Without
  // it the importer sees the same conversation as two sessions under two
  // ids, with no way to tell they are one.
  it("hands the spawner the session id it minted", () => {
    const seen: (string | undefined)[] = [];
    const manager = new SessionManager((_agent, _projectPath, sessionId) => {
      seen.push(sessionId);
      return fake;
    });

    const session = manager.start({ project: "acme", projectPath: "/p/acme", agent });

    expect(seen).toEqual([session.id]);
  });

  it("gives each session a distinct id", () => {
    const manager = new SessionManager(spawner);
    const a = manager.start({ project: "a", projectPath: "/a", agent });
    const b = manager.start({ project: "b", projectPath: "/b", agent });
    expect(a.id).not.toBe(b.id);
    expect(manager.list()).toHaveLength(2);
  });

  it("moves to running and records a summary on first output", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({ project: "acme", projectPath: "/p", agent });
    fake.emitOutput("Running tests\n");
    expect(manager.get(session.id)?.state).toBe("running");
    expect(manager.get(session.id)?.summary).toBe("Running tests");
  });

  it("keeps the last non-empty line as the summary", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({ project: "p", projectPath: "/p", agent });
    fake.emitOutput("first line\nsecond line\n\n");
    expect(manager.get(session.id)?.summary).toBe("second line");
  });

  it("marks the session dead when the process exits non-zero", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({ project: "p", projectPath: "/p", agent });
    fake.emitExit(1);
    expect(manager.get(session.id)?.state).toBe("dead");
  });

  it("marks the session done when the process exits zero", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({ project: "p", projectPath: "/p", agent });
    fake.emitExit(0);
    expect(manager.get(session.id)?.state).toBe("done");
  });

  it("writes text to the process on send", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({ project: "p", projectPath: "/p", agent });
    manager.send(session.id, "run the tests");
    // CR, not LF: sessions run under a pty, where the Enter key sends a
    // carriage return and an LF leaves the line unsubmitted.
    expect(fake.written).toEqual(["run the tests\r"]);
  });

  it("throws when sending to an unknown session", () => {
    const manager = new SessionManager(spawner);
    expect(() => manager.send("missing", "hi")).toThrow(/missing/);
  });

  it("kills the process and marks the session dead", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({ project: "p", projectPath: "/p", agent });
    manager.kill(session.id);
    expect(fake.killed).toBe(true);
    expect(manager.get(session.id)?.state).toBe("dead");
  });

  it("stays dead when the killed process's own exit event arrives afterward", () => {
    // A real child process (Task 6's spawner) reports `code: null` on a
    // SIGTERM-killed process, which collapses to exit code 0 via `code ?? 0`.
    // kill() must not be undone by that later "successful" exit.
    const manager = new SessionManager(spawner);
    const session = manager.start({ project: "p", projectPath: "/p", agent });
    manager.kill(session.id);
    fake.emitExit(0);
    expect(manager.get(session.id)?.state).toBe("dead");
  });

  it("stays dead when late output arrives after death", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({ project: "p", projectPath: "/p", agent });
    fake.emitExit(1);
    fake.emitOutput("still writing after death\n");
    expect(manager.get(session.id)?.state).toBe("dead");
  });

  it("throws when killing an unknown session", () => {
    const manager = new SessionManager(spawner);
    expect(() => manager.kill("missing")).toThrow(/missing/);
  });

  it("notifies subscribers when a session changes", () => {
    const manager = new SessionManager(spawner);
    const listener = vi.fn();
    manager.onChange(listener);
    manager.start({ project: "p", projectPath: "/p", agent });
    fake.emitOutput("working\n");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith([
      expect.objectContaining({ state: "running", summary: "working" }),
    ]);
  });

  it("stops notifying after unsubscribe", () => {
    const manager = new SessionManager(spawner);
    const listener = vi.fn();
    const unsubscribe = manager.onChange(listener);
    unsubscribe();
    manager.start({ project: "p", projectPath: "/p", agent });
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not let one dead session affect another", () => {
    const first = new FakeProcess();
    const second = new FakeProcess();
    const processes = [first, second];
    let index = 0;
    const nextProcess = (): FakeProcess => {
      const next = processes[index++];
      if (next === undefined) throw new Error("spawner called more times than expected");
      return next;
    };
    const manager = new SessionManager(nextProcess);
    const a = manager.start({ project: "a", projectPath: "/a", agent });
    const b = manager.start({ project: "b", projectPath: "/b", agent });
    first.emitExit(1);
    expect(manager.get(a.id)?.state).toBe("dead");
    expect(manager.get(b.id)?.state).toBe("starting");
  });

  it("does not leave an orphan session when the spawner throws", () => {
    const manager = new SessionManager(() => {
      throw new Error("spawn ENOENT");
    });
    expect(() => manager.start({ project: "p", projectPath: "/p", agent })).toThrow(
      /spawn ENOENT/,
    );
    expect(manager.list()).toEqual([]);
  });

  it("does not let one session's output affect another", () => {
    const first = new FakeProcess();
    const second = new FakeProcess();
    const processes = [first, second];
    let index = 0;
    const nextProcess = (): FakeProcess => {
      const next = processes[index++];
      if (next === undefined) throw new Error("spawner called more times than expected");
      return next;
    };
    const manager = new SessionManager(nextProcess);
    const a = manager.start({ project: "a", projectPath: "/a", agent });
    const b = manager.start({ project: "b", projectPath: "/b", agent });
    first.emitOutput("only a's output\n");
    expect(manager.get(a.id)?.state).toBe("running");
    expect(manager.get(a.id)?.summary).toBe("only a's output");
    expect(manager.get(b.id)?.state).toBe("starting");
    expect(manager.get(b.id)?.summary).toBe("");
  });

  describe("with a SessionStore", () => {
    it("works with no store injected (store is optional)", () => {
      const manager = new SessionManager(spawner);
      expect(() => manager.start({ project: "p", projectPath: "/p", agent })).not.toThrow();
    });

    it("upserts a row on start", () => {
      const store = new FakeStore();
      const manager = new SessionManager(spawner, store);
      const session = manager.start({ project: "p", projectPath: "/p", agent });
      expect(store.rows.get(session.id)).toMatchObject({ state: "starting" });
    });

    it("upserts again on every later transition, keyed by id", () => {
      const store = new FakeStore();
      const manager = new SessionManager(spawner, store);
      const session = manager.start({ project: "p", projectPath: "/p", agent });
      fake.emitOutput("working\n");
      expect(store.rows.size).toBe(1);
      expect(store.rows.get(session.id)).toMatchObject({ state: "running", summary: "working" });
    });

    it("records exitCode and endedAt when the process exits", () => {
      const store = new FakeStore();
      const manager = new SessionManager(spawner, store);
      const session = manager.start({ project: "p", projectPath: "/p", agent });
      fake.emitExit(1);
      const row = store.rows.get(session.id);
      expect(row?.state).toBe("dead");
      expect(row?.exitCode).toBe(1);
      expect(row?.endedAt).toEqual(expect.any(Number));
    });

    it("records endedAt with no exitCode when killed manually", () => {
      const store = new FakeStore();
      const manager = new SessionManager(spawner, store);
      const session = manager.start({ project: "p", projectPath: "/p", agent });
      manager.kill(session.id);
      const row = store.rows.get(session.id);
      expect(row?.state).toBe("dead");
      expect(row?.exitCode).toBeUndefined();
      expect(row?.endedAt).toEqual(expect.any(Number));
    });

    it("records exitCode 0 and endedAt on a clean exit", () => {
      const store = new FakeStore();
      const manager = new SessionManager(spawner, store);
      const session = manager.start({ project: "p", projectPath: "/p", agent });
      fake.emitExit(0);
      const row = store.rows.get(session.id);
      expect(row?.state).toBe("done");
      expect(row?.exitCode).toBe(0);
      expect(row?.endedAt).toEqual(expect.any(Number));
    });
  });

  describe("output transcript", () => {
    it("retains output so a session opened mid-run shows what came before", () => {
      const manager = new SessionManager(spawner);
      const session = manager.start({
        project: "acme",
        projectPath: "/tmp/acme",
        agent,
      });

      fake.emitOutput("first line\n");
      fake.emitOutput("second line\n");

      expect(manager.log(session.id)).toBe("first line\nsecond line\n");
    });

    it("keeps the transcript after the session has exited", () => {
      const manager = new SessionManager(spawner);
      const session = manager.start({
        project: "acme",
        projectPath: "/tmp/acme",
        agent,
      });

      fake.emitOutput("crashed: missing file\n");
      fake.emitExit(1);

      expect(manager.log(session.id)).toBe("crashed: missing file\n");
    });

    it("returns an empty transcript for an unknown session instead of throwing", () => {
      const manager = new SessionManager(spawner);
      expect(manager.log("no-such-session")).toBe("");
    });

    it("streams each chunk to output subscribers tagged with its session", () => {
      const manager = new SessionManager(spawner);
      const seen: { sessionId: string; chunk: string }[] = [];
      manager.onOutput((output) => seen.push(output));

      const session = manager.start({
        project: "acme",
        projectPath: "/tmp/acme",
        agent,
      });
      fake.emitOutput("hello\n");

      expect(seen).toEqual([{ sessionId: session.id, chunk: "hello\n" }]);
    });

    it("stops delivering to a subscriber after it unsubscribes", () => {
      const manager = new SessionManager(spawner);
      const seen: string[] = [];
      const off = manager.onOutput((output) => seen.push(output.chunk));

      manager.start({ project: "acme", projectPath: "/tmp/acme", agent });
      fake.emitOutput("before\n");
      off();
      fake.emitOutput("after\n");

      expect(seen).toEqual(["before\n"]);
    });

    // The cap must bound memory without ever costing the newest output —
    // which is the part a user opening a running session is looking at.
    it("drops the oldest output once the retained transcript passes its cap", () => {
      const manager = new SessionManager(spawner);
      const session = manager.start({
        project: "acme",
        projectPath: "/tmp/acme",
        agent,
      });

      const chunk = `${"x".repeat(64 * 1024)}\n`;
      for (let i = 0; i < 8; i += 1) fake.emitOutput(chunk);
      fake.emitOutput("newest\n");

      const log = manager.log(session.id);
      expect(log.length).toBeLessThanOrEqual(256 * 1024);
      expect(log.endsWith("newest\n")).toBe(true);
    });

    // A single chunk bigger than the whole cap must not be discarded
    // wholesale — its tail is the newest thing the agent printed.
    it("truncates a single oversized chunk from its front rather than dropping it", () => {
      const manager = new SessionManager(spawner);
      const session = manager.start({
        project: "acme",
        projectPath: "/tmp/acme",
        agent,
      });

      fake.emitOutput(`${"y".repeat(300 * 1024)}TAIL`);

      const log = manager.log(session.id);
      expect(log.length).toBe(256 * 1024);
      expect(log.endsWith("TAIL")).toBe(true);
    });
  });
});

describe("terminal input and size", () => {
  // These blocks sit outside the main `describe`, so they carry their own
  // fixture rather than borrowing its `beforeEach`.
  let fake: FakeProcess;
  let spawner: Spawner;

  beforeEach(() => {
    fake = new FakeProcess();
    spawner = () => fake;
  });

  it("writes raw input through without adding a newline", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({
      project: "acme",
      projectPath: "/tmp/acme",
      agent,
    });

    manager.write(session.id, "ls -la");

    expect(fake.written).toEqual(["ls -la"]);
  });

  // Control bytes are the difference between a terminal and a text box.
  it("passes control bytes through unchanged", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({
      project: "acme",
      projectPath: "/tmp/acme",
      agent,
    });

    const ctrlC = String.fromCharCode(3);
    manager.write(session.id, ctrlC);

    expect(fake.written).toEqual([ctrlC]);
  });

  // Keystrokes can be in flight from the UI at the instant a session ends,
  // and losing that race is not an error worth surfacing.
  it("ignores input for an unknown session instead of throwing", () => {
    const manager = new SessionManager(spawner);
    expect(() => manager.write("no-such-session", "x")).not.toThrow();
  });

  it("passes a resize to the session's terminal", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({
      project: "acme",
      projectPath: "/tmp/acme",
      agent,
    });

    manager.resize(session.id, 120, 40);

    expect(fake.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("ignores a resize for an unknown session", () => {
    const manager = new SessionManager(spawner);
    expect(() => manager.resize("no-such-session", 80, 24)).not.toThrow();
  });

  // Not every Spawner runs its child under a pty — a piped process has no
  // window size to change, and `resize` is optional for exactly that case.
  it("ignores a resize for a process with no terminal", () => {
    const piped: ProcessHandle = {
      write: () => {},
      kill: () => {},
      onOutput: () => {},
      onExit: () => {},
    };
    const manager = new SessionManager(() => piped);
    const session = manager.start({
      project: "acme",
      projectPath: "/tmp/acme",
      agent,
    });

    expect(() => manager.resize(session.id, 80, 24)).not.toThrow();
  });
});

describe("summary from terminal output", () => {
  // These blocks sit outside the main `describe`, so they carry their own
  // fixture rather than borrowing its `beforeEach`.
  let fake: FakeProcess;
  let spawner: Spawner;

  beforeEach(() => {
    fake = new FakeProcess();
    spawner = () => fake;
  });

  const ESC = String.fromCharCode(27);

  // An agent under a pty draws its whole UI out of escape sequences. A
  // summary taken from the raw stream would be cursor-positioning noise.
  it("strips escape sequences out of the row summary", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({
      project: "acme",
      projectPath: "/tmp/acme",
      agent,
    });

    fake.emitOutput(`${ESC}[2K${ESC}[1;36mReading Checkout.php${ESC}[0m\r\n`);

    expect(manager.get(session.id)?.summary).toBe("Reading Checkout.php");
  });

  it("splits on a bare carriage return, as a redrawing UI emits", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({
      project: "acme",
      projectPath: "/tmp/acme",
      agent,
    });

    fake.emitOutput("first pass\rsecond pass\r\n");

    expect(manager.get(session.id)?.summary).toBe("second pass");
  });

  // A terminal UI redraws its frame constantly; "│" summarises nothing.
  it("skips lines that are only box-drawing chrome", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({
      project: "acme",
      projectPath: "/tmp/acme",
      agent,
    });

    fake.emitOutput("Running tests\r\n");
    fake.emitOutput("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\r\n");

    expect(manager.get(session.id)?.summary).toBe("Running tests");
  });

  it("keeps a line that merely contains a box-drawing character", () => {
    const manager = new SessionManager(spawner);
    const session = manager.start({
      project: "acme",
      projectPath: "/tmp/acme",
      agent,
    });

    fake.emitOutput("\u2502 Welcome to Claude Code \u2502\r\n");

    expect(manager.get(session.id)?.summary).toBe("\u2502 Welcome to Claude Code \u2502");
  });
});

describe("SessionManager.resume", () => {
  let fake: FakeProcess;

  beforeEach(() => {
    fake = new FakeProcess();
  });

  const past = {
    id: "past-1",
    project: null,
    projectPath: "/p/acme",
    agent,
  };

  // Resuming keeps the id, so the conversation continues in the row it
  // already has rather than forking into a second entry.
  it("keeps the session's own id", () => {
    const manager = new SessionManager(() => fake);
    expect(manager.resume(past).id).toBe("past-1");
  });

  it("asks the spawner to resume rather than start fresh", () => {
    const calls: { id?: string; resume?: boolean }[] = [];
    const manager = new SessionManager((_agent, _path, sessionId, options) => {
      calls.push({ id: sessionId, resume: options?.resume });
      return fake;
    });
    manager.resume(past);
    expect(calls).toEqual([{ id: "past-1", resume: true }]);
  });

  it("spawns in the directory the session was recorded in", () => {
    const paths: string[] = [];
    const manager = new SessionManager((_agent, path) => {
      paths.push(path);
      return fake;
    });
    manager.resume(past);
    expect(paths).toEqual(["/p/acme"]);
  });

  it("puts the resumed session back in the live list", () => {
    const manager = new SessionManager(() => fake);
    manager.resume(past);
    expect(manager.list().map((s) => s.id)).toContain("past-1");
  });

  // A resumed session is a live process again; its output has to reach the
  // view the same way a started one's does.
  it("streams output from the resumed process", () => {
    const manager = new SessionManager(() => fake);
    const chunks: string[] = [];
    manager.onOutput((output) => chunks.push(output.chunk));
    manager.resume(past);
    fake.emitOutput("resumed\r\n");
    expect(chunks).toEqual(["resumed\r\n"]);
  });

  it("does not leave a dead session behind when the spawn fails", () => {
    const manager = new SessionManager(() => {
      throw new Error("no binary");
    });
    expect(() => manager.resume(past)).toThrow(/no binary/);
    expect(manager.list()).toEqual([]);
  });
});
