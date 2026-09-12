import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "@jarvis/core";
import type { Session, SessionStore } from "@jarvis/core";
import {
  isSessionTranscriptEntry,
  parseTranscript,
  summaryOf,
  createFsImportDeps,
  createSessionImporter,
  HEAD_BYTES,
  isWithin,
  resolveProject,
  sessionFromTranscript,
  transcriptDirs,
  type SessionImporterDeps,
  type TranscriptFile,
} from "./session-import.js";

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

    // join(): the directory is built with the platform's own separator.
    expect(transcriptDirs(agents, "/home/u")).toEqual([
      { agentId: "claude-x", dir: join("/home/u/.claude-x", "projects"), format: "claude" },
    ]);
  });

  // Copilot writes a session per directory, with its metadata in
  // workspace.yaml — a second format, which is why the source now says
  // which one it is rather than assuming.
  it("maps a github agent to Copilot's session-state directory", () => {
    const agents: AgentConfig[] = [
      { id: "copilot", command: "copilot", vendor: "github", configDir: "/home/u/.copilot" },
    ];

    expect(transcriptDirs(agents, "/home/u")).toEqual([
      { agentId: "copilot", dir: join("/home/u/.copilot", "session-state"), format: "copilot" },
    ]);
  });

  // The whole of first run: a machine that has just installed Jarvis has a
  // config naming an agent and nothing else, and both CLIs keep their
  // history exactly where they always do. Requiring configDir meant a fresh
  // install imported nothing at all while the transcripts sat right there.
  it("falls back to each vendor's own home when no configDir is set", () => {
    const agents: AgentConfig[] = [
      { id: "claude", command: "claude", vendor: "anthropic" },
      { id: "copilot", command: "copilot", vendor: "github" },
    ];

    expect(transcriptDirs(agents, "/home/u")).toEqual([
      { agentId: "claude", dir: join("/home/u/.claude", "projects"), format: "claude" },
      { agentId: "copilot", dir: join("/home/u/.copilot", "session-state"), format: "copilot" },
    ]);
  });

  it("skips an agent that declares no vendor at all", () => {
    expect(transcriptDirs([{ id: "c", command: "c", configDir: "/home/u/.c" }], "/home/u")).toEqual([]);
  });

  it("keeps one entry per agent when several qualify", () => {
    const agents: AgentConfig[] = [
      { id: "a", command: "a", vendor: "anthropic", configDir: "/home/u/.a" },
      { id: "b", command: "b", vendor: "anthropic", configDir: "/home/u/.b" },
    ];

    expect(transcriptDirs(agents, "/home/u").map((entry) => entry.agentId)).toEqual(["a", "b"]);
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

describe("parseTranscript", () => {
  const line = (record: unknown): string => JSON.stringify(record);

  it("returns the conversation as turns, each with its role", () => {
    const out = parseTranscript(
      [
        line({ type: "user", message: { content: "fetch all my bugs" } }),
        line({ type: "assistant", message: { content: [{ type: "text", text: "On it." }] } }),
      ].join("\n"),
    );
    expect(out).toEqual([
      { role: "user", text: "fetch all my bugs", tools: [] },
      { role: "assistant", text: "On it.", tools: [] },
    ]);
  });

  // A transcript is mostly bookkeeping — attachments, mode switches, cost
  // state — and rendering it would bury the conversation.
  it("ignores records that are not part of the conversation", () => {
    const out = parseTranscript(
      [
        line({ type: "attachment", content: "noise" }),
        line({ type: "user", message: { content: "hello" } }),
      ].join("\n"),
    );
    expect(out).toEqual([{ role: "user", text: "hello", tools: [] }]);
  });

  // Named, not dumped: which tools ran is the shape of a session, while
  // their arguments are a whole file and their output is not here at all.
  it("names the tools a turn used without their arguments", () => {
    const out = parseTranscript(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Looking." },
            { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
            { type: "tool_use", name: "Edit", input: { path: "/a" } },
          ],
        },
      }),
    );
    expect(out).toEqual([{ role: "assistant", text: "Looking.", tools: ["Bash", "Edit"] }]);
  });

  it("keeps a tool-only turn, since it still happened", () => {
    const out = parseTranscript(
      line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
    );
    expect(out).toEqual([{ role: "assistant", text: "", tools: ["Bash"] }]);
  });

  // An agent's tool calls arrive one record each, so a run of them rendered
  // as a dozen separate blocks stacked down the page with one chip apiece.
  // They are one stretch of work and read as one.
  it("folds a run of tool-only turns into the reply they belong to", () => {
    const out = parseTranscript(
      [
        line({ type: "assistant", message: { content: [{ type: "text", text: "Looking." }] } }),
        line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
        line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
      ].join("\n"),
    );
    expect(out).toEqual([{ role: "assistant", text: "Looking.", tools: ["Bash", "Read"] }]);
  });

  it("does not fold tools across the user's next turn", () => {
    const out = parseTranscript(
      [
        line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
        line({ type: "user", message: { content: "and now this" } }),
        line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
      ].join("\n"),
    );
    expect(out.map((entry) => entry.tools)).toEqual([["Bash"], [], ["Read"]]);
  });

  it("reads a slash command the way the user typed it", () => {
    const out = parseTranscript(
      line({
        type: "user",
        message: {
          content:
            "<command-name>/plan</command-name> <command-args>add a tab</command-args>",
        },
      }),
    );
    expect(out[0]?.text).toBe("/plan add a tab");
  });

  // The CLI injects content as "user" turns that nobody typed: a skill's
  // whole instruction file, a system reminder. It marks them isMeta, so they
  // are excluded by that flag rather than by matching their words. Without
  // this a skill's manual is rendered as the user's own prompt and dwarfs
  // the conversation around it.
  it("drops a turn the CLI injected rather than the user typing it", () => {
    const out = parseTranscript(
      [
        line({
          type: "user",
          isMeta: true,
          message: { content: [{ type: "text", text: "Base directory for this skill: ..." }] },
        }),
        line({ type: "user", message: { content: "what I actually asked" } }),
      ].join("\n"),
    );
    expect(out).toEqual([{ role: "user", text: "what I actually asked", tools: [] }]);
  });

  it("drops the CLI's own local-command boilerplate", () => {
    const out = parseTranscript(
      line({
        type: "user",
        message: { content: "<local-command-caveat>Caveat: ...</local-command-caveat>" },
      }),
    );
    expect(out).toEqual([]);
  });

  it("keeps newlines, which the view needs to lay a reply out", () => {
    const out = parseTranscript(
      line({ type: "assistant", message: { content: [{ type: "text", text: "a\nb" }] } }),
    );
    expect(out[0]?.text).toBe("a\nb");
  });

  it("skips a malformed line rather than losing the rest", () => {
    const out = parseTranscript(
      ["{not json", line({ type: "user", message: { content: "survived" } })].join("\n"),
    );
    expect(out).toEqual([{ role: "user", text: "survived", tools: [] }]);
  });

  it("returns nothing for a transcript with no conversation", () => {
    expect(parseTranscript(line({ type: "cost-state" }))).toEqual([]);
  });
});

