import { describe, expect, it } from "vitest";
import type { Session } from "@jarvis/core";
import { sessionToAutoOpen } from "./session-auto-open.js";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    project: "acme",
    projectPath: "/p/acme",
    agentId: "claude-main",
    state: "running",
    summary: "",
    startedAt: 1000,
    lastActivityAt: 1000,
    ...overrides,
  };
}

describe("sessionToAutoOpen", () => {
  it("opens nothing on the first update after launch, whatever it contains", () => {
    expect(sessionToAutoOpen([], [session({ id: "s1" })], true)).toBeUndefined();
  });

  it("never opens an externally-discovered row, even after the first update", () => {
    expect(
      sessionToAutoOpen([], [session({ id: "ext-123", origin: "external" })], false),
    ).toBeUndefined();
  });

  it("opens a genuinely new Jarvis-origin session after the first update", () => {
    const fresh = session({ id: "s1", origin: "jarvis" });
    expect(sessionToAutoOpen([], [fresh], false)).toBe(fresh);
  });

  it("opens nothing when every row was already known", () => {
    const known = session({ id: "s1" });
    expect(sessionToAutoOpen([known], [known], false)).toBeUndefined();
  });

  it("opens the newest of several new rows by startedAt", () => {
    const older = session({ id: "older", startedAt: 1000 });
    const newer = session({ id: "newer", startedAt: 2000 });
    expect(sessionToAutoOpen([], [older, newer], false)).toBe(newer);
  });

  it("ignores an external row when picking the newest among several new ones", () => {
    const external = session({ id: "ext-9", startedAt: 5000, origin: "external" });
    const started = session({ id: "s2", startedAt: 1000, origin: "jarvis" });
    expect(sessionToAutoOpen([], [external, started], false)).toBe(started);
  });
});
