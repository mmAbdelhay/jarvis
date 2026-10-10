import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeAccountFs, readOpenUrlFile, readRegularFile } from "./account-fs.js";

// FIFOs and no-follow opens are Linux-only (systemd sandbox).
const win32 = process.platform === "win32";

// Files in the account config and temp dirs are writable by the sandboxed CLI
// (threat A4), so jarvisd must never block on, follow, or slurp what it finds.
function dir(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-afs-"));
}

describe("readRegularFile", () => {
  it("reads a regular file", async () => {
    const path = join(dir(), "auth.json");
    writeFileSync(path, '{"ok":true}');
    expect(await readRegularFile(path, 1024)).toBe('{"ok":true}');
  });

  it.skipIf(win32)("refuses a FIFO at once instead of blocking", async () => {
    const path = join(dir(), "open-url");
    execFileSync("mkfifo", [path]);
    await expect(readRegularFile(path, 1024)).rejects.toThrow(/not a regular file/);
  });

  it.skipIf(win32)("refuses to follow a symlink", async () => {
    const d = dir();
    writeFileSync(join(d, "real"), "secret");
    symlinkSync(join(d, "real"), join(d, "link"));
    await expect(readRegularFile(join(d, "link"), 1024)).rejects.toThrow();
  });

  it("refuses a file larger than the cap", async () => {
    const path = join(dir(), "big");
    writeFileSync(path, "A".repeat(2048));
    await expect(readRegularFile(path, 1024)).rejects.toThrow(/too large/);
  });

  it.skipIf(win32)("is what nodeAccountFs.readText uses", async () => {
    const d = dir();
    const path = join(d, "google_accounts.json");
    execFileSync("mkfifo", [path]);
    await expect(nodeAccountFs(d).readText(path)).rejects.toThrow(/not a regular file/);
  });
});

describe("readOpenUrlFile", () => {
  it("returns the trimmed URL and removes the file", async () => {
    const path = join(dir(), "open-url");
    writeFileSync(path, " https://accounts.google.com/x \n");
    expect(await readOpenUrlFile(path)).toBe("https://accounts.google.com/x");
    expect(await readOpenUrlFile(path)).toBeUndefined();
  });

  it.skipIf(win32)("ignores a FIFO or a symlink", async () => {
    const d = dir();
    execFileSync("mkfifo", [join(d, "fifo")]);
    expect(await readOpenUrlFile(join(d, "fifo"))).toBeUndefined();
    writeFileSync(join(d, "real"), "https://accounts.google.com/x");
    symlinkSync(join(d, "real"), join(d, "link"));
    expect(await readOpenUrlFile(join(d, "link"))).toBeUndefined();
  });
});
