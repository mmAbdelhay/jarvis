import { describe, expect, it } from "vitest";
import { createSpawner, runCommand } from "./spawn.js";
import type { AgentConfig } from "@jarvis/core";

describe("runCommand", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await runCommand("echo", ["hello"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("captures a non-zero exit code", async () => {
    const result = await runCommand("sh", ["-c", "exit 3"]);
    expect(result.code).toBe(3);
  });

  it("captures stderr separately from stdout", async () => {
    const result = await runCommand("sh", ["-c", "echo out; echo err >&2"]);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  it("rejects for a command that does not exist", async () => {
    await expect(runCommand("jarvis-not-a-real-binary", [])).rejects.toThrow();
  });
});

describe("createSpawner", () => {
  it("streams output and reports exit", async () => {
    const agent: AgentConfig = { id: "echo", command: "sh", args: ["-c", "echo streamed"] };
    const handle = createSpawner()(agent, process.cwd());

    const chunks: string[] = [];
    handle.onOutput((chunk) => chunks.push(chunk));

    const code = await new Promise<number>((resolve) => handle.onExit(resolve));

    expect(code).toBe(0);
    expect(chunks.join("")).toContain("streamed");
  });

  it("runs the process in the given directory", async () => {
    const agent: AgentConfig = { id: "pwd", command: "pwd" };
    const handle = createSpawner()(agent, "/tmp");

    const chunks: string[] = [];
    handle.onOutput((chunk) => chunks.push(chunk));
    await new Promise<number>((resolve) => handle.onExit(resolve));

    expect(chunks.join("")).toContain("/tmp");
  });

  it("reports a non-zero exit code for a process killed by a signal", async () => {
    // `sleep` is the child process directly (no shell wrapper), so kill()
    // signals it straight away instead of racing a shell's own signal
    // handling.
    const agent: AgentConfig = { id: "sleeper", command: "sleep", args: ["30"] };
    const handle = createSpawner()(agent, process.cwd());

    try {
      const code = await new Promise<number>((resolve) => {
        handle.onExit(resolve);
        handle.kill();
      });

      // `handle.kill()` sends SIGTERM (signal 15); pin the exact shell
      // convention (128 + 15 = 143) rather than just asserting non-zero, so
      // a mutation that hardcodes every SIGNAL_NUMBERS entry to 1 still fails.
      expect(code).toBe(143);
    } finally {
      handle.kill();
    }
  }, 10_000);

  it("dispatches exit exactly once when the process fails to spawn", async () => {
    const agent: AgentConfig = { id: "missing", command: "jarvis-not-a-real-binary" };
    const handle = createSpawner()(agent, process.cwd());

    let callCount = 0;
    await new Promise<void>((resolve) => {
      handle.onExit(() => {
        callCount += 1;
        resolve();
      });
    });

    // Give any second, erroneous "close"-driven dispatch a turn to land
    // before asserting it never arrived.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(callCount).toBe(1);
  }, 10_000);

  it("replays the exit code to a listener registered after the process has already died", async () => {
    const agent: AgentConfig = { id: "echo", command: "sh", args: ["-c", "exit 7"] };
    const handle = createSpawner()(agent, process.cwd());

    // Simulate a consumer that awaits something else — with no subscriber
    // yet registered — long enough for the process to actually exit
    // before it ever calls onExit, so the terminal "close" event has
    // nowhere to land except the internal latch.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const code = await new Promise<number>((resolve) => handle.onExit(resolve));

    expect(code).toBe(7);
  }, 10_000);

  it("does not throw when writing to a process that has already exited", async () => {
    const agent: AgentConfig = { id: "immediate-exit", command: "sh", args: ["-c", "exit 0"] };
    const handle = createSpawner()(agent, process.cwd());

    await new Promise<number>((resolve) => handle.onExit(resolve));

    expect(() => handle.write("too late\n")).not.toThrow();

    // Give the resulting EPIPE-style stdin error a turn to surface; if it
    // were unhandled it would throw asynchronously and fail the test run.
    await new Promise((resolve) => setImmediate(resolve));
  }, 10_000);

  it("never emits a spliced line when stdout and stderr chunks interleave mid-line", async () => {
    // node -e script that writes partial, non-newline-terminated chunks to
    // stdout and stderr, interleaved, so the underlying pipes race.
    const script = [
      "process.stdout.write('AAA-');",
      "process.stderr.write('BBB-');",
      "process.stdout.write('stdout-tail\\n');",
      "process.stderr.write('stderr-tail\\n');",
    ].join("");
    const agent: AgentConfig = { id: "interleaved", command: "node", args: ["-e", script] };
    const handle = createSpawner()(agent, process.cwd());

    const lines: string[] = [];
    handle.onOutput((chunk) => lines.push(chunk));
    await new Promise<number>((resolve) => handle.onExit(resolve));

    const joined = lines.join("");
    expect(joined).not.toContain("AAA-BBB-");
    expect(joined).not.toContain("BBB-AAA-");
    expect(joined).toContain("AAA-stdout-tail");
    expect(joined).toContain("BBB-stderr-tail");
  }, 10_000);

  it("writes data to the child process stdin", async () => {
    const agent: AgentConfig = { id: "cat", command: "cat" };
    const handle = createSpawner()(agent, process.cwd());

    try {
      const chunks: string[] = [];
      handle.onOutput((chunk) => {
        chunks.push(chunk);
        if (chunk.includes("piped input")) handle.kill();
      });
      handle.write("piped input\n");
      await new Promise<number>((resolve) => handle.onExit(resolve));

      expect(chunks.join("")).toContain("piped input");
    } finally {
      // `cat` only exits once killed above; if an assertion throws first,
      // make sure the child doesn't outlive the test.
      handle.kill();
    }
  }, 10_000);

  it("reports a non-zero exit code and forwards the message when the command does not exist", async () => {
    const agent: AgentConfig = { id: "missing", command: "jarvis-not-a-real-binary" };
    const handle = createSpawner()(agent, process.cwd());

    const chunks: string[] = [];
    handle.onOutput((chunk) => chunks.push(chunk));
    const code = await new Promise<number>((resolve) => handle.onExit(resolve));

    expect(code).not.toBe(0);
    expect(chunks.join("").length).toBeGreaterThan(0);
  });

  it("passes the given environment through to the child process", async () => {
    const agent: AgentConfig = { id: "env", command: "sh", args: ["-c", "echo $JARVIS_TEST_VAR"] };
    const handle = createSpawner({ ...process.env, JARVIS_TEST_VAR: "marker-value" })(agent, process.cwd());

    const chunks: string[] = [];
    handle.onOutput((chunk) => chunks.push(chunk));
    await new Promise<number>((resolve) => handle.onExit(resolve));

    expect(chunks.join("")).toContain("marker-value");
  });
});
