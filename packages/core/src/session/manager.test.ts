import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "./manager.js";
import type { ProcessHandle, Spawner } from "./types.js";
import type { AgentConfig } from "../registry/types.js";

const agent: AgentConfig = { id: "claude-mm", command: "claude-mm", model: "opus" };

class FakeProcess implements ProcessHandle {
  written: string[] = [];
  killed = false;
  #output: ((chunk: string) => void)[] = [];
  #exit: ((code: number) => void)[] = [];

  write(data: string): void { this.written.push(data); }
  kill(): void { this.killed = true; }
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
    expect(fake.written).toEqual(["run the tests\n"]);
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
});
