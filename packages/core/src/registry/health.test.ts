import { describe, expect, it } from "vitest";
import { checkAgent, checkAll } from "./health.js";
import type { CommandRunner } from "./health.js";
import type { AgentConfig } from "./types.js";

const agent: AgentConfig = { id: "claude-mm", command: "claude-mm", model: "opus" };

const runner = (result: { code: number; stdout: string; stderr: string }): CommandRunner =>
  async () => result;

describe("checkAgent", () => {
  it("reports healthy when the command prints a version", async () => {
    const health = await checkAgent(agent, runner({ code: 0, stdout: "2.1.251 (Claude Code)", stderr: "" }));
    expect(health).toEqual({ id: "claude-mm", ok: true, detail: "2.1.251 (Claude Code)" });
  });

  it("detects the native-binary stub even though it exits zero", async () => {
    const stub = {
      code: 0,
      stdout: "",
      stderr: "Error: claude native binary not installed.\n\nEither postinstall did not run",
    };
    const health = await checkAgent(agent, runner(stub));
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("native binary not installed");
  });

  it("reports unhealthy on a non-zero exit with no output, falling back to the exit code", async () => {
    const health = await checkAgent(agent, runner({ code: 2, stdout: "", stderr: "" }));
    expect(health.ok).toBe(false);
    expect(health.detail).toBe("exit 2");
  });

  it("reports unhealthy on a non-zero exit with unmarked error text", async () => {
    const health = await checkAgent(agent, runner({ code: 1, stdout: "", stderr: "disk full" }));
    expect(health.ok).toBe(false);
    expect(health.detail).toBe("disk full");
  });

  it("reports unhealthy when the runner throws an Error", async () => {
    const health = await checkAgent(agent, async () => {
      throw new Error("spawn ENOENT");
    });
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("spawn ENOENT");
  });

  it("reports unhealthy, not a thrown exception, when the runner rejects with a non-Error", async () => {
    const health = await checkAgent(agent, async () => {
      throw "boom";
    });
    expect(health).toEqual({ id: "claude-mm", ok: false, detail: "boom" });
  });

  it("reports unhealthy when the command prints nothing at all", async () => {
    const health = await checkAgent(agent, runner({ code: 0, stdout: "   ", stderr: "" }));
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("no output");
  });
});

describe("checkAll", () => {
  it("checks every agent and preserves order", async () => {
    const agents: AgentConfig[] = [
      { id: "a", command: "a" },
      { id: "b", command: "b" },
    ];
    const results = await checkAll(agents, runner({ code: 0, stdout: "1.0.0", stderr: "" }));
    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it(
    "preserves input order even when a later agent resolves first, and runs concurrently",
    async () => {
      const agents: AgentConfig[] = [
        { id: "a", command: "a" },
        { id: "b", command: "b" },
      ];

      // Barrier instead of a wall-clock bound: each runner increments a
      // shared counter, then awaits a promise that only resolves once the
      // counter reaches the agent count. Under the real Promise.all-based
      // checkAll, both runners are entered (both increment the counter)
      // before either resolves, so the barrier releases and both complete.
      // Under a sequential for-loop rewrite, the second runner is only
      // invoked after the first resolves — so the first runner's barrier
      // condition is never met and it awaits forever, which this test
      // catches as a timeout rather than a flaky timing comparison.
      let arrived = 0;
      let release: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });

      const synced: CommandRunner = async (command) => {
        arrived += 1;
        if (arrived === agents.length) {
          release();
        }
        await barrier;

        if (command === "a") {
          // One extra microtask tick so "b" still settles first even
          // though both are released by the same barrier at the same time,
          // preserving the "later agent resolves first" scenario.
          await Promise.resolve();
          return { code: 127, stdout: "", stderr: "command not found" };
        }
        return { code: 0, stdout: "1.0.0", stderr: "" };
      };

      const results = await checkAll(agents, synced);

      expect(results.map((r) => r.id)).toEqual(["a", "b"]);
      expect(results[0]?.ok).toBe(false);
      expect(results[1]?.ok).toBe(true);
      expect(results.every((r) => r.ok)).toBe(false);
    },
    // Comfortably above the barrier's expected (near-instant) resolution,
    // so a genuine deadlock (sequential execution) reports as a failure
    // instead of hanging the suite.
    1000,
  );

  it("returns an empty array for no agents", async () => {
    const results = await checkAll([], runner({ code: 0, stdout: "1.0.0", stderr: "" }));
    expect(results).toEqual([]);
  });
});
