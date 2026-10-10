import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createNodeCliSpawner } from "./node-spawner.js";
import { runCli, runOnce } from "./runner.js";
import type { CliInvocation } from "./specs.js";
import { createClaudeStream } from "./stream-claude.js";
import type { CliStreamEvent } from "./stream-types.js";

const FAKE = fileURLToPath(new URL("./__fixtures__/fake-cli.mjs", import.meta.url));
const fixture = (name: string) =>
  fileURLToPath(new URL(`./__fixtures__/${name}.jsonl`, import.meta.url));

function invocation(env: Record<string, string>, stdin = "", timeoutMs = 10_000): CliInvocation {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-acct-"));
  return {
    account: "claude",
    purpose: "turn",
    argv: [process.execPath, FAKE, "-p", "--output-format", "stream-json"],
    env: { PATH: "/usr/bin:/bin", ...env },
    cwd: dir,
    network: true,
    writable: [dir],
    readOnly: [],
    files: [{ path: join(dir, "sub", "jarvis-system.md"), content: "system" }],
    stdin,
    tty: false,
    mergeStderr: false,
    timeoutMs,
  };
}

function spawner(stopped: string[] = []) {
  return createNodeCliSpawner({
    wrap: (inv) => ({ command: inv.argv, env: inv.env }),
    unitName: () => "jarvis-account-claude-00000000",
    stopUnit: async (unit) => {
      stopped.push(unit);
    },
  });
}

async function collect(gen: AsyncGenerator<CliStreamEvent>): Promise<CliStreamEvent[]> {
  const out: CliStreamEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe("runCli with the fake CLI", () => {
  it("plays a reply through the parser and writes the invocation's files 0600", async () => {
    const inv = invocation({ FAKE_CLI_SCRIPT: fixture("claude-reply") });
    const events = await collect(
      runCli(inv, spawner(), createClaudeStream(), new AbortController().signal),
    );
    expect(events.map((e) => e.kind)).toEqual(["progress", "text", "usage"]);
    expect(readFileSync(inv.files[0]?.path as string, "utf8")).toBe("system");
  });

  it("sends a 600 KiB transcript through stdin, never argv", async () => {
    const record = join(mkdtempSync(join(tmpdir(), "jarvis-rec-")), "record.json");
    const transcript = `${"A".repeat(600 * 1024)}SECRET-TAIL`;
    const inv = invocation(
      { FAKE_CLI_SCRIPT: fixture("claude-reply"), FAKE_CLI_RECORD: record },
      transcript,
    );
    await collect(runCli(inv, spawner(), createClaudeStream(), new AbortController().signal));
    const seen = JSON.parse(readFileSync(record, "utf8"));
    expect(seen.stdinBytes).toBe(Buffer.byteLength(transcript));
    expect(seen.stdinSha256).toBe(createHash("sha256").update(transcript).digest("hex"));
    expect(JSON.stringify(seen.argv)).not.toContain("SECRET-TAIL");
    expect(seen.envKeys.filter((k: string) => k !== "__CF_USER_TEXT_ENCODING")).toEqual(
      Object.keys(inv.env).sort(),
    );
  });

  it("kills the unit on the first tripwire line", async () => {
    const stopped: string[] = [];
    const inv = invocation({ FAKE_CLI_SCRIPT: fixture("claude-init-tools"), FAKE_CLI_HANG: "1" });
    const started = Date.now();
    const events = await collect(
      runCli(inv, spawner(stopped), createClaudeStream(), new AbortController().signal),
    );
    expect(events).toEqual([
      { kind: "tripwire", reason: "claude offered its own tools: Bash, Read, WebFetch" },
    ]);
    expect(stopped).toEqual(["jarvis-account-claude-00000000"]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops the unit and throws when the turn is aborted", async () => {
    const stopped: string[] = [];
    const controller = new AbortController();
    const inv = invocation({ FAKE_CLI_HANG: "1" });
    setTimeout(() => controller.abort(new Error("stopped by user")), 200);
    await expect(
      collect(runCli(inv, spawner(stopped), createClaudeStream(), controller.signal)),
    ).rejects.toThrow("stopped by user");
    expect(stopped).toHaveLength(1);
  });

  it("times out a CLI that never finishes", async () => {
    const stopped: string[] = [];
    const inv = invocation({ FAKE_CLI_HANG: "1" }, "", 300);
    const events = await collect(
      runCli(inv, spawner(stopped), createClaudeStream(), new AbortController().signal),
    );
    expect(events).toEqual([{ kind: "error", code: "failed", detail: "timed out" }]);
    expect(stopped).toHaveLength(1);
  });

  it("reports a crash from stderr", async () => {
    const inv = invocation({
      FAKE_CLI_EXIT: "1",
      FAKE_CLI_STDERR: "Error: getaddrinfo ENOTFOUND api.anthropic.com",
    });
    const events = await collect(
      runCli(inv, spawner(), createClaudeStream(), new AbortController().signal),
    );
    expect(events).toEqual([
      {
        kind: "error",
        code: "unavailable",
        detail: "Error: getaddrinfo ENOTFOUND api.anthropic.com",
      },
    ]);
  });

  it("runOnce returns the exit code and the merged output tail", async () => {
    const inv = {
      ...invocation({
        FAKE_CLI_SCRIPT: fixture("codex-reply"),
        FAKE_CLI_EXIT: "3",
        FAKE_CLI_STDERR: "boom\n",
      }),
      mergeStderr: true,
    };
    const result = await runOnce(inv, spawner());
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("turn.completed");
    expect(result.output).toContain("boom");
  });
});
