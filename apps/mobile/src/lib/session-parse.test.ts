// M12 Task 8: session-parse.ts's `parseSession` replaces three duplicate
// parsers (history-store.ts, sessions-store.ts, dashboard-store.ts) — this
// file carries the union of the rows those three used to check
// individually, plus a source scan proving no other copy of the function
// exists.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSession } from "./session-parse";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, "..");

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) files.push(full);
  }
  return files;
}

function fullSession(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "s1",
    project: "acme",
    projectPath: "/Users/x/acme",
    agentId: "claude-main",
    state: "running",
    summary: "fixing tests",
    startedAt: 10,
    lastActivityAt: 100,
    ...overrides,
  };
}

describe("parseSession", () => {
  it("parses a well-formed session, field by field", () => {
    expect(parseSession(fullSession())).toEqual({
      id: "s1",
      project: "acme",
      projectPath: "/Users/x/acme",
      agentId: "claude-main",
      state: "running",
      summary: "fixing tests",
      startedAt: 10,
      lastActivityAt: 100,
    });
  });

  it("never copies extra/unexpected fields through (no spread)", () => {
    const session = parseSession(fullSession({ extra: "nope", another: 1 }));
    expect(session).toBeDefined();
    expect(Object.keys(session as object).sort()).toEqual(
      [
        "id",
        "project",
        "projectPath",
        "agentId",
        "state",
        "summary",
        "startedAt",
        "lastActivityAt",
      ].sort(),
    );
  });

  it("accepts a null project (a session belonging to no configured project)", () => {
    expect(parseSession(fullSession({ project: null }))?.project).toBeNull();
  });

  it("keeps every optional field when present and finite/string", () => {
    const session = parseSession(
      fullSession({
        model: "opus",
        endedAt: 200,
        exitCode: 0,
        transcriptPath: "/tmp/t.jsonl",
        branch: "main",
        insertions: 3,
        deletions: 1,
        changedFiles: 2,
      }),
    );
    expect(session).toEqual({
      id: "s1",
      project: "acme",
      projectPath: "/Users/x/acme",
      agentId: "claude-main",
      state: "running",
      summary: "fixing tests",
      startedAt: 10,
      lastActivityAt: 100,
      model: "opus",
      endedAt: 200,
      exitCode: 0,
      transcriptPath: "/tmp/t.jsonl",
      branch: "main",
      insertions: 3,
      deletions: 1,
      changedFiles: 2,
    });
  });

  it("keeps origin/pid when present and well-typed", () => {
    const session = parseSession(fullSession({ origin: "external", pid: 1234 }));
    expect(session?.origin).toBe("external");
    expect(session?.pid).toBe(1234);
  });

  it("drops an unknown origin value and a non-finite pid", () => {
    const session = parseSession(fullSession({ origin: "robot", pid: Number.NaN }));
    expect(session?.origin).toBeUndefined();
    expect(session?.pid).toBeUndefined();
  });

  it("drops a non-finite/wrong-typed optional field rather than failing the whole row", () => {
    const session = parseSession(
      fullSession({ endedAt: Number.NaN, exitCode: "0", insertions: Number.POSITIVE_INFINITY }),
    );
    expect(session?.endedAt).toBeUndefined();
    expect(session?.exitCode).toBeUndefined();
    expect(session?.insertions).toBeUndefined();
  });

  it("refuses a non-object value", () => {
    expect(parseSession(undefined)).toBeUndefined();
    expect(parseSession(null)).toBeUndefined();
    expect(parseSession("s1")).toBeUndefined();
    expect(parseSession(42)).toBeUndefined();
  });

  it("refuses a missing/wrong-typed required field, one at a time", () => {
    expect(parseSession(fullSession({ id: 5 }))).toBeUndefined();
    expect(parseSession(fullSession({ project: 5 }))).toBeUndefined();
    expect(parseSession(fullSession({ projectPath: undefined }))).toBeUndefined();
    expect(parseSession(fullSession({ agentId: undefined }))).toBeUndefined();
    expect(parseSession(fullSession({ summary: undefined }))).toBeUndefined();
    expect(parseSession(fullSession({ startedAt: undefined }))).toBeUndefined();
    expect(parseSession(fullSession({ startedAt: Number.NaN }))).toBeUndefined();
    expect(parseSession(fullSession({ lastActivityAt: undefined }))).toBeUndefined();
    expect(parseSession(fullSession({ lastActivityAt: Number.POSITIVE_INFINITY }))).toBeUndefined();
  });

  it("refuses a state outside the known set", () => {
    expect(parseSession(fullSession({ state: "zombie" }))).toBeUndefined();
    expect(parseSession(fullSession({ state: 1 }))).toBeUndefined();
  });

  it("accepts every known state", () => {
    for (const state of ["starting", "running", "waiting", "done", "dead"]) {
      expect(parseSession(fullSession({ state }))?.state).toBe(state);
    }
  });

  it(
    "source scan: no other function named parseSession exists under apps/mobile/src " +
      "[bite-proof: reintroduce a duplicate private parseSession in another store " +
      "and this test names it]",
    () => {
      const offenders: string[] = [];
      for (const file of collectSourceFiles(SRC_ROOT)) {
        if (file.endsWith(`${join("lib", "session-parse.ts")}`)) continue;
        if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
        const text = readFileSync(file, "utf8");
        if (/\bfunction\s+parseSession\s*\(/.test(text)) offenders.push(file);
      }
      expect(offenders, `duplicate parseSession found in: ${offenders.join(", ")}`).toEqual([]);
    },
  );
});
