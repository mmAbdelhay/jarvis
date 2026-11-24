import { join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type AgentSuggestDeps, createAgentSuggest } from "./agent-suggest.js";
import type { PaneAgentSession } from "./pane-agent-session.js";

const ROOT = join("/", "work", "app");
const CONFIG = join("/", "home", "me", ".claude-acme");
const SESSION = (vendor: PaneAgentSession["vendor"] = "anthropic"): PaneAgentSession => ({
  paneKey: "t1",
  pid: 1,
  vendor,
  sessionId: "s",
  transcriptPath: join(CONFIG, "projects", "-work-app", "s.jsonl"),
  cwd: ROOT,
});

type Node = { kind: "file"; text: string } | { kind: "dir" } | { kind: "link"; to: string };

function setup(
  tree: Record<string, Node>,
  options: {
    git?: string[] | undefined;
    vendor?: PaneAgentSession["vendor"];
    now?: () => number;
  } = {},
) {
  const entries = (dir: string): string[] =>
    Object.keys(tree)
      .filter((path) => {
        if (path === dir || !path.startsWith(`${dir}${sep}`)) return false;
        return !path.slice(dir.length + 1).includes(sep);
      })
      .map((path) => path.slice(dir.length + 1));
  const git = vi.fn(async () => (options.git === undefined ? undefined : options.git.join("\0")));
  const deps: AgentSuggestDeps = {
    sessions: {
      session: vi.fn(async (paneKey: string) =>
        paneKey === "t1" ? SESSION(options.vendor) : undefined,
      ),
      live: vi.fn((paneKey: unknown) => paneKey === "t1"),
    },
    fs: {
      readdir: vi.fn(async (dir: string) => {
        const names = entries(dir);
        if (!(dir in tree) && names.length === 0) throw new Error("ENOENT");
        return names.map((name) => {
          const node = tree[join(dir, name)];
          return {
            name,
            isDirectory: node?.kind === "dir",
            isFile: node?.kind === "file",
            isSymlink: node?.kind === "link",
          };
        });
      }),
      readHead: vi.fn(async (path: string, bytes: number) => {
        const node = tree[path];
        if (node?.kind !== "file") throw new Error("ENOENT");
        return node.text.slice(0, bytes);
      }),
      realpath: vi.fn(async (path: string) => {
        const node = tree[path];
        if (node?.kind === "link") return node.to;
        if (node === undefined) throw new Error("ENOENT");
        return path;
      }),
      isFile: vi.fn(async (path: string) => tree[path]?.kind === "file"),
    },
    git,
    now: options.now ?? (() => 0),
    log: vi.fn(),
  };
  return { suggest: createAgentSuggest(deps), deps, git };
}

describe("agentCommands", () => {
  const tree: Record<string, Node> = {
    [ROOT]: { kind: "dir" },
    [CONFIG]: { kind: "dir" },
    [join(ROOT, ".claude")]: { kind: "dir" },
    [join(ROOT, ".claude", "commands")]: { kind: "dir" },
    [join(ROOT, ".claude", "commands", "deploy.md")]: {
      kind: "file",
      text: "---\ndescription: Ship it\n---\nbody",
    },
    [join(ROOT, ".claude", "commands", "team")]: { kind: "dir" },
    [join(ROOT, ".claude", "commands", "team", "sync.md")]: {
      kind: "file",
      text: "\n# Title\nSync the team\n",
    },
    [join(ROOT, ".claude", "skills")]: { kind: "dir" },
    [join(ROOT, ".claude", "skills", "lint")]: { kind: "dir" },
    [join(ROOT, ".claude", "skills", "lint", "SKILL.md")]: {
      kind: "file",
      text: "---\nname: lint\ndescription: Run the linter\n---\n",
    },
    [join(CONFIG, "commands")]: { kind: "dir" },
    [join(CONFIG, "commands", "mine.md")]: { kind: "file", text: "My own" },
    [join(CONFIG, "commands", "evil.md")]: { kind: "link", to: join("/", "etc", "passwd") },
  };

  it("lists built-ins and names with the first description line from project and account", async () => {
    const t = setup(tree);
    const out = await t.suggest.commands("t1");
    expect(out.commands.filter((c) => c.source === "built-in").map((c) => c.name)).toContain(
      "compact",
    );
    expect(out.commands.filter((c) => c.source !== "built-in")).toEqual([
      { name: "deploy", description: "Ship it", source: "project" },
      { name: "team:sync", description: "Sync the team", source: "project" },
      { name: "lint", description: "Run the linter", source: "skill" },
      { name: "mine", description: "My own", source: "account" },
    ]);
  });

  it("never follows a symlink out, and only reads a bounded head", async () => {
    const t = setup(tree);
    await t.suggest.commands("t1");
    for (const call of vi.mocked(t.deps.fs.readHead).mock.calls) {
      expect(call[0]).not.toBe(join(CONFIG, "commands", "evil.md"));
      expect(call[1]).toBeLessThanOrEqual(4096);
    }
  });

  it("gives other vendors their built-ins only, and nothing for a plain pane", async () => {
    const codex = setup(tree, { vendor: "openai" });
    const out = await codex.suggest.commands("t1");
    expect(out.commands.every((c) => c.source === "built-in")).toBe(true);
    expect((await codex.suggest.commands("nope")).commands).toEqual([]);
  });

  it("exposes the custom names for the command allow-list", async () => {
    const t = setup(tree);
    expect([...(await t.suggest.names(SESSION()))].sort()).toEqual([
      "deploy",
      "lint",
      "mine",
      "team:sync",
    ]);
  });
});

