import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "@jarvis/core";
import { isWithin, resolveProject, sessionFromTranscript, transcriptDirs } from "./session-import.js";

// Record shapes copied from a real transcript (message bodies shortened,
// every field this parser reads left exactly as Claude Code writes it), so
// the fixture cannot drift into describing a format nothing produces.
const HEAD = readFileSync(
  fileURLToPath(new URL("./__fixtures__/transcript-head.jsonl", import.meta.url)),
  "utf8",
);

// The escaped directory name is never parsed — a dash in it could be a
// path separator or a literal dash — so the paths in these tests are
// deliberately unhelpful about the cwd.
const PATH = "/c/projects/-Users-u-projects-jarvis/11111111-2222-3333-4444-555555555555.jsonl";

describe("transcriptDirs", () => {
  it("maps an anthropic agent's configDir to its projects directory", () => {
    const agents: AgentConfig[] = [
      { id: "claude-x", command: "claude-x", vendor: "anthropic", configDir: "/home/u/.claude-x" },
    ];

    expect(transcriptDirs(agents)).toEqual([
      { agentId: "claude-x", dir: "/home/u/.claude-x/projects" },
    ]);
  });

  // v1 is Anthropic-only on purpose: Copilot keeps its sessions in another
  // format entirely, and one importer serving both with exactly one of them
  // written would be an abstraction built on a sample of one.
  it("skips an agent of another vendor", () => {
    const agents: AgentConfig[] = [
      { id: "copilot", command: "copilot", vendor: "github", configDir: "/home/u/.copilot" },
    ];

    expect(transcriptDirs(agents)).toEqual([]);
  });

  it("skips an anthropic agent with no configDir", () => {
    expect(transcriptDirs([{ id: "c", command: "c", vendor: "anthropic" }])).toEqual([]);
  });

  it("skips an agent that declares no vendor at all", () => {
    expect(transcriptDirs([{ id: "c", command: "c", configDir: "/home/u/.c" }])).toEqual([]);
  });

  it("keeps one entry per agent when several qualify", () => {
    const agents: AgentConfig[] = [
      { id: "a", command: "a", vendor: "anthropic", configDir: "/home/u/.a" },
      { id: "b", command: "b", vendor: "anthropic", configDir: "/home/u/.b" },
    ];

    expect(transcriptDirs(agents).map((entry) => entry.agentId)).toEqual(["a", "b"]);
  });
});

describe("resolveProject", () => {
  const projects = {
    acme: "/Users/u/projects/acme",
    app: "/Users/u/projects/acme/app",
    jarvis: "/Users/u/projects/jarvis",
  };

  it("returns the project for an exact cwd", () => {
    expect(resolveProject("/Users/u/projects/jarvis", projects)).toBe("jarvis");
  });

  // Prefix, not equality: a session started in acme/app belongs to
  // acme by any reasonable reading, and equality would file it under
  // nothing at all.
  it("returns the containing project for a cwd in a subdirectory", () => {
    expect(resolveProject("/Users/u/projects/acme/packages/core", projects)).toBe("acme");
  });

  it("prefers the longest prefix when two configured projects nest", () => {
    expect(resolveProject("/Users/u/projects/acme/app/src", projects)).toBe("app");
  });

  // The dominant case, and not an error: most work happens in directories
  // nobody declared, and such a row is still worth having.
  it("returns null — not a wrong project — for an unrelated cwd", () => {
    expect(resolveProject("/Users/u/scratch", projects)).toBeNull();
  });

  it("does not match a sibling whose name merely starts the same", () => {
    expect(resolveProject("/Users/u/projects/jarvis-notes", projects)).toBeNull();
  });

  it("returns null when nothing is configured", () => {
    expect(resolveProject("/Users/u/projects/jarvis", {})).toBeNull();
  });

  it("ignores a trailing separator on a configured path", () => {
    expect(resolveProject("/Users/u/work/site/src", { site: "/Users/u/work/site/" })).toBe("site");
  });
});

describe("isWithin", () => {
  it("is true for the directory itself", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
  });

  it("is true for a descendant", () => {
    expect(isWithin("/a/b/c", "/a/b")).toBe(true);
  });

  // The reason this is not a bare startsWith: "/a/bc".startsWith("/a/b") is
  // true, and they are unrelated directories. Both the project match and
  // the brain exclusion depend on getting this right.
  it("is false for a sibling with a shared name prefix", () => {
    expect(isWithin("/a/bc", "/a/b")).toBe(false);
  });

  it("is false for an ancestor", () => {
    expect(isWithin("/a", "/a/b")).toBe(false);
  });
});

