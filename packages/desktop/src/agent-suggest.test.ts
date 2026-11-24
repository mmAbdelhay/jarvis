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
    /** A session whose cwd could not be read (lsof missing or denied). */
    noCwd?: boolean;
    fallbackCwd?: AgentSuggestDeps["fallbackCwd"];
    cwd?: string;
    home?: string;
    env?: Record<string, string | undefined>;
    noTranscript?: boolean;
    configDir?: string;
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
        paneKey === "t1"
          ? {
              ...SESSION(options.vendor),
              ...(options.noCwd === true ? { cwd: null } : {}),
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
              ...(options.noTranscript === true ? { transcriptPath: undefined } : {}),
              ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
            }
          : undefined,
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
        // A parent folder exists when anything below it does.
        if (
          node === undefined &&
          !Object.keys(tree).some((key) => key.startsWith(`${path}${sep}`))
        ) {
          throw new Error("ENOENT");
        }
        return path;
      }),
      isFile: vi.fn(async (path: string) => tree[path]?.kind === "file"),
    },
    git,
    ...(options.fallbackCwd === undefined ? {} : { fallbackCwd: options.fallbackCwd }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.env === undefined ? {} : { env: options.env }),
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
      expect(call[1]).toBeLessThanOrEqual(call[0].endsWith(".json") ? 262_144 : 4096);
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

describe("a session whose cwd is unknown", () => {
  const tree: Record<string, Node> = {
    [ROOT]: { kind: "dir" },
    [join(ROOT, "README.md")]: { kind: "file", text: "x" },
  };

  it("lists files and resolves a path from the fallback root, keeping the realpath guards", async () => {
    const t = setup(tree, { noCwd: true, git: ["README.md"], fallbackCwd: async () => ROOT });
    expect((await t.suggest.files("t1", "REA")).files).toEqual([
      { path: "README.md", name: "README.md" },
    ]);
    expect(await t.suggest.resolve("t1", "README.md")).toEqual({
      ok: true,
      path: join(ROOT, "README.md"),
    });
    expect(await t.suggest.resolve("t1", "../../etc/passwd")).toEqual({
      ok: false,
      reason: "outside",
    });
  });

  it("finds nothing, quietly, when there is no fallback either", async () => {
    const t = setup(tree, { noCwd: true, git: ["README.md"] });
    expect((await t.suggest.files("t1", "REA")).files).toEqual([]);
    expect(await t.suggest.resolve("t1", "README.md")).toEqual({ ok: false, reason: "gone" });
  });
});

const HOME = join("/", "home", "me");
const dir = (...parts: string[]): Record<string, Node> => ({ [join(...parts)]: { kind: "dir" } });
const file = (path: string, text: string): Record<string, Node> => ({
  [path]: { kind: "file", text },
});
const names = (out: { commands: { name: string; source: string }[] }, source?: string): string[] =>
  out.commands
    .filter((c) => c.source !== "built-in" && (source === undefined || c.source === source))
    .map((c) => c.name);

describe("built-in rows", () => {
  it("carry description, hint, aliases and documented choices", async () => {
    const out = await setup({}).suggest.commands("t1");
    expect(out.commands.find((c) => c.name === "model")).toEqual({
      name: "model",
      description: "Switch model",
      hint: "<model>",
      choices: ["opus", "sonnet", "haiku"],
      source: "built-in",
    });
    expect(out.commands.find((c) => c.name === "usage")?.aliases).toEqual(["cost", "stats"]);
    const copilot = await setup({}, { vendor: "github" }).suggest.commands("t1");
    expect(copilot.commands.filter((c) => c.source === "built-in")).toHaveLength(77);
    const codex = await setup({}, { vendor: "openai" }).suggest.commands("t1");
    expect(codex.commands.some((c) => c.name === "approvals")).toBe(false);
  });
});

