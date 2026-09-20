import { describe, expect, it } from "vitest";
import {
  commandBasename,
  listAgentProcesses,
  parseEtime,
  parseLsofCwd,
  parsePsOutput,
  type ProcessScanDeps,
} from "./process-scan.js";

const AGENTS = [
  { id: "claude", command: "claude" },
  { id: "codex", command: "/opt/homebrew/bin/codex" },
];

describe("parsePsOutput", () => {
  it("parses pid, ppid, etime and the full command line", () => {
    const text = "  1234   1   01:02:03 /opt/homebrew/bin/claude --resume abc\n";
    expect(parsePsOutput(text)).toEqual([
      { pid: 1234, ppid: 1, etime: "01:02:03", command: "/opt/homebrew/bin/claude --resume abc" },
    ]);
  });

  it("parses several lines and skips blank ones", () => {
    const text = ["  1   0     10:00 /sbin/launchd", "", "  99  1   00:05 claude"].join("\n");
    expect(parsePsOutput(text)).toEqual([
      { pid: 1, ppid: 0, etime: "10:00", command: "/sbin/launchd" },
      { pid: 99, ppid: 1, etime: "00:05", command: "claude" },
    ]);
  });

  it("ignores a line that is not pid/ppid/etime/command", () => {
    expect(parsePsOutput("garbage\n")).toEqual([]);
  });
});

describe("commandBasename", () => {
  it("strips a directory from the first token", () => {
    expect(commandBasename("/opt/homebrew/bin/claude --resume abc")).toBe("claude");
  });

  it("leaves a bare command alone", () => {
    expect(commandBasename("codex")).toBe("codex");
  });

  it("never returns an argument", () => {
    expect(commandBasename("claude --print secret-prompt")).toBe("claude");
  });
});

describe("parseEtime", () => {
  const now = Date.parse("2026-09-20T12:00:00Z");

  it("parses mm:ss", () => {
    expect(parseEtime("05:30", now)).toBe(now - (5 * 60 + 30) * 1000);
  });

  it("parses hh:mm:ss", () => {
    expect(parseEtime("01:02:03", now)).toBe(now - ((1 * 60 + 2) * 60 + 3) * 1000);
  });

  it("parses d-hh:mm:ss", () => {
    expect(parseEtime("2-01:02:03", now)).toBe(now - (((2 * 24 + 1) * 60 + 2) * 60 + 3) * 1000);
  });

  it("returns null for unparseable text", () => {
    expect(parseEtime("not-a-time", now)).toBeNull();
  });
});

describe("parseLsofCwd", () => {
  it("maps each pid block's n line to that pid's cwd", () => {
    const text = [
      "p1234",
      "fcwd",
      "n/Users/u/projects/jarvis",
      "p5678",
      "fcwd",
      "n/Users/u/acme",
    ].join("\n");
    expect(parseLsofCwd(text)).toEqual(
      new Map([
        [1234, "/Users/u/projects/jarvis"],
        [5678, "/Users/u/acme"],
      ]),
    );
  });

  it("returns an empty map for empty output", () => {
    expect(parseLsofCwd("")).toEqual(new Map());
  });
});

