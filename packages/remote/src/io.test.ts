import { describe, expect, it } from "vitest";
import { memoryFs } from "./fs-double.js";
import {
  describeError,
  ensurePrivateDir,
  isMissing,
  tightenFileMode,
  writeFileAtomic,
} from "./io.js";
import type { RandomBytes } from "./io.js";

// A fixed, non-random RandomBytes double: writeFileAtomic's temp-file name
// is deterministic, so a test can pre-seed a collision at that exact path
// to force the "temp write fails" branch.
const FIXED_RANDOM: RandomBytes = () => Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
const FIXED_SUFFIX = FIXED_RANDOM(6).toString("hex");

describe("writeFileAtomic", () => {
  it("leaves only the target, at the given mode, with no .tmp file", async () => {
    const fs = memoryFs();
    await writeFileAtomic(fs, "/target", "hello", 0o600, FIXED_RANDOM);
    expect([...fs.files.keys()]).toEqual(["/target"]);
    expect(fs.files.get("/target")).toEqual({ data: "hello", mode: 0o600 });
  });

  it("replaces an existing file whole, not merged", async () => {
    const fs = memoryFs();
    fs.files.set("/target", { data: "old", mode: 0o600 });
    await writeFileAtomic(fs, "/target", "new", 0o600, FIXED_RANDOM);
    expect(fs.files.get("/target")).toEqual({ data: "new", mode: 0o600 });
  });

  it("leaves the old target unchanged when the temp write fails", async () => {
    const fs = memoryFs();
    fs.files.set("/target", { data: "old", mode: 0o600 });
    // Pre-seed the exact temp path writeFileAtomic will compute, so its
    // exclusive-create writeFile hits EEXIST before ever reaching rename.
    fs.files.set(`/target.${FIXED_SUFFIX}.tmp`, { data: "collision", mode: 0o600 });

    await expect(writeFileAtomic(fs, "/target", "new", 0o600, FIXED_RANDOM)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(fs.files.get("/target")).toEqual({ data: "old", mode: 0o600 });
  });

  it("leaves no .tmp file when rename fails", async () => {
    const fs = memoryFs();
    fs.files.set("/target", { data: "old", mode: 0o600 });
    fs.rename = async () => {
      throw new Error("rename failed");
    };

    await expect(writeFileAtomic(fs, "/target", "new", 0o600, FIXED_RANDOM)).rejects.toThrow(
      "rename failed",
    );
    expect([...fs.files.keys()]).toEqual(["/target"]);
    expect(fs.files.get("/target")).toEqual({ data: "old", mode: 0o600 });
  });
});

describe("ensurePrivateDir", () => {
  it("creates a fresh directory at 0700", async () => {
    const fs = memoryFs();
    await ensurePrivateDir(fs, "/dir", true);
    expect(fs.dirs.get("/dir")).toBe(0o700);
  });

  it("tightens 0755 to 0700 when enforcing", async () => {
    const fs = memoryFs();
    fs.dirs.set("/dir", 0o755);
    await ensurePrivateDir(fs, "/dir", true);
    expect(fs.dirs.get("/dir")).toBe(0o700);
  });

  it("leaves a looser mode alone when not enforcing", async () => {
    const fs = memoryFs();
    fs.dirs.set("/dir", 0o755);
    await ensurePrivateDir(fs, "/dir", false);
    expect(fs.dirs.get("/dir")).toBe(0o755);
  });
});

describe("tightenFileMode", () => {
  it("tightens 0644 to 0600", async () => {
    const fs = memoryFs();
    fs.files.set("/f", { data: "x", mode: 0o644 });
    await tightenFileMode(fs, "/f", true);
    expect(fs.files.get("/f")?.mode).toBe(0o600);
  });

  it("leaves 0600 unchanged", async () => {
    const fs = memoryFs();
    fs.files.set("/f", { data: "x", mode: 0o600 });
    await tightenFileMode(fs, "/f", true);
    expect(fs.files.get("/f")?.mode).toBe(0o600);
  });

  it("leaves a looser mode alone when not enforcing", async () => {
    const fs = memoryFs();
    fs.files.set("/f", { data: "x", mode: 0o644 });
    await tightenFileMode(fs, "/f", false);
    expect(fs.files.get("/f")?.mode).toBe(0o644);
  });
});

describe("isMissing", () => {
  it("is true for ENOENT only", () => {
    const enoent = Object.assign(new Error("nope"), { code: "ENOENT" });
    const eexist = Object.assign(new Error("nope"), { code: "EEXIST" });
    expect(isMissing(enoent)).toBe(true);
    expect(isMissing(eexist)).toBe(false);
    expect(isMissing(new Error("plain"))).toBe(false);
    expect(isMissing("not an error")).toBe(false);
    expect(isMissing(undefined)).toBe(false);
  });
});

describe("describeError", () => {
  it("uses an Error's own message, and String() for anything else", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("boom")).toBe("boom");
    expect(describeError(42)).toBe("42");
  });
});