describe("Claude discovery", () => {
  const GIT_ROOT = join("/", "work", "mono");
  const CWD = join(GIT_ROOT, "pkg", "web");
  const base: Record<string, Node> = {
    ...dir(GIT_ROOT),
    ...dir(GIT_ROOT, ".git"),
    ...dir(GIT_ROOT, "pkg"),
    ...dir(CWD),
    ...dir(CONFIG),
  };

  it("walks from the cwd up to the git root, nearest first, and stops there", async () => {
    const t = setup(
      {
        ...base,
        ...dir(GIT_ROOT, ".claude", "commands"),
        ...file(join(GIT_ROOT, ".claude", "commands", "root-cmd.md"), "Root command"),
        ...dir(CWD, ".claude", "commands"),
        ...file(join(CWD, ".claude", "commands", "near.md"), "Near command"),
        ...dir("/work", ".claude", "commands"),
        ...file(join("/work", ".claude", "commands", "above.md"), "Above the repo"),
      },
      { cwd: CWD },
    );
    expect(names(await t.suggest.commands("t1"), "project")).toEqual(["near", "root-cmd"]);
  });

  it("leaves out user-invocable false, lets name: win, reads block descriptions and hints", async () => {
    const t = setup(
      {
        ...base,
        ...dir(CWD, ".claude", "skills", "a"),
        ...file(
          join(CWD, ".claude", "skills", "a", "SKILL.md"),
          "---\nname: renamed\ndescription: >\n  Folded\n  text\nargument-hint: [x]\n---\nSECRET BODY",
        ),
        ...dir(CWD, ".claude", "skills", "b"),
        ...file(
          join(CWD, ".claude", "skills", "b", "SKILL.md"),
          "---\nuser-invocable: false\n---\nhidden",
        ),
      },
      { cwd: CWD },
    );
    const out = await t.suggest.commands("t1");
    expect(out.commands.filter((c) => c.source === "skill")).toEqual([
      { name: "renamed", description: "Folded text", hint: "[x]", source: "skill" },
    ]);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("follows a symlinked skill directory in the account only", async () => {
    const outside = join("/", "elsewhere", "shared-skill");
    const t = setup(
      {
        ...base,
        ...dir(CONFIG, "skills"),
        [join(CONFIG, "skills", "linked")]: { kind: "link", to: outside },
        ...dir(outside),
        ...file(join(outside, "SKILL.md"), "---\ndescription: Shared\n---\n"),
        ...dir(CWD, ".claude", "skills"),
        [join(CWD, ".claude", "skills", "pl")]: { kind: "link", to: outside },
      },
      { cwd: CWD },
    );
    const out = await t.suggest.commands("t1");
    expect(names(out, "skill")).toEqual(["linked"]);
  });

  it("uses ~/.claude for the account when there is no transcript yet", async () => {
    const t = setup(
      {
        ...base,
        ...dir(HOME, ".claude", "commands"),
        ...file(join(HOME, ".claude", "commands", "mine.md"), "Mine"),
      },
      { cwd: CWD, home: HOME, noTranscript: true },
    );
    expect(names(await t.suggest.commands("t1"), "account")).toEqual(["mine"]);
  });

  describe("plugins", () => {
    const P2 = join(CONFIG, "plugins", "cache", "acme", "tools", "1.0.0");
    const P1 = join(CONFIG, "plugins", "cache", "old");
    const plugins = (extra: Record<string, Node> = {}): Record<string, Node> => ({
      ...base,
      ...dir(CONFIG, "plugins"),
      ...file(
        join(CONFIG, "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "tools@acme": [{ scope: "user", installPath: P2, version: "1.0.0" }],
            "proj@acme": [
              {
                scope: "project",
                installPath: join(P2, "..", "proj"),
                projectPath: join("/", "other"),
              },
            ],
            "old@acme": { installPath: P1, version: "0.1" },
          },
        }),
      ),
      ...file(
        join(CONFIG, "settings.json"),
        JSON.stringify({
          model: "x",
          env: { TOKEN: "s3cret" },
          enabledPlugins: { "tools@acme": true, "old@acme": true, "proj@acme": true },
        }),
      ),
      ...dir(P2, "commands"),
      ...file(join(P2, "commands", "deploy.md"), "Deploy it"),
      ...dir(P2, "skills", "audit"),
      ...file(join(P2, "skills", "audit", "SKILL.md"), "---\ndescription: Audit\n---\n"),
      ...dir(P1, "commands"),
      ...file(join(P1, "commands", "legacy.md"), "Legacy"),
      ...extra,
    });

    it("lists enabled plugins' commands and skills as plugin:name, in both file shapes", async () => {
      const out = await setup(plugins(), { cwd: CWD }).suggest.commands("t1");
      expect(names(out, "plugin").sort()).toEqual(["old:legacy", "tools:audit", "tools:deploy"]);
    });

    it("skips a plugin the settings do not enable, and a project-scoped one for another project", async () => {
      const off = plugins({
        ...file(
          join(CONFIG, "settings.json"),
          JSON.stringify({ enabledPlugins: { "tools@acme": false } }),
        ),
      });
      expect(names(await setup(off, { cwd: CWD }).suggest.commands("t1"), "plugin")).toEqual([]);
      const proj = join(P2, "..", "proj");
      const onlyProj = plugins({
        ...dir(proj, "commands"),
        ...file(join(proj, "commands", "pc.md"), "Project plugin"),
      });
      expect(
        names(await setup(onlyProj, { cwd: CWD }).suggest.commands("t1"), "plugin"),
      ).not.toContain("proj:pc");
    });

    it("lets project settings enable a plugin and a project-scoped entry match its projectPath", async () => {
      const proj = join(P2, "..", "proj");
      const tree = plugins({
        ...file(join(CONFIG, "settings.json"), JSON.stringify({})),
        ...file(
          join(CWD, ".claude", "settings.json"),
          JSON.stringify({ enabledPlugins: { "proj@acme": true } }),
        ),
        ...file(
          join(CONFIG, "plugins", "installed_plugins.json"),
          JSON.stringify({
            version: 2,
            plugins: {
              "proj@acme": [{ scope: "project", installPath: proj, projectPath: GIT_ROOT }],
            },
          }),
        ),
        ...dir(proj, "commands"),
        ...file(join(proj, "commands", "pc.md"), "Project plugin"),
      });
      expect(names(await setup(tree, { cwd: CWD }).suggest.commands("t1"), "plugin")).toEqual([
        "proj:pc",
      ]);
    });

    it("follows plugin.json paths only inside the install path", async () => {
      const tree = plugins({
        ...file(
          join(P2, ".claude-plugin", "plugin.json"),
          JSON.stringify({ commands: ["./extra", "../../escape"], skills: "./more" }),
        ),
        ...dir(P2, ".claude-plugin"),
        ...dir(P2, "extra"),
        ...file(join(P2, "extra", "x.md"), "Extra"),
        ...dir(P2, "more", "s"),
        ...file(join(P2, "more", "s", "SKILL.md"), "Skill s"),
        ...dir(CONFIG, "plugins", "cache", "acme", "escape"),
        ...file(join(CONFIG, "plugins", "cache", "acme", "escape", "e.md"), "Escaped"),
      });
      const out = names(await setup(tree, { cwd: CWD }).suggest.commands("t1"), "plugin");
      expect(out).toContain("tools:x");
      expect(out).toContain("tools:s");
      expect(out).not.toContain("tools:e");
    });

    it("reads only enabledPlugins from settings and never lets its other keys out", async () => {
      const out = await setup(plugins(), { cwd: CWD }).suggest.commands("t1");
      expect(JSON.stringify(out)).not.toContain("s3cret");
    });
  });
});

