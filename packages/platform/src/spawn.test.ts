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

    const code = await new Promise<number>((resolve) => {
      handle.onExit(resolve);
      handle.kill();
    });

    expect(code).not.toBe(0);
    expect(code).toBeGreaterThan(0);
  });

  it("writes data to the child process stdin", async () => {
    const agent: AgentConfig = { id: "cat", command: "cat" };
    const handle = createSpawner()(agent, process.cwd());

    const chunks: string[] = [];
    handle.onOutput((chunk) => {
      chunks.push(chunk);
      if (chunk.includes("piped input")) handle.kill();
    });
    handle.write("piped input\n");
    await new Promise<number>((resolve) => handle.onExit(resolve));

    expect(chunks.join("")).toContain("piped input");
  });

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