describe("listAgentProcesses", () => {
  const now = Date.parse("2026-09-20T12:00:00Z");

  function deps(overrides: Partial<ProcessScanDeps> = {}): ProcessScanDeps {
    return {
      exec: async () => ({ code: 0, stdout: "" }),
      platform: "darwin",
      agents: AGENTS,
      ownedPids: () => new Set(),
      // Distinct from the pid-1 "launchd"/init row several fixtures below
      // use for an unrelated, ordinarily reparented process — a real
      // Jarvis process is never pid 1, and the "own process tree" test
      // below overrides this to exercise that walk specifically.
      jarvisPid: 99999,
      now: () => now,
      ...overrides,
    };
  }

  it("returns [] on Windows without running anything", async () => {
    const calls: string[] = [];
    const result = await listAgentProcesses(
      deps({
        platform: "win32",
        exec: async (command) => {
          calls.push(command);
          return { code: 0, stdout: "" };
        },
      }),
    );
    expect(result).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("finds a claude process outside Jarvis, with its cwd resolved", async () => {
    const psOut = [
      "   1   0   10:00 /sbin/launchd",
      "1234   1   00:05 /opt/homebrew/bin/claude --resume abc",
    ].join("\n");
    const lsofOut = ["p1234", "fcwd", "n/Users/u/projects/acme"].join("\n");
    const result = await listAgentProcesses(
      deps({
        exec: async (command, args) => {
          if (command === "ps") return { code: 0, stdout: psOut };
          if (command === "lsof") {
            expect(args).toContain("1234");
            return { code: 0, stdout: lsofOut };
          }
          throw new Error(`unexpected command ${command}`);
        },
      }),
    );
    expect(result).toEqual([
      {
        pid: 1234,
        agentId: "claude",
        command: "claude",
        cwd: "/Users/u/projects/acme",
        startedAt: now - 5000,
      },
    ]);
  });

  it("excludes a pid SessionManager owns", async () => {
    const psOut = "1234   1   00:05 claude\n";
    const result = await listAgentProcesses(
      deps({
        exec: async (command) =>
          command === "ps" ? { code: 0, stdout: psOut } : { code: 0, stdout: "" },
        ownedPids: () => new Set([1234]),
      }),
    );
    expect(result).toEqual([]);
  });

  it("excludes Jarvis's own process tree, including grandchildren", async () => {
    // jarvisPid 1 -> 50 (a shell Jarvis spawned) -> 1234 (claude under it)
    const psOut = [
      "   1   0   10:00 /Applications/Jarvis.app/Contents/MacOS/Jarvis",
      "  50   1   05:00 /bin/zsh",
      "1234  50   00:05 claude",
    ].join("\n");
    const result = await listAgentProcesses(
      deps({
        jarvisPid: 1,
        exec: async (command) =>
          command === "ps" ? { code: 0, stdout: psOut } : { code: 0, stdout: "" },
      }),
    );
    expect(result).toEqual([]);
  });

  it("ignores a process whose command does not match a registered agent", async () => {
    const psOut = "999   1   00:05 vim\n";
    const result = await listAgentProcesses(
      deps({
        exec: async (command) =>
          command === "ps" ? { code: 0, stdout: psOut } : { code: 0, stdout: "" },
      }),
    );
    expect(result).toEqual([]);
  });

  it("tolerates a missing lsof by reporting cwd unknown", async () => {
    const psOut = "1234   1   00:05 claude\n";
    const result = await listAgentProcesses(
      deps({
        exec: async (command) => {
          if (command === "ps") return { code: 0, stdout: psOut };
          throw new Error("lsof: command not found");
        },
      }),
    );
    expect(result).toEqual([
      { pid: 1234, agentId: "claude", command: "claude", cwd: null, startedAt: now - 5000 },
    ]);
  });

  it("returns [] when ps itself fails", async () => {
    const result = await listAgentProcesses(deps({ exec: async () => ({ code: 1, stdout: "" }) }));
    expect(result).toEqual([]);
  });

  it("batches one lsof call for multiple candidates", async () => {
    const psOut = ["1111   1   00:05 claude", "2222   1   00:06 codex"].join("\n");
    let lsofCalls = 0;
    const result = await listAgentProcesses(
      deps({
        exec: async (command, args) => {
          if (command === "ps") return { code: 0, stdout: psOut };
          lsofCalls += 1;
          expect(args).toContain("1111,2222");
          return { code: 0, stdout: "" };
        },
      }),
    );
    expect(lsofCalls).toBe(1);
    expect(result.map((r) => r.pid).sort()).toEqual([1111, 2222]);
  });
});
