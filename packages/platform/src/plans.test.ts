import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "@jarvis/core";
import { parsePlan } from "@jarvis/core";
import { claudeProjectSlug, createPlanFiles } from "./plans.js";

const SESSION_FIXTURE = readFile(
  fileURLToPath(new URL("./__fixtures__/plans/session-transcript.jsonl", import.meta.url)),
  "utf8",
);

/**
 * Whether this process may create symlinks. On macOS and Linux always; on
 * Windows only with Developer Mode or the SeCreateSymbolicLink privilege.
 * Mirrors the probe in bruno.test.ts.
 */
const canSymlink = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-plans-symlink-probe-"));
  try {
    writeFileSync(join(dir, "target"), "");
    symlinkSync(join(dir, "target"), join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `jarvis-plans-${prefix}-`));
  made.push(dir);
  return dir;
}

function agentsFor(configDir: string): () => readonly AgentConfig[] {
  const agents: AgentConfig[] = [
    { id: "claude", command: "claude", vendor: "anthropic", configDir },
  ];
  return () => agents;
}

async function withMtime(path: string, mtimeMs: number): Promise<void> {
  const date = new Date(mtimeMs);
  await utimes(path, date, date);
}

describe("claudeProjectSlug", () => {
  it("maps every character not [A-Za-z0-9] to '-'", () => {
    expect(claudeProjectSlug("/Users/a/projects/jarvis.x")).toBe("-Users-a-projects-jarvis-x");
  });
});

describe("list — planMode", () => {
  it("lists *.md files under the plans dir, newest first, capped at 10", async () => {
    const base = await tempDir("planmode");
    const plansDir = join(base, "plans");
    await mkdir(plansDir, { recursive: true });

    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      const path = join(plansDir, `plan-${i}.md`);
      await writeFile(path, `# plan ${i}\n`);
      // Oldest file first (index 0), newest last (index 11) — so the newest
      // 10 are indices 2..11 once sorted and capped.
      await withMtime(path, now + i * 1000);
    }

    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    const list = await planFiles.list(undefined);

    expect(list.planMode).toHaveLength(10);
    expect(list.planMode.map((entry) => entry.name)).toEqual([
      "plan-11.md",
      "plan-10.md",
      "plan-9.md",
      "plan-8.md",
      "plan-7.md",
      "plan-6.md",
      "plan-5.md",
      "plan-4.md",
      "plan-3.md",
      "plan-2.md",
    ]);
    expect(list.planMode.every((entry) => entry.source === "planMode")).toBe(true);
  });

  it("returns an empty planMode list when the plans dir does not exist", async () => {
    const base = await tempDir("planmode-missing");
    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    const list = await planFiles.list(undefined);
    expect(list.planMode).toEqual([]);
  });
});

describe("list — repo", () => {
  it("groups docs/superpowers/specs and /plans separately, newest first", async () => {
    const base = await tempDir("repo-base");
    const cwd = await tempDir("repo-cwd");
    const specsDir = join(cwd, "docs", "superpowers", "specs");
    const plansDir = join(cwd, "docs", "superpowers", "plans");
    await mkdir(specsDir, { recursive: true });
    await mkdir(plansDir, { recursive: true });

    const now = Date.now();
    await writeFile(join(specsDir, "older-spec.md"), "# older spec\n");
    await withMtime(join(specsDir, "older-spec.md"), now);
    await writeFile(join(specsDir, "newer-spec.md"), "# newer spec\n");
    await withMtime(join(specsDir, "newer-spec.md"), now + 2000);
    await writeFile(join(plansDir, "a-plan.md"), "# a plan\n");
    await withMtime(join(plansDir, "a-plan.md"), now + 1000);

    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    const list = await planFiles.list(cwd);

    expect(list.repo.map((entry) => [entry.name, entry.repoKind])).toEqual([
      ["newer-spec.md", "spec"],
      ["a-plan.md", "plan"],
      ["older-spec.md", "spec"],
    ]);
  });

  it("returns an empty repo list when neither directory exists", async () => {
    const base = await tempDir("repo-missing-base");
    const cwd = await tempDir("repo-missing-cwd");
    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    const list = await planFiles.list(cwd);
    expect(list.repo).toEqual([]);
  });
});

