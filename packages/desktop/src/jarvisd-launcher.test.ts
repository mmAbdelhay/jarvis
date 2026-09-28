import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The `jarvisd` launchers in packages/desktop/bin, shipped at <resources>/bin
// (electron-builder.yml extraResources). Each finds the Jarvis binary it was
// shipped with and runs the CLI script inside app.asar with
// ELECTRON_RUN_AS_NODE=1 — the packaged form jarvisd.ts documents. These run
// the shell launcher against a fake bundle whose "Jarvis binary" prints what
// it was given.

const WINDOWS = process.platform === "win32";
const SCRIPT = ["app.asar", "dist", "src", "daemon", "cli", "jarvisd.js"];

let scratch: string | undefined;
afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A fake binary: prints the env flag, then each argument on its own line. */
const FAKE_BINARY = `#!/bin/sh
printf 'RUN_AS_NODE=%s\\n' "$ELECTRON_RUN_AS_NODE"
for a in "$@"; do printf '%s\\n' "$a"; done
exit 7
`;

/** Lays out a bundle: `binary` relative to Resources, and bin/jarvisd. */
async function bundle(binary: string): Promise<{ resources: string; launcher: string }> {
  scratch = await mkdtemp(join(tmpdir(), "jarvisd-launcher-"));
  const resources = join(scratch, "App", "Resources");
  await mkdir(join(resources, "bin"), { recursive: true });
  const binaryPath = join(resources, binary);
  await mkdir(join(binaryPath, ".."), { recursive: true });
  await writeFile(binaryPath, FAKE_BINARY);
  await chmod(binaryPath, 0o755);
  const launcher = join(resources, "bin", "jarvisd");
  await copyFile("packages/desktop/bin/jarvisd", launcher);
  await chmod(launcher, 0o755);
  return { resources, launcher };
}

function run(
  file: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(file, args, { env }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });
}

describe.skipIf(WINDOWS)("bin/jarvisd", () => {
  it("runs the CLI script in app.asar with the macOS binary, passing every argument through", async () => {
    const { resources, launcher } = await bundle(join("..", "MacOS", "Jarvis"));
    const result = await run(launcher, ["revoke", "--", "id with spaces"]);

    expect(result.code).toBe(7);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("RUN_AS_NODE=1");
    expect(lines[1]).toBe(join(await realpath(resources), ...SCRIPT));
    expect(lines.slice(2)).toEqual(["revoke", "--", "id with spaces"]);
  });

  it("finds the Linux binary beside resources/", async () => {
    const { launcher } = await bundle(join("..", "jarvis"));
    const result = await run(launcher, ["status"]);

    expect(result.code).toBe(7);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("status");
  });

  it("resolves itself through a symlink on PATH", async () => {
    const { resources, launcher } = await bundle(join("..", "MacOS", "Jarvis"));
    const onPath = join(scratch ?? "", "path-bin");
    await mkdir(onPath);
    await symlink(launcher, join(onPath, "jarvisd"));

    const result = await run(join(onPath, "jarvisd"), ["status"]);

    expect(result.code).toBe(7);
    expect(result.stdout.split("\n")[1]).toBe(join(await realpath(resources), ...SCRIPT));
  });

  it("fails with exit 1 and says so when no Jarvis binary is beside it", async () => {
    const { launcher } = await bundle(join("..", "elsewhere", "Nope"));
    const result = await run(launcher, ["status"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("jarvisd:");
  });
});

describe("bin/jarvisd.cmd", () => {
  it("runs the CLI script in app.asar with Jarvis.exe, passing every argument and the exit code through", async () => {
    const text = await readFile("packages/desktop/bin/jarvisd.cmd", "utf8");
    expect(text).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(text).toContain('"%~dp0..\\..\\Jarvis.exe"');
    expect(text).toContain('"%~dp0..\\app.asar\\dist\\src\\daemon\\cli\\jarvisd.js" %*');
    expect(text).toContain("exit /b %ERRORLEVEL%");
    // setlocal keeps ELECTRON_RUN_AS_NODE out of the calling console.
    expect(text).toMatch(/^@echo off\r?\nsetlocal\r?\n/);
  });
});