describe("isSessionTranscriptEntry", () => {
  // A session transcript is projects/<escaped-cwd>/<session-id>.jsonl and
  // nothing deeper. Subagent transcripts live another two levels down and
  // carry their PARENT's sessionId and cwd, so importing one upserts onto
  // the parent's row and overwrites the user's own summary, start time and
  // model with a subagent's. Observed on real data before this guard: a
  // session's summary read "You are implementing Task 5 of a plan..." and
  // its startedAt was an hour late.
  it("accepts a transcript one level below the projects directory", () => {
    // readdir spells a recursive entry with the platform's separator.
    expect(isSessionTranscriptEntry(["-Users-me-projects-app", "abc.jsonl"].join(sep))).toBe(true);
  });

  it("rejects a subagent transcript nested under a session directory", () => {
    expect(
      isSessionTranscriptEntry("-Users-me-projects-app/abc/subagents/agent-x.jsonl"),
    ).toBe(false);
  });

  it("rejects a file sitting directly in the projects directory", () => {
    expect(isSessionTranscriptEntry("stray.jsonl")).toBe(false);
  });

  it("rejects anything that is not a .jsonl", () => {
    expect(isSessionTranscriptEntry("-Users-me-projects-app/notes.md")).toBe(false);
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

/** Copilot's session directory as transcriptDirs spells it — join(), so the
 *  fake's `dir === DIR` filter matches on every platform. */
const COPILOT_DIR = join("/h/.copilot", "session-state");

describe("createSessionImporter", () => {
  const NOW = Date.parse("2026-09-02T12:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;

  const AGENTS = [
    { id: "claude-main", command: "claude-main", vendor: "anthropic" as const, configDir: "/h/.claude-main" },
  ];
  // As transcriptDirs spells it — join(), so the fake's `dir === DIR` filter
  // matches on every platform.
  const DIR = join("/h/.claude-main", "projects");

  /** One transcript's worth of JSONL, in the shape a real one has. */
  function transcript(options: {
    id: string;
    cwd: string;
    prompt?: string;
    branch?: string;
    model?: string;
  }): string {
    const user = {
      type: "user",
      sessionId: options.id,
      cwd: options.cwd,
      gitBranch: options.branch ?? "main",
      timestamp: "2026-09-01T10:00:00.000Z",
      message: { role: "user", content: options.prompt ?? "do the thing" },
    };
    const assistant = {
      type: "assistant",
      sessionId: options.id,
      cwd: options.cwd,
      timestamp: "2026-09-01T10:00:05.000Z",
      message: { role: "assistant", model: options.model ?? "claude-opus-4-5", content: [] },
    };
    return `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`;
  }

  class FakeStore implements SessionStore {
    rows = new Map<string, Session>();
    imported: { session: Session; owned: boolean }[] = [];
    upsert(session: Session): void {
      this.rows.set(session.id, session);
    }
    upsertImported(session: Session, options: { owned: boolean }): void {
      this.imported.push({ session, owned: options.owned });
      if (!options.owned) this.rows.set(session.id, session);
    }
    history(): Session[] {
      return [...this.rows.values()];
    }
    updateGit(): void {}
  }

  /**
   * The fake world. Nothing here touches a real directory, a real file or a
   * real fs watch — the whole point of every dep being injected.
   */
  function world(
    files: Record<string, { head: string; mtime?: number; dir?: string }>,
    overrides: Partial<SessionImporterDeps> = {},
  ): {
    deps: SessionImporterDeps;
    store: FakeStore;
    listed: string[];
    fire: (file: TranscriptFile) => void;
    watched: string[];
    closed: number;
  } {
    const store = new FakeStore();
    const listed: string[] = [];
    const watched: string[] = [];
    const watchers: ((file: TranscriptFile) => void)[] = [];
    const state = { closed: 0 };

    const deps: SessionImporterDeps = {
      listFiles: async (dir, _format) => {
        listed.push(dir);
        return Object.entries(files)
          .filter(([, file]) => (file.dir ?? DIR) === dir)
          .map(([path, file]) => ({ path, mtime: file.mtime ?? NOW - DAY }));
      },
      readHead: async (path) => {
        const file = files[path];
        if (file === undefined) throw new Error(`no such file: ${path}`);
        return file.head;
      },
      watch: (dir, onChange) => {
        watched.push(dir);
        watchers.push(onChange);
        return {
          close: () => {
            state.closed += 1;
          },
        };
      },
      now: () => NOW,
      store,
      home: "/h",
      ownedIds: () => new Set(),
      agents: AGENTS,
      projects: { jarvis: "/Users/u/projects/jarvis" },
      brainCwd: "/h/.config/jarvis/brain",
      importWindowDays: 30,
      ...overrides,
    };

    return {
      deps,
      store,
      listed,
      watched,
      fire: (file) => {
        for (const watcher of watchers) watcher(file);
      },
      get closed() {
        return state.closed;
      },
    };
  }

  it("imports a terminal-started session as done", async () => {
    const { deps, store } = world({
      [`${DIR}/-Users-u-work-notes/ext-1.jsonl`]: {
        head: transcript({ id: "ext-1", cwd: "/Users/u/work/notes", prompt: "rename the file" }),
        mtime: NOW - DAY,
      },
    });

    const imported = await createSessionImporter(deps).backfill();

    expect(imported).toBe(1);
    expect(store.imported).toHaveLength(1);
    expect(store.imported[0]?.owned).toBe(false);
    expect(store.imported[0]?.session).toMatchObject({
      id: "ext-1",
      // Jarvis cannot see whether a terminal session is alive — no
      // transcript is held open, and session-env directories outlive their
      // sessions — so it never claims one is running.
      state: "done",
      project: null,
      projectPath: "/Users/u/work/notes",
      agentId: "claude-main",
      summary: "rename the file",
      branch: "main",
      lastActivityAt: NOW - DAY,
      endedAt: NOW - DAY,
    });
  });

  it("resolves a cwd inside a configured project", async () => {
    const { deps, store } = world({
      [`${DIR}/-Users-u-projects-jarvis/in-1.jsonl`]: {
        head: transcript({ id: "in-1", cwd: "/Users/u/projects/jarvis/packages/core" }),
      },
    });

    await createSessionImporter(deps).backfill();

    expect(store.imported[0]?.session.project).toBe("jarvis");
  });

  // By path, not by a directory name: the exclusion is "this is the brain's
  // own session", and a name rule stops working silently the day brain.cwd
  // is configured elsewhere.
  it("skips a transcript whose cwd is under the brain's cwd", async () => {
    const { deps, store } = world({
      [`${DIR}/-brain/brain-1.jsonl`]: {
        head: transcript({ id: "brain-1", cwd: "/h/.config/jarvis/brain" }),
      },
      [`${DIR}/-real/real-1.jsonl`]: {
        head: transcript({ id: "real-1", cwd: "/Users/u/work/notes" }),
      },
    });

    const imported = await createSessionImporter(deps).backfill();

    expect(imported).toBe(1);
    expect(store.imported.map((entry) => entry.session.id)).toEqual(["real-1"]);
  });

  it("keeps the pty authoritative for a session SessionManager owns", async () => {
    const { deps, store } = world(
      {
        [`${DIR}/-p/live-1.jsonl`]: {
          head: transcript({ id: "live-1", cwd: "/Users/u/projects/jarvis" }),
        },
      },
      { ownedIds: () => new Set(["live-1"]) },
    );

    await createSessionImporter(deps).backfill();

    expect(store.imported[0]?.owned).toBe(true);
  });

  it("skips one malformed file and still imports the rest", async () => {
    const { deps, store } = world({
      [`${DIR}/-a/a.jsonl`]: { head: transcript({ id: "a", cwd: "/Users/u/a" }) },
      [`${DIR}/-b/b.jsonl`]: { head: "{not json at all\n" },
      [`${DIR}/-c/c.jsonl`]: { head: transcript({ id: "c", cwd: "/Users/u/c" }) },
    });

    const imported = await createSessionImporter(deps).backfill();

    expect(imported).toBe(2);
    expect(store.imported.map((entry) => entry.session.id).sort()).toEqual(["a", "c"]);
  });

  it("ignores a transcript older than the import window", async () => {
    const { deps, store } = world({
      [`${DIR}/-old/old.jsonl`]: {
        head: transcript({ id: "old", cwd: "/Users/u/a" }),
        mtime: NOW - 31 * DAY,
      },
      [`${DIR}/-new/new.jsonl`]: {
        head: transcript({ id: "new", cwd: "/Users/u/b" }),
        mtime: NOW - 29 * DAY,
      },
    });

    await createSessionImporter(deps).backfill();

    expect(store.imported.map((entry) => entry.session.id)).toEqual(["new"]);
  });

  it("never reads a file that is not a transcript", async () => {
    const read: string[] = [];
    const { deps, store } = world(
      {
        [`${DIR}/-a/notes.json`]: { head: "{}" },
        [`${DIR}/-a/a.jsonl`]: { head: transcript({ id: "a", cwd: "/Users/u/a" }) },
      },
    );
    const inner = deps.readHead;
    deps.readHead = async (path) => {
      read.push(path);
      return inner(path);
    };

    await createSessionImporter(deps).backfill();

    expect(read).toEqual([`${DIR}/-a/a.jsonl`]);
    expect(store.imported).toHaveLength(1);
  });

  it("imports a transcript the watcher reports after backfill", async () => {
    const files: Record<string, { head: string; mtime?: number }> = {};
    const setup = world(files);
    const importer = createSessionImporter(setup.deps);
    await importer.start();

    files[`${DIR}/-late/late.jsonl`] = {
      head: transcript({ id: "late", cwd: "/Users/u/late" }),
      mtime: NOW,
    };
    setup.fire({ path: `${DIR}/-late/late.jsonl`, mtime: NOW });
    // The watch callback is fire-and-forget; let its promise settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(setup.store.imported.map((entry) => entry.session.id)).toEqual(["late"]);
    expect(setup.watched).toEqual([DIR]);
  });

  it("keeps what it backfilled when the watch cannot be established", async () => {
    const logged: string[] = [];
    const { deps, store } = world(
      {
        [`${DIR}/-a/a.jsonl`]: { head: transcript({ id: "a", cwd: "/Users/u/a" }) },
      },
      {
        watch: () => {
          throw new Error("too many open files");
        },
        log: (message) => logged.push(message),
      },
    );

    await expect(createSessionImporter(deps).start()).resolves.toBe(1);
    expect(store.imported).toHaveLength(1);
    expect(logged).toHaveLength(1);
  });

  it("survives a listFiles that rejects for one agent", async () => {
    const { deps, store } = world(
      {
        [`/h/.claude-two/projects/-a/a.jsonl`]: {
          head: transcript({ id: "a", cwd: "/Users/u/a" }),
          dir: join("/h/.claude-two", "projects"),
        },
      },
      {
        agents: [
          ...AGENTS,
          { id: "claude-two", command: "claude-two", vendor: "anthropic", configDir: "/h/.claude-two" },
        ],
      },
    );
    const inner = deps.listFiles;
    deps.listFiles = async (dir, format) => {
      if (dir === DIR) throw new Error("ENOENT");
      return inner(dir, format);
    };

    const imported = await createSessionImporter(deps).backfill();

    expect(imported).toBe(1);
    expect(store.imported[0]?.session.agentId).toBe("claude-two");
  });

  // Copilot's own directory, in its own format. It used to be skipped
  // outright, which is why a machine with 122 Copilot sessions on it showed
  // none of them in the table.
  it("imports a Copilot session from its workspace.yaml", async () => {
    const { deps, store } = world(
      {
        [join(COPILOT_DIR, "abc-123", "workspace.yaml")]: {
          dir: COPILOT_DIR,
          head: [
            "id: abc-123",
            "cwd: /Users/u/projects/jarvis",
            "git_root: /Users/u/projects/jarvis",
            "branch: main",
            "name: |-",
            "  add the importer",
            "created_at: 2026-09-05T10:00:00.000Z",
            "updated_at: 2026-09-05T10:20:00.000Z",
          ].join("\n"),
        },
      },
      { agents: [{ id: "copilot", command: "copilot", vendor: "github", configDir: "/h/.copilot" }] },
    );

    const imported = await createSessionImporter(deps).backfill();

    expect(imported).toBe(1);
    const row = store.imported[0]?.session;
    expect(row?.agentId).toBe("copilot");
    expect(row?.id).toBe("abc-123");
    expect(row?.project).toBe("jarvis");
    expect(row?.branch).toBe("main");
    expect(row?.summary).toBe("add the importer");
    // No model in workspace.yaml, and none invented from anywhere else.
    expect(row?.model).toBeUndefined();
  });

  // The majority shape on a real machine, not an edge case: of 122 sessions
  // measured, 48 had no `name` key and 71 no `branch`. Both are absences to
  // record as such, never reasons to drop the row.
  it("imports a Copilot session that names neither a title nor a branch", async () => {
    const { deps, store } = world(
      {
        [join(COPILOT_DIR, "bare-1", "workspace.yaml")]: {
          dir: COPILOT_DIR,
          head: [
            "id: bare-1",
            "cwd: /Users/u/projects/jarvis",
            "client_name: sdk",
            "created_at: 2026-09-05T10:00:00.000Z",
            "updated_at: 2026-09-05T10:05:00.000Z",
          ].join("\n"),
        },
      },
      { agents: [{ id: "copilot", command: "copilot", vendor: "github", configDir: "/h/.copilot" }] },
    );

    const imported = await createSessionImporter(deps).backfill();

    expect(imported).toBe(1);
    expect(store.imported[0]?.session.summary).toBe("");
    expect(store.imported[0]?.session.branch).toBe("");
  });

  // Copilot is often run in a scratch checkout; those are still sessions,
  // they just belong to no configured project.
  it("keeps a Copilot session whose cwd is no project of ours", async () => {
    const { deps, store } = world(
      {
        [join(COPILOT_DIR, "tmp-1", "workspace.yaml")]: {
          dir: COPILOT_DIR,
          head: [
            "id: tmp-1",
            "cwd: /var/folders/tr/x/T/scratch",
            "branch: main",
            "name: poke at something",
            "created_at: 2026-09-05T10:00:00.000Z",
            "updated_at: 2026-09-05T10:00:30.000Z",
          ].join("\n"),
        },
      },
      { agents: [{ id: "copilot", command: "copilot", vendor: "github", configDir: "/h/.copilot" }] },
    );

    await createSessionImporter(deps).backfill();

    expect(store.imported[0]?.session.project).toBeNull();
  });

  it("closes every watcher on stop", async () => {
    const setup = world({});
    const importer = createSessionImporter(setup.deps);
    await importer.start();

    importer.stop();

    expect(setup.closed).toBe(1);
  });
});

describe("createFsImportDeps", () => {
  // The importer's own tests inject fakes; these cover the two properties
  // of the real implementation that can be asserted without reading
  // anything of the user's — never their real ~/.claude* directories.
  it("bounds a head read", () => {
    // The whole reason a 40MB transcript costs what a 4KB one costs.
    expect(HEAD_BYTES).toBeLessThanOrEqual(64 * 1024);
    expect(HEAD_BYTES).toBeGreaterThan(0);
  });

  it("yields nothing for a directory that does not exist", async () => {
    // A configured configDir that was never created is the ordinary case
    // for a freshly configured agent; it must contribute nothing rather
    // than take the scan down. This path is never created by this test.
    const { listFiles } = createFsImportDeps();

    await expect(listFiles("/nonexistent-jarvis-session-import-test", "claude")).resolves.toEqual([]);
  });

  it("reads nothing from a file that does not exist", async () => {
    const { readHead } = createFsImportDeps();

    await expect(readHead("/nonexistent-jarvis-session-import-test/a.jsonl")).rejects.toThrow();
  });
});
