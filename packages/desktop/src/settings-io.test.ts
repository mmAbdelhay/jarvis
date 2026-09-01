import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import type { JarvisConfig } from "./config.js";
import { toRawConfig, validateDraft, writeSettingsFile } from "./settings-io.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jarvis-settings-"));
}

const draft: JarvisConfig = {
  registry: {
    agents: { "claude-mm": { command: "claude-mm", model: "opus", default: true } },
    routing: [{ match: { project: "acme" }, agent: "claude-mm" }],
  },
  projects: { acme: "/Users/x/projects/acme" },
  databases: {},
  voice: {
    englishVoice: "Daniel",
    arabicVoice: "Majed",
    greeting: { en: "Good {timeOfDay} sir, how can I help you today?", ar: "{timeOfDay} يا سيدي" },
  },
  brain: { systemPrompt: "You are Jarvis.", cwd: "/Users/x/.config/jarvis/brain" },
  whisper: { binaryPath: "/opt/whisper/bin/whisper-cli", modelPath: "/opt/whisper/model.bin" },
  sessionsDbPath: "/Users/x/.config/jarvis/sessions.db",
};

describe("validateDraft", () => {
  it("accepts a draft that already matches JarvisConfig's own shape", () => {
    const result = validateDraft(draft);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.projects).toEqual({ acme: "/Users/x/projects/acme" });
  });

  it("reports parseConfig's own message on an invalid draft", () => {
    // An agent with no command — genuinely invalid, unlike an empty agents
    // map (which is a valid, if pointless, config).
    const invalid = {
      registry: { agents: { "claude-mm": {} }, routing: [] },
      projects: {},
      brain: { cwd: "/tmp" },
      whisper: draft.whisper,
      sessionsDbPath: "x",
    };

    const result = validateDraft(invalid);

    expect(result).toEqual({
      ok: false,
      detail: "Config `agents.claude-mm.command` must be a string",
    });
  });

  // Extra fields parseConfig never reads (sessionsDbPath, brain.configDir,
  // brain.query) must not cause a rejection — they are exactly the fields
  // JarvisConfig itself adds beyond the file's own shape.
  it("ignores fields the raw file format has no place for", () => {
    const result = validateDraft({ ...draft, sessionsDbPath: "/anything" });

    expect(result.ok).toBe(true);
  });

  it("catches a non-Error throw without crashing", () => {
    // parseConfig only ever throws Error, but validateDraft's own contract
    // (never throw) must hold regardless of what it's handed.
    const result = validateDraft(null);

    expect(result.ok).toBe(false);
  });
});

describe("toRawConfig", () => {
  it("flattens registry.agents/routing to top-level agents/routing", () => {
    const raw = toRawConfig(draft) as Record<string, unknown>;

    expect(raw["agents"]).toEqual(draft.registry.agents);
    expect(raw["routing"]).toEqual(draft.registry.routing);
    expect(raw).not.toHaveProperty("registry");
  });

  it("drops sessionsDbPath — the file has no key for it", () => {
    const raw = toRawConfig(draft) as Record<string, unknown>;

    expect(raw).not.toHaveProperty("sessionsDbPath");
  });

  it("writes only accountId/cwd/systemPrompt under brain, not the computed configDir", () => {
    const withAccount: JarvisConfig = {
      ...draft,
      brain: { ...draft.brain, accountId: "claude-mm", configDir: "/Users/x/.claude-mm" },
    };

    const raw = toRawConfig(withAccount) as { brain: Record<string, unknown> };

    expect(raw.brain).toEqual({
      accountId: "claude-mm",
      cwd: "/Users/x/.config/jarvis/brain",
      systemPrompt: "You are Jarvis.",
    });
  });

  it("omits accountId entirely when the draft has none", () => {
    const raw = toRawConfig(draft) as { brain: Record<string, unknown> };

    expect(raw.brain).not.toHaveProperty("accountId");
  });

  it("keeps projects and whisper as-is", () => {
    const raw = toRawConfig(draft) as Record<string, unknown>;

    expect(raw["projects"]).toEqual(draft.projects);
    expect(raw["whisper"]).toEqual(draft.whisper);
  });
});

describe("writeSettingsFile", () => {
  it("writes a file parseConfig can load back", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");
    await writeFile(path, "placeholder: true");

    const result = await writeSettingsFile(path, draft);

    expect(result).toEqual({ ok: true });
    const written = parse(await readFile(path, "utf8"));
    expect(written.agents["claude-mm"].command).toBe("claude-mm");
    expect(written.routing[0].agent).toBe("claude-mm");
  });

  it("backs up the previous file before overwriting it", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");
    await writeFile(path, "agents:\n  old: {command: old}\n# a hand-written comment\n");

    await writeSettingsFile(path, draft);

    const entries = await readdir(dir);
    const backup = entries.find((name) => name.startsWith("jarvis.yaml.bak-"));
    expect(backup).toBeDefined();
    const backupContent = await readFile(join(dir, backup as string), "utf8");
    expect(backupContent).toContain("a hand-written comment");
  });

  it("refuses to write an invalid draft and reports why, leaving the file untouched", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");
    await writeFile(path, "original: true");

    const invalid = {
      ...draft,
      registry: { agents: { "claude-mm": {} }, routing: [] },
    } as unknown as JarvisConfig;
    const result = await writeSettingsFile(path, invalid);

    expect(result).toEqual({
      ok: false,
      detail: "Config `agents.claude-mm.command` must be a string",
    });
    expect(await readFile(path, "utf8")).toBe("original: true");
  });

  it("writes a first version with no prior file to back up", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");

    const result = await writeSettingsFile(path, draft);

    expect(result).toEqual({ ok: true });
    const entries = await readdir(dir);
    expect(entries.some((name) => name.startsWith("jarvis.yaml.bak-"))).toBe(false);
  });
});

describe("databases round-trip", () => {
  it("keeps a project's connections through validateDraft", () => {
    const withDatabases: JarvisConfig = {
      ...draft,
      databases: {
        acme: [{ id: "main", engine: "mysql", host: "127.0.0.1", port: 3306 }],
      },
    };

    const validated = validateDraft(withDatabases);

    expect(validated.ok).toBe(true);
    expect(validated.ok && validated.value.databases["acme"]).toEqual([
      { id: "main", engine: "mysql", host: "127.0.0.1", port: 3306 },
    ]);
  });

  it("omits the databases key entirely when there are no connections", () => {
    const raw = toRawConfig(draft) as Record<string, unknown>;

    expect("databases" in raw).toBe(false);
  });

  it("writes the section to the file when there is one", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");

    await writeSettingsFile(path, {
      ...draft,
      databases: { acme: [{ id: "main", engine: "mysql" }] },
    });

    expect(await readFile(path, "utf8")).toContain("databases:");
  });
});
