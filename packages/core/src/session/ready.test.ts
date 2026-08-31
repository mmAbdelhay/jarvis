import { beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../registry/types.js";
import { SessionManager } from "./manager.js";
import type { ProcessHandle, Spawner } from "./types.js";

const agent: AgentConfig = { id: "claude-acme", command: "claude-acme" };

class FakeProcess implements ProcessHandle {
  written: string[] = [];
  killed = false;
  #output: ((chunk: string) => void)[] = [];
  #exit: ((code: number) => void)[] = [];

  write(data: string): void {
    this.written.push(data);
  }
  kill(): void {
    this.killed = true;
  }
  onOutput(listener: (chunk: string) => void): void {
    this.#output.push(listener);
  }
  onExit(listener: (code: number) => void): void {
    this.#exit.push(listener);
  }

  emitOutput(chunk: string): void {
    for (const listener of this.#output) listener(chunk);
  }
  emitExit(code: number): void {
    for (const listener of this.#exit) listener(code);
  }
}

/**
 * A stand-in for setTimeout that only fires when a test says so. Real timers
 * would make every test here a sleep, and a fake clock is also the only way
 * to assert the negative — that nothing was sent *yet*.
 */
class ManualScheduler {
  #pending: { fn: () => void; ms: number } | undefined;
  lastDelayMs: number | undefined;

  schedule = (fn: () => void, ms: number): (() => void) => {
    this.#pending = { fn, ms };
    this.lastDelayMs = ms;
    return () => {
      this.#pending = undefined;
    };
  };

  fire(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.fn();
  }

  get armed(): boolean {
    return this.#pending !== undefined;
  }
}

describe("SessionManager.sendWhenReady", () => {
  let fake: FakeProcess;
  let spawner: Spawner;
  let clock: ManualScheduler;

  beforeEach(() => {
    fake = new FakeProcess();
    spawner = () => fake;
    clock = new ManualScheduler();
  });

  function start(): { manager: SessionManager; id: string } {
    const manager = new SessionManager(spawner, undefined, { schedule: clock.schedule });
    const session = manager.start({ project: "acme", projectPath: "/p/acme", agent });
    return { manager, id: session.id };
  }

  // An agent under a pty drops what is typed before it has drawn its input
  // box, so the task must not go out the instant the session starts.
  it("writes nothing before the agent has produced any output", () => {
    const { manager, id } = start();

    manager.sendWhenReady(id, "fetch the bugs assigned to me");

    expect(fake.written).toEqual([]);
  });

  it("writes nothing while the agent is still producing output", () => {
    const { manager, id } = start();
    manager.sendWhenReady(id, "fetch the bugs assigned to me");

    fake.emitOutput("Welcome to Claude Code");

    expect(fake.written).toEqual([]);
  });

  it("submits the task once the output has gone quiet", () => {
    const { manager, id } = start();
    manager.sendWhenReady(id, "fetch the bugs assigned to me");

    fake.emitOutput("Welcome to Claude Code");
    clock.fire();

    expect(fake.written).toEqual(["fetch the bugs assigned to me\r"]);
  });

  // Each chunk restarts the wait: a banner that arrives in four pieces is
  // one agent still starting up, not four chances to interrupt it.
  it("restarts the wait on every new chunk", () => {
    const { manager, id } = start();
    manager.sendWhenReady(id, "task");

    fake.emitOutput("banner line 1");
    fake.emitOutput("banner line 2");
    clock.fire();

    expect(fake.written).toEqual(["task\r"]);
  });

  it("submits the task exactly once, however much output follows", () => {
    const { manager, id } = start();
    manager.sendWhenReady(id, "task");

    fake.emitOutput("banner");
    clock.fire();
    fake.emitOutput("the agent's own reply");
    clock.fire();

    expect(fake.written).toEqual(["task\r"]);
  });

  // A session that dies during startup (a broken command, a bad path) must
  // not have its task typed into nothing, and must not throw on the way.
  it("drops the task when the session exits before it is ready", () => {
    const { manager, id } = start();
    manager.sendWhenReady(id, "task");

    fake.emitOutput("Error: command not found");
    fake.emitExit(127);
    clock.fire();

    expect(fake.written).toEqual([]);
  });

  it("ignores an empty task rather than submitting a bare newline", () => {
    const { manager, id } = start();

    manager.sendWhenReady(id, "   ");
    fake.emitOutput("banner");

    expect(clock.armed).toBe(false);
    expect(fake.written).toEqual([]);
  });

  it("ignores an unknown session id", () => {
    const { manager } = start();

    expect(() => manager.sendWhenReady("no-such-session", "task")).not.toThrow();
  });
});