describe("Codex discovery", () => {
  const CODEX_HOME = join(HOME, ".codex");
  const CWD = join("/", "work", "mono", "pkg");
  const tree: Record<string, Node> = {
    ...dir(join("/", "work", "mono")),
    ...dir(join("/", "work", "mono", ".git")),
    ...dir(CWD),
    ...dir(CODEX_HOME, "prompts"),
    ...file(
      join(CODEX_HOME, "prompts", "draft.md"),
      "---\ndescription: Draft a PR\nargument-hint: FILES=<paths>\n---\nbody",
    ),
    ...dir(CODEX_HOME, "skills", "pdf"),
    ...file(join(CODEX_HOME, "skills", "pdf", "SKILL.md"), "---\ndescription: Read PDFs\n---\n"),
    ...dir(HOME, ".agents", "skills", "shared"),
    ...file(join(HOME, ".agents", "skills", "shared", "SKILL.md"), "Shared skill"),
    ...dir("/work/mono", ".agents", "skills", "local"),
    ...file(join("/work/mono", ".agents", "skills", "local", "SKILL.md"), "Local skill"),
  };

  it("offers prompts as prompts:name and skills as $name", async () => {
    const t = setup(tree, { vendor: "openai", cwd: CWD, home: HOME, env: {} });
    const out = await t.suggest.commands("t1");
    const custom = out.commands.filter((c) => c.source !== "built-in");
    expect(custom.find((c) => c.name === "prompts:draft")).toEqual({
      name: "prompts:draft",
      description: "Draft a PR",
      hint: "FILES=<paths>",
      source: "account",
    });
    expect(
      custom
        .filter((c) => c.trigger === "$")
        .map((c) => c.name)
        .sort(),
    ).toEqual(["local", "pdf", "shared"]);
    expect(custom.find((c) => c.name === "pdf")).toMatchObject({
      trigger: "$",
      source: "skill",
      description: "Read PDFs",
    });
  });

  it("takes CODEX_HOME from the environment", async () => {
    const other = join("/", "srv", "codex");
    const t = setup(
      { ...dir(other, "prompts"), ...file(join(other, "prompts", "p.md"), "P"), ...dir(CWD) },
      { vendor: "openai", cwd: CWD, home: HOME, env: { CODEX_HOME: other } },
    );
    expect(names(await t.suggest.commands("t1"))).toEqual(["prompts:p"]);
  });

  it("keeps $ skills out of the typed-command allow-list", async () => {
    const t = setup(tree, { vendor: "openai", cwd: CWD, home: HOME, env: {} });
    expect([...(await t.suggest.names({ ...SESSION("openai"), cwd: CWD }))]).toEqual([
      "prompts:draft",
    ]);
  });
});

