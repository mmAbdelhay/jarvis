import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "release-sums.mjs");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("release-sums", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "release-sums-"));
    writeFileSync(join(dir, "b.AppImage"), "linux build");
    writeFileSync(join(dir, "a.dmg"), "mac build");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prints sha256sum lines, bare basenames, sorted by name", () => {
    const out = execFileSync(
      process.execPath,
      [script, join(dir, "b.AppImage"), join(dir, "a.dmg")],
      { encoding: "utf8" },
    );
    expect(out).toBe(`${sha("mac build")}  a.dmg\n${sha("linux build")}  b.AppImage\n`);
  });

  it("writes the same text to --out", () => {
    const out = join(dir, "SHA256SUMS");
    execFileSync(process.execPath, [script, "--out", out, join(dir, "a.dmg")]);
    expect(readFileSync(out, "utf8")).toBe(`${sha("mac build")}  a.dmg\n`);
  });

  it("fails on a missing file and writes nothing", () => {
    const out = join(dir, "SHA256SUMS");
    const result = spawnSync(process.execPath, [
      script,
      "--out",
      out,
      join(dir, "a.dmg"),
      join(dir, "missing.apk"),
    ]);
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(out)).toThrow();
  });

  it("fails on two files with the same name and writes nothing", () => {
    const out = join(dir, "SHA256SUMS");
    mkdirSync(join(dir, "other"));
    writeFileSync(join(dir, "other", "a.dmg"), "another mac build");
    const result = spawnSync(process.execPath, [
      script,
      "--out",
      out,
      join(dir, "a.dmg"),
      join(dir, "other", "a.dmg"),
    ]);
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toContain("a.dmg");
    expect(() => readFileSync(out)).toThrow();
  });

  it("fails with no files", () => {
    expect(spawnSync(process.execPath, [script]).status).not.toBe(0);
  });
});
