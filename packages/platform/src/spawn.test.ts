import { tmpdir } from "node:os";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { createSpawner, runCommand, runCommandWithLimits } from "./spawn.js";
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

  it("runs with a caller-supplied environment instead of the inherited one", async () => {
    const result = await runCommand("sh", ["-c", 'printf %s "$MARKER"'], { MARKER: "hi" });
    expect(result.stdout).toBe("hi");
  });

  // M12 Task 12 minor: '€' is 3 bytes in UTF-8 (E2 82 AC). Writing its
  // first two bytes, then — after a real event-loop tick, so the read side
  // gets a genuinely separate "data" event rather than one coalesced read
  // — its last byte, is exactly the split a naive `Buffer#toString()` per
  // chunk gets wrong: each half decodes on its own and becomes its own
  // U+FFFD. A StringDecoder held across chunks reassembles the one
  // character instead.
  it("never turns a UTF-8 character split across two writes into replacement characters", async () => {
    const script = [
      "process.stdout.write(Buffer.from([0xe2, 0x82]));",
      "setTimeout(() => process.stdout.write(Buffer.from([0xac])), 20);",
    ].join("");
    const result = await runCommand(process.execPath, ["-e", script]);

    expect(result.stdout).toBe("€");
    expect(result.stdout).not.toContain("�");
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
    // `pwd` on POSIX, `cd` (with no argument) on cmd.exe: both print the cwd.
    const agent: AgentConfig =
      process.platform === "win32"
        ? { id: "pwd", command: "cmd", args: ["/d", "/c", "cd"] }
        : { id: "pwd", command: "pwd" };
    const handle = createSpawner()(agent, tmpdir());

    const chunks: string[] = [];
    handle.onOutput((chunk) => chunks.push(chunk));
    await new Promise<number>((resolve) => handle.onExit(resolve));

    // macOS resolves /tmp to /private/tmp; the basename is the same either way.
    expect(chunks.join("").toLowerCase()).toContain(basename(tmpdir()).toLowerCase());
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

  it("flushes an incomplete trailing UTF-8 sequence as a replacement character", async () => {
    const script = "process.stdout.write(Buffer.from([0xe2]));";
    const agent: AgentConfig = { id: "partial-utf8", command: "node", args: ["-e", script] };
    const handle = createSpawner()(agent, process.cwd());

    const chunks: string[] = [];
    handle.onOutput((chunk) => chunks.push(chunk));
    await new Promise<number>((resolve) => handle.onExit(resolve));

    expect(chunks.join(""), "final line should expose the incomplete sequence").toContain("�");
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

  // M12 Task 12 minor: same split-character scenario as runCommand's own
  // test above, through the line-forwarding path instead.
  it("never turns a UTF-8 character split across two writes into replacement characters", async () => {
    const script = [
      "process.stdout.write(Buffer.from([0xe2, 0x82]));",
      "setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x0a])), 20);",
    ].join("");
    const agent: AgentConfig = { id: "split-utf8", command: "node", args: ["-e", script] };
    const handle = createSpawner()(agent, process.cwd());

    const chunks: string[] = [];
    handle.onOutput((chunk) => chunks.push(chunk));
    await new Promise<number>((resolve) => handle.onExit(resolve));

    const joined = chunks.join("");
    expect(joined).toContain("€");
    expect(joined).not.toContain("�");
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
    const handle = createSpawner({ ...process.env, JARVIS_TEST_VAR: "marker-value" })(
      agent,
      process.cwd(),
    );

    const chunks: string[] = [];
    handle.onOutput((chunk) => chunks.push(chunk));
    await new Promise<number>((resolve) => handle.onExit(resolve));

    expect(chunks.join("")).toContain("marker-value");
  });
});

describe("runCommandWithLimits", () => {
  it("kills a child that outlives the timeout and reports timedOut", async () => {
    const started = Date.now();
    const result = await runCommandWithLimits(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      { timeoutMs: 200, maxOutputBytes: 1024 },
    );

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("caps each stream at maxOutputBytes and reports truncated", async () => {
    const script = "process.stdout.write('a'.repeat(200 * 1024))";
    const result = await runCommandWithLimits(process.execPath, ["-e", script], {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });

    expect(result.stdout.length).toBeLessThanOrEqual(1024);
    expect(result.truncated).toBe(true);
  });

  it("rejects for a command that does not exist", async () => {
    await expect(
      runCommandWithLimits("jarvis-not-a-real-binary", [], {
        timeoutMs: 1000,
        maxOutputBytes: 1024,
      }),
    ).rejects.toThrow();
  });

  it("resolves normally for a quick, small command", async () => {
    const result = await runCommandWithLimits(
      process.execPath,
      ["-e", "process.stdout.write('hi')"],
      {
        timeoutMs: 5000,
        maxOutputBytes: 1024,
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hi");
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  // Bite-proof: comparing `current.length` (UTF-16 code units) against
  // maxOutputBytes — instead of Buffer.byteLength(current, "utf8") — lets a
  // stream of 3-byte UTF-8 characters (each one UTF-16 code unit) retain up
  // to maxOutputBytes *characters*, i.e. up to 3x the byte cap.
  it("caps retained bytes, not code units, for a non-ASCII stream", async () => {
    const euro = "€"; // '€': 3 bytes in UTF-8, 1 UTF-16 code unit.
    const script = `process.stdout.write(${JSON.stringify(euro)}.repeat(2000))`;
    const result = await runCommandWithLimits(process.execPath, ["-e", script], {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });

    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1024);
    expect(result.truncated).toBe(true);
  });

  // A cap that lands mid-character must cut before it, not through it: a
  // naive byte-indexed slice of the UTF-8 encoding (or a code-unit slice
  // through a surrogate pair) can split one code point across the boundary,
  // leaving a lone surrogate or a broken multi-byte sequence in the output.
  it("never splits a code point when truncating a multi-byte stream", async () => {
    const emoji = "\u{1F600}"; // 😀: 4 bytes in UTF-8, a surrogate pair (2 UTF-16 units).
    const script = `process.stdout.write(${JSON.stringify(emoji)}.repeat(500))`;
    const result = await runCommandWithLimits(process.execPath, ["-e", script], {
      timeoutMs: 5000,
      maxOutputBytes: 999, // Not a multiple of 4 — forces a mid-character boundary if cut naively.
    });

    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(999);
    // No lone surrogate: every code point in the retained text is a whole,
    // intact emoji, and each one is 2 UTF-16 units, so the total is even.
    expect(result.stdout.length % 2).toBe(0);
    expect([...result.stdout].every((codePoint) => codePoint === emoji)).toBe(true);
  });

  // M12 Task 12 minor: same split-character scenario as runCommand's own
  // test above, through the byte-capped path instead.
  it("never turns a UTF-8 character split across two writes into replacement characters", async () => {
    const script = [
      "process.stdout.write(Buffer.from([0xe2, 0x82]));",
      "setTimeout(() => process.stdout.write(Buffer.from([0xac])), 20);",
    ].join("");
    const result = await runCommandWithLimits(process.execPath, ["-e", script], {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });

    expect(result.stdout).toBe("€");
    expect(result.stdout).not.toContain("�");
  });
});
