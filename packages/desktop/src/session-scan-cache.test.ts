import { describe, expect, it } from "vitest";
import type { Session } from "@jarvis/core";
import { parseScan, serializeScan } from "./session-scan-cache.js";

function externalSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ext-123",
    project: "acme",
    projectPath: "/home/u/acme",
    agentId: "claude",
    state: "running",
    summary: "running outside Jarvis",
    startedAt: 1000,
    lastActivityAt: 2000,
    origin: "external",
    pid: 123,
    ...overrides,
  };
}

describe("serializeScan / parseScan round trip", () => {
  it("parses back exactly the external rows it serialized", () => {
    const rows = [
      externalSession({ id: "ext-1" }),
      externalSession({ id: "ext-2", transcriptPath: "/home/u/.claude/t.jsonl", pid: undefined }),
    ];

    expect(parseScan(serializeScan(rows))).toEqual(rows.map((r) => ({ ...r })));
  });

  it("round-trips a row with no transcriptPath and no pid", () => {
    const row = externalSession({ pid: undefined });
    delete (row as { pid?: number }).pid;

    expect(parseScan(serializeScan([row]))).toEqual([row]);
  });
});

describe("serializeScan", () => {
  it("drops non-external rows — Jarvis's own sessions are not this cache's job", () => {
    const jarvisRow: Session = {
      id: "s1",
      project: "acme",
      projectPath: "/home/u/acme",
      agentId: "claude",
      state: "running",
      summary: "a real session",
      startedAt: 1,
      lastActivityAt: 2,
      origin: "jarvis",
    };
    expect(serializeScan([jarvisRow, externalSession()])).toEqual(
      JSON.stringify({ version: 1, sessions: [externalSession()] }),
    );
  });
});

describe("parseScan", () => {
  it("returns [] for garbage that is not JSON at all", () => {
    expect(parseScan("not json { at all")).toEqual([]);
  });

  it("returns [] for well-formed JSON that is not the expected shape", () => {
    expect(parseScan("[]")).toEqual([]);
    expect(parseScan("null")).toEqual([]);
    expect(parseScan('{"sessions": "not an array"}')).toEqual([]);
    expect(parseScan("{}")).toEqual([]);
  });

  it("drops a row missing a required field", () => {
    const bad = externalSession() as Partial<Session>;
    delete bad.projectPath;
    const text = JSON.stringify({ version: 1, sessions: [bad] });

    expect(parseScan(text)).toEqual([]);
  });

  it("drops a row with the wrong type for a required field", () => {
    const bad = { ...externalSession(), startedAt: "not a number" };
    const text = JSON.stringify({ version: 1, sessions: [bad] });

    expect(parseScan(text)).toEqual([]);
  });

  it("drops a row with an unrecognised state", () => {
    const bad = { ...externalSession(), state: "not-a-real-state" };
    const text = JSON.stringify({ version: 1, sessions: [bad] });

    expect(parseScan(text)).toEqual([]);
  });

  it("drops rows that are not origin: external, keeping the rest", () => {
    const jarvisRow = { ...externalSession(), id: "s1", origin: "jarvis" };
    const noOrigin = { ...externalSession(), id: "s2" };
    delete (noOrigin as { origin?: string }).origin;
    const keep = externalSession({ id: "ext-3" });
    const text = JSON.stringify({ version: 1, sessions: [jarvisRow, noOrigin, keep] });

    expect(parseScan(text)).toEqual([keep]);
  });

  it("drops one bad row but keeps the well-formed ones beside it", () => {
    const good = externalSession({ id: "ext-1" });
    const bad = { id: "ext-2" };
    const text = JSON.stringify({ version: 1, sessions: [good, bad] });

    expect(parseScan(text)).toEqual([good]);
  });
});