describe("Copilot discovery", () => {
  it("lists skills from the project folders and the home folders as /name", async () => {
    const CWD = join("/", "work", "app");
    const t = setup(
      {
        ...dir(CWD),
        ...dir(CWD, ".github", "skills", "gh"),
        ...file(
          join(CWD, ".github", "skills", "gh", "SKILL.md"),
          "---\ndescription: GH skill\n---\n",
        ),
        ...dir(CWD, ".claude", "skills", "cl"),
        ...file(join(CWD, ".claude", "skills", "cl", "SKILL.md"), "Claude folder skill"),
        ...dir(HOME, ".copilot", "skills", "mine"),
        ...file(join(HOME, ".copilot", "skills", "mine", "SKILL.md"), "Mine"),
        ...dir(HOME, ".agents", "skills", "ag"),
        ...file(join(HOME, ".agents", "skills", "ag", "SKILL.md"), "Agents"),
      },
      { vendor: "github", cwd: CWD, home: HOME },
    );
    const out = await t.suggest.commands("t1");
    expect(names(out, "skill").sort()).toEqual(["ag", "cl", "gh", "mine"]);
    expect(out.commands.find((c) => c.name === "gh")?.trigger).toBeUndefined();
  });
});

describe("limits and cache", () => {
  it("returns up to 1000 custom commands per pane and no more", async () => {
    const tree: Record<string, Node> = {
      ...dir(ROOT),
      ...dir(CONFIG),
      ...dir(ROOT, ".claude", "commands"),
    };
    for (let i = 0; i < 1200; i++)
      tree[join(ROOT, ".claude", "commands", `c${i}.md`)] = { kind: "file", text: "x" };
    const t = setup(tree);
    expect(names(await t.suggest.commands("t1"))).toHaveLength(1000);
  });

  it("serves the discovery from a 10 s cache and refreshes after", async () => {
    let now = 0;
    const tree: Record<string, Node> = {
      ...dir(ROOT),
      ...dir(CONFIG),
      ...dir(ROOT, ".claude", "commands"),
      ...file(join(ROOT, ".claude", "commands", "a.md"), "A"),
    };
    const t = setup(tree, { now: () => now });
    await t.suggest.commands("t1");
    const reads = vi.mocked(t.deps.fs.readHead).mock.calls.length;
    now = 9_000;
    await t.suggest.commands("t1");
    expect(vi.mocked(t.deps.fs.readHead).mock.calls.length).toBe(reads);
    now = 11_000;
    await t.suggest.commands("t1");
    expect(vi.mocked(t.deps.fs.readHead).mock.calls.length).toBeGreaterThan(reads);
  });

  it("reads only markdown files, SKILL.md and the two plugin JSON files, each bounded", async () => {
    const t = setup({
      ...dir(ROOT),
      ...dir(CONFIG),
      ...dir(ROOT, ".claude", "commands"),
      ...file(join(ROOT, ".claude", "commands", "a.md"), "A"),
      ...file(join(ROOT, ".claude", "commands", "secrets.env"), "KEY=1"),
    });
    await t.suggest.commands("t1");
    for (const [path, bytes] of vi.mocked(t.deps.fs.readHead).mock.calls) {
      expect(path).toMatch(
        /\.md$|installed_plugins\.json$|settings(\.local)?\.json$|plugin\.json$/,
      );
      expect(bytes).toBeLessThanOrEqual(262_144);
    }
  });
});