describe("list — session", () => {
  it("finds the plan a session's transcript last referenced, and removes it from planMode", async () => {
    const base = await tempDir("session-base");
    const cwd = await tempDir("session-cwd");
    const plansDir = join(base, "plans");
    await mkdir(plansDir, { recursive: true });

    await writeFile(join(plansDir, "other-a.md"), "# other a\n");
    await writeFile(join(plansDir, "other-b.md"), "# other b\n");
    await writeFile(join(plansDir, "session-found.md"), "# Found\n\nBody text.\n");

    const transcriptDir = join(base, "projects", claudeProjectSlug(cwd));
    await mkdir(transcriptDir, { recursive: true });
    const fixture = (await SESSION_FIXTURE).replaceAll("__BASE__", base).replaceAll("__CWD__", cwd);
    await writeFile(join(transcriptDir, "abc.jsonl"), fixture);

    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    const list = await planFiles.list(cwd);

    expect(list.session?.path).toBe(join(plansDir, "session-found.md"));
    expect(list.session?.name).toBe("session-found.md");
    expect(list.session?.source).toBe("session");
    expect(list.planMode.some((entry) => entry.name === "session-found.md")).toBe(false);
    expect(list.planMode.map((entry) => entry.name).sort()).toEqual(["other-a.md", "other-b.md"]);
  });

  it("returns session undefined when there is no transcript for the project", async () => {
    const base = await tempDir("session-none-base");
    const cwd = await tempDir("session-none-cwd");
    const plansDir = join(base, "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, "solo.md"), "# solo\n");

    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    const list = await planFiles.list(cwd);

    expect(list.session).toBeUndefined();
    expect(list.planMode.map((entry) => entry.name)).toEqual(["solo.md"]);
  });
});

describe("isAllowed — path guard", () => {
  it("accepts a file inside a plans dir", async () => {
    const base = await tempDir("guard-base");
    const plansDir = join(base, "plans");
    await mkdir(plansDir, { recursive: true });
    const path = join(plansDir, "ok.md");
    await writeFile(path, "# ok\n");

    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    expect(await planFiles.isAllowed(path)).toBe(true);
  });

  it("accepts a repo spec path under docs/superpowers/specs", async () => {
    const base = await tempDir("guard-repo-base");
    const cwd = await tempDir("guard-repo-cwd");
    const specsDir = join(cwd, "docs", "superpowers", "specs");
    await mkdir(specsDir, { recursive: true });
    const path = join(specsDir, "task.md");
    await writeFile(path, "# task\n");

    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    expect(await planFiles.isAllowed(path)).toBe(true);
  });

  it("rejects a non-.md file inside a plans dir", async () => {
    const base = await tempDir("guard-txt-base");
    const plansDir = join(base, "plans");
    await mkdir(plansDir, { recursive: true });
    const path = join(plansDir, "notes.txt");
    await writeFile(path, "not markdown\n");

    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    expect(await planFiles.isAllowed(path)).toBe(false);
  });

  it("rejects an arbitrary system file", async () => {
    const base = await tempDir("guard-etc-base");
    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    expect(await planFiles.isAllowed("/etc/hosts")).toBe(false);
  });

  it("rejects a path that escapes the plans dir via ..", async () => {
    const base = await tempDir("guard-traverse-base");
    const plansDir = join(base, "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(base, "evil.md"), "# evil\n");
    const path = join(plansDir, "..", "evil.md");

    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    expect(await planFiles.isAllowed(path)).toBe(false);
  });

  it.skipIf(!canSymlink)("rejects a symlink inside a plans dir that escapes it", async () => {
    const base = await tempDir("guard-symlink-base");
    const outside = await tempDir("guard-symlink-outside");
    const plansDir = join(base, "plans");
    await mkdir(plansDir, { recursive: true });
    const target = join(outside, "target.md");
    await writeFile(target, "# outside\n");
    const link = join(plansDir, "escape.md");
    await symlink(target, link);

    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    expect(await planFiles.isAllowed(link)).toBe(false);
  });

  it("rejects a path that does not exist", async () => {
    const base = await tempDir("guard-missing-base");
    const plansDir = join(base, "plans");
    await mkdir(plansDir, { recursive: true });

    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    expect(await planFiles.isAllowed(join(plansDir, "nope.md"))).toBe(false);
  });
});

describe("read", () => {
  it("returns forbidden for a path outside every allowed location", async () => {
    const base = await tempDir("read-forbidden-base");
    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    const result = await planFiles.read("/etc/hosts");
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  it("returns too-large for a plan file over 1 MiB", async () => {
    const base = await tempDir("read-too-large-base");
    const plansDir = join(base, "plans");
    await mkdir(plansDir, { recursive: true });
    const path = join(plansDir, "huge.md");
    await writeFile(path, "x".repeat(1024 * 1024 + 10));

    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    const result = await planFiles.read(path);
    expect(result).toEqual({ ok: false, reason: "too-large" });
  });

  it("reads and parses an allowed plan file", async () => {
    const base = await tempDir("read-ok-base");
    const plansDir = join(base, "plans");
    await mkdir(plansDir, { recursive: true });
    const path = join(plansDir, "doc.md");
    await writeFile(path, "# Title\n\nBody.\n");

    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    const result = await planFiles.read(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.path).toBe(path);
      expect(result.value.blocks.map((b) => b.kind)).toEqual(["heading", "paragraph"]);
    }
  });
});

describe("writeBlock", () => {
  async function planWithFile(prefix: string): Promise<{
    path: string;
    source: string;
    mtimeMs: number;
    planFiles: ReturnType<typeof createPlanFiles>;
  }> {
    const base = await tempDir(prefix);
    const plansDir = join(base, "plans");
    await mkdir(plansDir, { recursive: true });
    const path = join(plansDir, "doc.md");
    const source = ["# Title", "", "First paragraph.", "", "- item one", "- item two", ""].join(
      "\n",
    );
    await writeFile(path, source);
    const info = await stat(path);
    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    return { path, source, mtimeMs: info.mtimeMs, planFiles };
  }

  it("replaces one block's source and leaves every other line identical", async () => {
    const { path, source, mtimeMs, planFiles } = await planWithFile("write-ok");
    const blocks = parsePlan(source);
    const paragraph = blocks.find((b) => b.kind === "paragraph");
    if (paragraph === undefined) throw new Error("fixture has no paragraph block");

    const result = await planFiles.writeBlock(path, paragraph.id, "A replaced paragraph.", mtimeMs);
    expect(result.ok).toBe(true);

    const written = await readFile(path, "utf8");
    expect(written).toBe(
      ["# Title", "", "A replaced paragraph.", "", "- item one", "- item two", ""].join("\n"),
    );
  });

  it("returns conflict with a fresh doc when the file's mtime moved", async () => {
    const { path, source, mtimeMs, planFiles } = await planWithFile("write-conflict");
    const blocks = parsePlan(source);
    const paragraph = blocks.find((b) => b.kind === "paragraph");
    if (paragraph === undefined) throw new Error("fixture has no paragraph block");

    // Someone else changes the file after this caller last read it.
    await writeFile(path, source.replace("First paragraph.", "Someone else's edit."));

    const result = await planFiles.writeBlock(path, paragraph.id, "My edit.", mtimeMs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("conflict");
      expect(result.doc?.blocks.some((b) => b.source === "Someone else's edit.")).toBe(true);
    }

    // The stale write must never have reached disk.
    expect(await readFile(path, "utf8")).not.toContain("My edit.");
  });

  it("returns missing-block with a fresh doc for an id no longer present", async () => {
    const { path, mtimeMs, planFiles } = await planWithFile("write-missing-block");
    const result = await planFiles.writeBlock(path, "not-a-real-block-id", "x", mtimeMs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing-block");
      expect(result.doc).toBeDefined();
    }
  });

  it("writes atomically, leaving no temp file behind", async () => {
    const { path, source, mtimeMs, planFiles } = await planWithFile("write-atomic");
    const blocks = parsePlan(source);
    const heading = blocks.find((b) => b.kind === "heading");
    if (heading === undefined) throw new Error("fixture has no heading block");

    await planFiles.writeBlock(path, heading.id, "# New Title", mtimeMs);

    const dir = dirname(path);
    const names = await readdir(dir);
    expect(names.some((name) => name.endsWith(".jarvis-tmp"))).toBe(false);
    expect(names).toContain("doc.md");
  });
});

describe("watch", () => {
  it("debounces rapid writes to a single change per path", async () => {
    const base = await tempDir("watch-base");
    const plansDir = join(base, "plans");
    await mkdir(plansDir, { recursive: true });
    const path = join(plansDir, "watched.md");
    await writeFile(path, "# one\n");

    const planFiles = createPlanFiles({ agents: agentsFor(base), home: base });
    const changes: string[] = [];
    const dispose = planFiles.watch(
      (changed) => changes.push(changed),
      () => [],
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await writeFile(path, "# two\n");
      await writeFile(path, "# three\n");
      await writeFile(path, "# four\n");
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      dispose();
    }

    expect(changes.filter((p) => p === path)).toHaveLength(1);
  }, 10000);
});
