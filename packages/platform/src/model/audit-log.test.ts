import type { AuditEntry } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { type AuditFs, auditLogPath, createAuditLog } from "./audit-log.js";

function memoryFs() {
  const files = new Map<string, string>();
  const fs: AuditFs = {
    appendFile: async (path, text) => {
      files.set(path, (files.get(path) ?? "") + text);
    },
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    size: async (path) => new TextEncoder().encode(files.get(path) ?? "").length,
    rename: async (from, to) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    mkdir: async () => {},
  };
  return { fs, files };
}

const entry = (ts: number, tool = "pkg.install"): AuditEntry => ({
  ts,
  tool,
  title: `t${ts}`,
  input: {},
  decision: "approved",
  via: "desktop",
  result: "ok",
});

describe("auditLogPath", () => {
  it("honours XDG_STATE_HOME, else ~/.local/state", () => {
    expect(auditLogPath({}, "/home/jarvis")).toBe("/home/jarvis/.local/state/jarvis/audit.jsonl");
    expect(auditLogPath({ XDG_STATE_HOME: "/var/state" }, "/home/jarvis")).toBe(
      "/var/state/jarvis/audit.jsonl",
    );
  });
});

describe("createAuditLog", () => {
  it("appends one JSON line per entry and lists newest first", async () => {
    const { fs, files } = memoryFs();
    const log = createAuditLog({ path: "/s/audit.jsonl", fs });
    await Promise.all([log.append(entry(1)), log.append(entry(2)), log.append(entry(3))]);
    expect(files.get("/s/audit.jsonl")?.trim().split("\n")).toHaveLength(3);
    expect((await log.list({ limit: 2 })).map((e) => e.ts)).toEqual([3, 2]);
    expect((await log.list({ limit: 10, beforeTs: 3 })).map((e) => e.ts)).toEqual([2, 1]);
  });

  it("skips malformed lines and answers [] with no file", async () => {
    const { fs, files } = memoryFs();
    const log = createAuditLog({ path: "/s/audit.jsonl", fs });
    await expect(log.list({ limit: 5 })).resolves.toEqual([]);
    files.set("/s/audit.jsonl", `not json\n${JSON.stringify(entry(5))}\n{"ts":"x"}\n`);
    expect((await log.list({ limit: 5 })).map((e) => e.ts)).toEqual([5]);
  });

  it("rotates past maxBytes and still lists across both files", async () => {
    const { fs, files } = memoryFs();
    const log = createAuditLog({ path: "/s/audit.jsonl", fs, maxBytes: 300 });
    for (let ts = 1; ts <= 6; ts++) await log.append(entry(ts));
    // Each line is 106 bytes, so the file holds two before it rotates; one
    // generation is kept, so entries 1 and 2 have been dropped by now.
    expect(files.has("/s/audit.jsonl.1")).toBe(true);
    expect((await log.list({ limit: 10 })).map((e) => e.ts)).toEqual([6, 5, 4, 3]);
  });
});