describe("agentFiles", () => {
  const git = [
    "src/app.ts",
    "src/util/app-helpers.ts",
    "README.md",
    "docs/app.md",
    "../escape.txt",
    "/abs.txt",
  ];

  it("ranks basename matches first, at most 30, never an escaping path", async () => {
    const t = setup({}, { git });
    const out = await t.suggest.files("t1", "app");
    expect(out.files.map((f) => f.path)).toEqual([
      "src/app.ts",
      "docs/app.md",
      "src/util/app-helpers.ts",
    ]);
    expect((await t.suggest.files("t1", "")).files.length).toBeLessThanOrEqual(30);
    const many = setup({}, { git: Array.from({ length: 100 }, (_, i) => `f${i}.ts`) });
    expect((await many.suggest.files("t1", "f")).files).toHaveLength(30);
  });

  it("caches the listing for 10 seconds", async () => {
    let now = 0;
    const t = setup({}, { git, now: () => now });
    await t.suggest.files("t1", "a");
    now = 9_000;
    await t.suggest.files("t1", "b");
    expect(t.git).toHaveBeenCalledTimes(1);
    now = 11_000;
    await t.suggest.files("t1", "c");
    expect(t.git).toHaveBeenCalledTimes(2);
  });

  it("falls back to a shallow listing outside git, skipping dot and dependency folders", async () => {
    const tree: Record<string, Node> = {
      [ROOT]: { kind: "dir" },
      [join(ROOT, "a.txt")]: { kind: "file", text: "" },
      [join(ROOT, "node_modules")]: { kind: "dir" },
      [join(ROOT, "node_modules", "x.txt")]: { kind: "file", text: "" },
      [join(ROOT, ".git")]: { kind: "dir" },
      [join(ROOT, "lib")]: { kind: "dir" },
      [join(ROOT, "lib", "b.txt")]: { kind: "file", text: "" },
      [join(ROOT, "link")]: { kind: "link", to: "/etc" },
    };
    const t = setup(tree, { git: undefined });
    const out = await t.suggest.files("t1", "txt");
    expect(out.files.map((f) => f.path).sort()).toEqual(["a.txt", "lib/b.txt"]);
  });

  it("is empty for an unknown pane and a non-string query", async () => {
    expect((await setup({}, { git }).suggest.files("nope", "a")).files).toEqual([]);
    expect((await setup({}, { git }).suggest.files("t1", 7)).files).toEqual([]);
  });
});

describe("agentOpenFile", () => {
  const tree: Record<string, Node> = {
    [ROOT]: { kind: "dir" },
    [join(ROOT, "src")]: { kind: "dir" },
    [join(ROOT, "src", "a.ts")]: { kind: "file", text: "" },
    [join(ROOT, "src", "out")]: { kind: "link", to: join("/", "etc", "passwd") },
    [join("/", "etc", "passwd")]: { kind: "file", text: "" },
  };

  it("resolves a file inside the project after realpath, relative or absolute", async () => {
    const t = setup(tree);
    expect(await t.suggest.resolve("t1", "src/a.ts")).toEqual({
      ok: true,
      path: join(ROOT, "src", "a.ts"),
    });
    expect(await t.suggest.resolve("t1", join(ROOT, "src", "a.ts"))).toEqual({
      ok: true,
      path: join(ROOT, "src", "a.ts"),
    });
  });

  it("refuses an escape, a symlink out, a folder, a missing file and bad input", async () => {
    const t = setup(tree);
    expect(await t.suggest.resolve("t1", "../../etc/passwd")).toEqual({
      ok: false,
      reason: "outside",
    });
    expect(await t.suggest.resolve("t1", join("/", "etc", "passwd"))).toEqual({
      ok: false,
      reason: "outside",
    });
    expect(await t.suggest.resolve("t1", "src/out")).toEqual({ ok: false, reason: "outside" });
    expect(await t.suggest.resolve("t1", "src")).toEqual({ ok: false, reason: "missing" });
    expect(await t.suggest.resolve("t1", "src/none.ts")).toEqual({ ok: false, reason: "missing" });
    expect(await t.suggest.resolve("t1", "a\0b")).toEqual({ ok: false, reason: "invalid" });
    expect(await t.suggest.resolve("t1", 5)).toEqual({ ok: false, reason: "invalid" });
    expect(await t.suggest.resolve("nope", "src/a.ts")).toEqual({ ok: false, reason: "gone" });
  });
});
