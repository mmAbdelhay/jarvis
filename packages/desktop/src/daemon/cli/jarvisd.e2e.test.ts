import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MESSAGES } from "../../messages.js";
import { CLI_MESSAGES } from "./messages.js";

// The real thing: `node dist/src/daemon-main.js run` under a scratch HOME
// (never the user's ~/.config/jarvis), driven by the built jarvisd CLI as a
// user or a script would run it. Needs `pnpm build` first, like the other
// dist tests.

const WINDOWS = process.platform === "win32";
const DIST_SRC = fileURLToPath(new URL("../../../dist/src/", import.meta.url));
const DAEMON = join(DIST_SRC, "daemon-main.js");
const CLI = join(DIST_SRC, "daemon", "cli", "jarvisd.js");
const PASSWORD = "an owner password for the e2e";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scratchHome(): Promise<string> {
  // Short: the socket path under it is capped near 104 bytes on macOS.
  const home = await mkdtemp(join(WINDOWS ? tmpdir() : "/tmp", "jc-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

function env(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

function startDaemon(home: string): { child: ChildProcess; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [DAEMON, "run"], { env: env(home), stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return { child, exited };
}

type Run = { code: number | null; stdout: string; stderr: string };

function jarvisd(home: string, args: string[], input?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: env(home) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

/** `jarvisd status` until the daemon answers: its socket takes a moment. */
async function statusWhenUp(home: string): Promise<Run> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const run = await jarvisd(home, ["status"]);
    if (run.code !== 3 || Date.now() > deadline) return run;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(WINDOWS)("jarvisd CLI, end to end", () => {
  it("is built", () => {
    expect(existsSync(CLI), `${CLI} is missing: run pnpm build`).toBe(true);
  });

  it("exits 3 when no daemon runs", async () => {
    const home = await scratchHome();
    const run = await jarvisd(home, ["status"]);
    expect(run.code).toBe(3);
    expect(run.stderr.trim()).toBe(CLI_MESSAGES.notRunning("en"));
  }, 30_000);

  it("status, set-password --stdin, status again, stop", async () => {
    const home = await scratchHome();
    const daemon = startDaemon(home);

    const before = await statusWhenUp(home);
    expect(before).toMatchObject({ code: 0, stderr: "" });
    expect(before.stdout).toContain(CLI_MESSAGES.daemonRunning("en"));
    expect(before.stdout).toContain(MESSAGES.remoteOwnerNoPassword("en"));

    // A pipe is not a terminal: without --stdin it is refused, untouched.
    const refused = await jarvisd(home, ["set-password"], `${PASSWORD}\n`);
    expect(refused.code).toBe(2);
    expect(refused.stderr.trim()).toBe(CLI_MESSAGES.needsTerminal("en"));

    const set = await jarvisd(home, ["set-password", "--stdin"], `${PASSWORD}\n`);
    expect(set).toMatchObject({ code: 0, stderr: "" });
    expect(set.stdout.trim()).toBe(MESSAGES.remoteOwnerSaved("en"));

    const after = await jarvisd(home, ["status"]);
    expect(after.code).toBe(0);
    expect(after.stdout).toContain(MESSAGES.remoteOwnerHasPassword("en"));

    // Changing it needs the current one first.
    const wrong = await jarvisd(home, ["set-password", "--stdin"], `not it\n${PASSWORD}2\n`);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr.trim()).toBe(MESSAGES.remoteOwnerError("current-wrong", "en"));

    const devices = await jarvisd(home, ["devices"]);
    expect(devices).toMatchObject({ code: 0 });
    expect(devices.stdout.trim()).toBe(MESSAGES.remoteNoDevices("en"));

    const stop = await jarvisd(home, ["stop"]);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain(CLI_MESSAGES.stopped("en"));
    await expect(daemon.exited).resolves.toBe(0);
    expect((await jarvisd(home, ["status"])).code).toBe(3);

    const output = [before, refused, set, after, wrong, devices, stop]
      .map((run) => run.stdout + run.stderr)
      .join("\n");
    expect(output).not.toContain(PASSWORD);
    const log = readFileSync(join(home, ".config", "jarvis", "logs", "jarvisd.log"), "utf8");
    expect(log).not.toContain(PASSWORD);
  }, 90_000);
});