describe("sessionFromTranscript", () => {
  it("reads a session out of a transcript head", () => {
    expect(sessionFromTranscript(HEAD, PATH, 1_700_000_000_000)).toEqual({
      id: "11111111-2222-3333-4444-555555555555",
      cwd: "/Users/u/projects/jarvis",
      model: "claude-opus-4-5-20260101",
      branch: "main",
      startedAt: Date.parse("2026-09-01T10:00:00.000Z"),
      // From the file's mtime, never a tail-read: that is what makes a 40MB
      // transcript cost what a 4KB one costs.
      lastActivityAt: 1_700_000_000_000,
      summary: "add a cluster tab",
    });
  });

  it("takes the summary from the first user prompt and stops there", () => {
    const later =
      HEAD +
      '{"type":"user","sessionId":"11111111-2222-3333-4444-555555555555","cwd":"/Users/u/projects/jarvis","timestamp":"2026-09-01T10:01:00.000Z","message":{"role":"user","content":"second prompt"}}\n';

    expect(sessionFromTranscript(later, PATH, 1)?.summary).toBe("add a cluster tab");
  });

  it("skips a tool result masquerading as a user turn", () => {
    const toolResult =
      '{"type":"user","sessionId":"s","cwd":"/c","timestamp":"2026-09-01T10:00:00.000Z","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}\n';
    const prompt =
      '{"type":"user","sessionId":"s","cwd":"/c","timestamp":"2026-09-01T10:00:01.000Z","message":{"role":"user","content":"the real prompt"}}\n';

    expect(sessionFromTranscript(toolResult + prompt, PATH, 1)?.summary).toBe("the real prompt");
  });

  it("reads a prompt written as an array of content blocks", () => {
    const blocks =
      '{"type":"user","sessionId":"s","cwd":"/c","timestamp":"2026-09-01T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"blocked prompt"}]}}\n';

    expect(sessionFromTranscript(blocks, PATH, 1)?.summary).toBe("blocked prompt");
  });

  // One bad file must not cost the other 124, and a half-parsed transcript
  // would be a quietly wrong row — so the file is skipped whole.
  it("returns null for a malformed record", () => {
    expect(sessionFromTranscript('{"type":"user"}\nnot json\n', PATH, 1)).toBeNull();
  });

  it("returns null when no record carries a cwd", () => {
    // An older CLI version. cwd is the one field with no fallback: the
    // escaped directory name is ambiguous and is never parsed.
    expect(sessionFromTranscript('{"type":"summary","summary":"x"}\n', PATH, 1)).toBeNull();
  });

  it("returns null for an empty head", () => {
    expect(sessionFromTranscript("", PATH, 1)).toBeNull();
  });

  it("falls back to the file name for a transcript with no sessionId", () => {
    // The filename *is* the session id — that is exactly what --session-id
    // determines — so it is the one safe fallback.
    const line =
      '{"type":"user","cwd":"/c","timestamp":"2026-09-01T10:00:00.000Z","message":{"role":"user","content":"hi"}}\n';

    expect(sessionFromTranscript(line, "/c/projects/-c/abc-123.jsonl", 1)?.id).toBe("abc-123");
  });

  // A head read is cut mid-line by definition; a fragment is not a
  // malformed record.
  it("ignores an unterminated final line", () => {
    expect(sessionFromTranscript(HEAD + '{"type":"assis', PATH, 1)?.cwd).toBe(
      "/Users/u/projects/jarvis",
    );
  });

  it("falls back to the mtime when the timestamp is unusable", () => {
    const line =
      '{"type":"user","cwd":"/c","timestamp":"not a date","message":{"role":"user","content":"hi"}}\n';

    expect(sessionFromTranscript(line, PATH, 4242)?.startedAt).toBe(4242);
  });

  it("leaves the branch empty when no record carries one", () => {
    const line =
      '{"type":"user","cwd":"/c","timestamp":"2026-09-01T10:00:00.000Z","message":{"role":"user","content":"hi"}}\n';

    expect(sessionFromTranscript(line, PATH, 1)?.branch).toBe("");
  });

  it("has no model when no assistant record names one", () => {
    const line =
      '{"type":"user","cwd":"/c","timestamp":"2026-09-01T10:00:00.000Z","message":{"role":"user","content":"hi"}}\n';

    expect(sessionFromTranscript(line, PATH, 1)?.model).toBeNull();
  });

  it("collapses whitespace and truncates a very long prompt", () => {
    const long = "x".repeat(500);
    const line = `{"type":"user","cwd":"/c","timestamp":"2026-09-01T10:00:00.000Z","message":{"role":"user","content":"  first   line\\nsecond ${long}"}}\n`;
    const summary = sessionFromTranscript(line, PATH, 1)?.summary ?? "";

    expect(summary.startsWith("first line second")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(200);
  });

  it("keeps an Arabic prompt intact", () => {
    const line =
      '{"type":"user","cwd":"/c","timestamp":"2026-09-01T10:00:00.000Z","message":{"role":"user","content":"أصلح صفحة الدفع"}}\n';

    expect(sessionFromTranscript(line, PATH, 1)?.summary).toBe("أصلح صفحة الدفع");
  });
});
