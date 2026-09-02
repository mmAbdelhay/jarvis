import { describe, expect, it } from "vitest";
import type { AgentConfig } from "@jarvis/core";
import { isWithin, resolveProject, transcriptDirs } from "./session-import.js";

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