describe("which account's folders are read", () => {
  const CWD = join("/", "work", "app");
  const MINE = join(HOME, ".claude-mine");
  const OTHER = join(HOME, ".claude");
  const tree: Record<string, Node> = {
    ...dir(CWD),
    ...dir(MINE, "commands"),
    ...file(join(MINE, "commands", "mine.md"), "Mine"),
    ...dir(OTHER, "commands"),
    ...file(join(OTHER, "commands", "theirs.md"), "Theirs"),
  };

  it("uses the matched account before any transcript exists, never ~/.claude", async () => {
    const t = setup(tree, { cwd: CWD, home: HOME, noTranscript: true, configDir: MINE });
    expect(names(await t.suggest.commands("t1"), "account")).toEqual(["mine"]);
  });

  it("prefers the matched account over the transcript's directory", async () => {
    const t = setup(tree, { cwd: CWD, home: HOME, configDir: MINE });
    expect(names(await t.suggest.commands("t1"), "account")).toEqual(["mine"]);
  });

  it("uses the Codex account's directory for prompts and skills", async () => {
    const codex = join(HOME, ".codex-work");
    const t = setup(
      {
        ...dir(CWD),
        ...dir(codex, "prompts"),
        ...file(join(codex, "prompts", "p.md"), "Work prompt"),
        ...dir(codex, "skills", "s"),
        ...file(join(codex, "skills", "s", "SKILL.md"), "Work skill"),
        ...dir(HOME, ".codex", "prompts"),
        ...file(join(HOME, ".codex", "prompts", "other.md"), "Other"),
      },
      { vendor: "openai", cwd: CWD, home: HOME, env: {}, noTranscript: true, configDir: codex },
    );
    expect(names(await t.suggest.commands("t1")).sort()).toEqual(["prompts:p", "s"]);
  });

  it("uses the Copilot account's skills", async () => {
    const copilot = join(HOME, ".copilot-work");
    const t = setup(
      {
        ...dir(CWD),
        ...dir(copilot, "skills", "w"),
        ...file(join(copilot, "skills", "w", "SKILL.md"), "Work"),
        ...dir(HOME, ".copilot", "skills", "d"),
        ...file(join(HOME, ".copilot", "skills", "d", "SKILL.md"), "Default"),
      },
      { vendor: "github", cwd: CWD, home: HOME, configDir: copilot },
    );
    expect(names(await t.suggest.commands("t1"), "skill")).toEqual(["w"]);
  });
});

describe("skills synced from claude.ai", () => {
  const CWD = join("/", "work", "app");
  it("appear as /name from <config>/skills/synced/<id>/<name>", async () => {
    const t = setup(
      {
        ...dir(CWD),
        ...dir(CONFIG, "skills", "synced", "abc123"),
        ...dir(CONFIG, "skills", "synced", "def456"),
        ...dir(CONFIG, "skills", "synced", "abc123", "pitch"),
        ...file(
          join(CONFIG, "skills", "synced", "abc123", "pitch", "SKILL.md"),
          "---\ndescription: Pitch deck\n---\n",
        ),
        ...dir(CONFIG, "skills", "synced", "def456", "notes"),
        ...file(join(CONFIG, "skills", "synced", "def456", "notes", "SKILL.md"), "Notes"),
        [join(CONFIG, "skills", "synced", "link")]: { kind: "link", to: join("/", "elsewhere") },
      },
      { cwd: CWD },
    );
    const out = await t.suggest.commands("t1");
    expect(out.commands.filter((c) => c.source === "skill")).toEqual([
      { name: "pitch", description: "Pitch deck", source: "skill" },
      { name: "notes", description: "Notes", source: "skill" },
    ]);
  });
});
