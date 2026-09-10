import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseConfig, type JarvisConfig } from "./config.js";
import { toRawConfig, validateDraft, writeSettingsFile } from "./settings-io.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jarvis-settings-"));
}

const draft: JarvisConfig = {
  registry: {
    agents: { "claude-main": { command: "claude-main", model: "opus", default: true } },
    routing: [{ match: { project: "acme" }, agent: "claude-main" }],
  },
  projects: { acme: "/Users/x/projects/acme" },
  databases: {},
  editors: {},
  clusters: {},
  docker: {},
  chat: {},
  workflows: {},
  headlamp: { binary: "/some/path" },
  terminal: {
    completion: { enabled: true, historyPath: "/h", commandLogPath: "/l" },
    blocks: { enabled: true, inputEditor: true },
    notifyAfterSeconds: 30,
  },
  voice: {
    engine: "say" as const,
    piperBinary: "/opt/piper",
    piperModel: "/voices/alan.onnx",
    piperArabicModel: "/voices/ar.onnx",
    englishVoice: "Daniel",
    speakGreeting: true,
    arabicVoice: "Majed",
    greeting: { en: "Good {timeOfDay} sir, how can I help you today?", ar: "{timeOfDay} يا سيدي" },
  },
  brain: { systemPrompt: "You are Jarvis.", cwd: "/Users/x/.config/jarvis/brain" },
  whisper: { binaryPath: "/opt/whisper/bin/whisper-cli", modelPath: "/opt/whisper/model.bin" },
  performance: { suspendTabsAfterMinutes: 15, stopSidecarsAfterMinutes: 10, terminalScrollback: 5000 },
  browser: { allowPopups: true },
  sessions: { importWindowDays: 30 },
  sessionsDbPath: "/Users/x/.config/jarvis/sessions.db",
};


/**
 * Every section that is *not* the default, so that every "written only when
 * there is something to write" rule in toRawConfig actually fires. A draft
 * sitting on the defaults would let a missing section pass unnoticed —
 * which is exactly how `terminal:`, `workflows:` and `sessions:` came to be
 * dropped on save without anyone seeing it.
 */
const fullDraft: JarvisConfig = {
  ...draft,
  databases: { acme: [{ id: "db1", engine: "mysql" }] },
  editors: { acme: [{ name: "web", path: "packages/web" }] },
  clusters: { acme: [{ name: "dev", context: "ctx-a" }] },
  docker: { acme: [{ name: "api", container: "api-1" }] },
  chat: { acme: [{ name: "Team", driver: "slack" as const }] },
  workflows: { acme: "/Users/x/projects/acme/.jarvis/workflows" },
  terminal: {
    completion: { enabled: false, historyPath: "/h", commandLogPath: "/l" },
    blocks: { enabled: false, inputEditor: false },
    notifyAfterSeconds: 90,
  },
  performance: {
    suspendTabsAfterMinutes: 0,
    stopSidecarsAfterMinutes: 45,
    terminalScrollback: 20000,
  },
  browser: { allowPopups: false },
  sessions: { importWindowDays: 90 },
};

/**
 * What each JarvisConfig key must become in jarvis.yaml, or null for one the
 * file deliberately has no key for.
 *
 * Typed as `Record<keyof JarvisConfig, ...>` on purpose: TypeScript refuses
 * to compile this file until a newly added section appears here, and the
 * test below then refuses to pass until toRawConfig actually writes it.
 * toRawConfig is the sole allowlist of keys that reach the file, so a
 * section missing from it is *deleted from the user's config on the next
 * save* — silently, and with only a timestamped backup to recover from.
 * That had already happened to three sections when this table was written.
 */
const FILE_KEYS: Record<keyof JarvisConfig, readonly string[] | null> = {
  // The file has never had a `registry:` key; it holds these two instead.
  registry: ["agents", "routing"],
  projects: ["projects"],
  databases: ["databases"],
  editors: ["editors"],
  clusters: ["clusters"],
  docker: ["docker"],
  chat: ["chat"],
  workflows: ["workflows"],
  headlamp: ["headlamp"],
  terminal: ["terminal"],
  performance: ["performance"],
  browser: ["browser"],
  brain: ["brain"],
  voice: ["voice"],
  whisper: ["whisper"],
  sessions: ["sessions"],
  // Computed by parseConfig from the config directory, never a source of
  // truth. See toRawConfig's own note.
  sessionsDbPath: null,
};

describe("toRawConfig covers every section", () => {
  const raw = toRawConfig(fullDraft) as Record<string, unknown>;

  for (const [field, fileKeys] of Object.entries(FILE_KEYS)) {
    if (fileKeys === null) {
      it(`deliberately never writes ${field}`, () => {
        expect(raw).not.toHaveProperty(field);
      });
      continue;
    }
    it(`writes ${field} as ${fileKeys.join(" + ")}`, () => {
      for (const key of fileKeys) expect(raw[key]).toBeDefined();
    });
  }

  // The round trip is the claim that actually matters to a user: open
  // Settings, save, and the file still says what it said.
  it("survives a full round trip through parseConfig", () => {
    const reparsed = parseConfig(raw);

    expect(reparsed.terminal).toEqual(fullDraft.terminal);
    expect(reparsed.workflows).toEqual(fullDraft.workflows);
    expect(reparsed.sessions).toEqual(fullDraft.sessions);
    expect(reparsed.performance).toEqual(fullDraft.performance);
    expect(reparsed.browser).toEqual(fullDraft.browser);
    expect(reparsed.databases).toEqual(fullDraft.databases);
    expect(reparsed.editors).toEqual(fullDraft.editors);
    expect(reparsed.clusters).toEqual(fullDraft.clusters);
    expect(reparsed.docker).toEqual(fullDraft.docker);
    expect(reparsed.chat).toEqual(fullDraft.chat);
  });
});

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
      registry: { agents: { "claude-main": {} }, routing: [] },
      projects: {},
      brain: { cwd: "/tmp" },
      whisper: draft.whisper,
      sessionsDbPath: "x",
    };

    const result = validateDraft(invalid);

    expect(result).toEqual({
      ok: false,
      detail: "Config `agents.claude-main.command` must be a string",
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

  // toRawConfig is the sole allowlist of keys that reach the file, so a
  // section left out of it is deleted on the next save.
  it("writes performance only when it differs from the defaults", () => {
    expect(toRawConfig(draft)).not.toHaveProperty("performance");

    const raw = toRawConfig({
      ...draft,
      performance: {
        suspendTabsAfterMinutes: 0,
        stopSidecarsAfterMinutes: 10,
        terminalScrollback: 5000,
      },
    }) as Record<string, unknown>;
    expect(raw["performance"]).toEqual({
      suspendTabsAfterMinutes: 0,
      stopSidecarsAfterMinutes: 10,
      terminalScrollback: 5000,
    });
  });

  it("drops sessionsDbPath — the file has no key for it", () => {
    const raw = toRawConfig(draft) as Record<string, unknown>;

    expect(raw).not.toHaveProperty("sessionsDbPath");
  });

  it("writes only accountId/cwd/systemPrompt under brain, not the computed configDir", () => {
    const withAccount: JarvisConfig = {
      ...draft,
      brain: { ...draft.brain, accountId: "claude-main", configDir: "/Users/x/.claude-main" },
    };

    const raw = toRawConfig(withAccount) as { brain: Record<string, unknown> };

    expect(raw.brain).toEqual({
      accountId: "claude-main",
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
    expect(written.agents["claude-main"].command).toBe("claude-main");
    expect(written.routing[0].agent).toBe("claude-main");
  });

  // The bug this exists to prevent, spelled out end to end: open Settings,
  // change one thing, save — and the sections you never touched are still
  // in the file. Three of them were not, for months.
  it("keeps every section a save did not touch", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");
    await writeFile(path, "placeholder: true");

    const result = await writeSettingsFile(path, fullDraft);
    expect(result).toEqual({ ok: true });

    const written = parse(await readFile(path, "utf8"));
    expect(written.terminal.notifyAfterSeconds).toBe(90);
    expect(written.terminal.blocks).toEqual({ enabled: false, inputEditor: false });
    expect(written.workflows).toEqual(fullDraft.workflows);
    expect(written.sessions).toEqual({ importWindowDays: 90 });
    expect(written.performance.terminalScrollback).toBe(20000);

    // And the file loads back as the same config, which is the only claim
    // that really matters.
    const reloaded = parseConfig(written);
    expect(reloaded.terminal).toEqual(fullDraft.terminal);
    expect(reloaded.workflows).toEqual(fullDraft.workflows);
    expect(reloaded.sessions).toEqual(fullDraft.sessions);
  });

  // The other half of the rule: a section the user never wrote does not
  // appear just because they opened Settings once. jarvis.yaml is still
  // hand-edited, and an empty `sessions: {importWindowDays: 30}` growing out
  // of nowhere is noise.
  it("does not grow a section that is sitting on its defaults", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");
    await writeFile(path, "placeholder: true");

    await writeSettingsFile(path, draft);

    const written = parse(await readFile(path, "utf8"));
    expect(written).not.toHaveProperty("sessions");
    expect(written).not.toHaveProperty("performance");
    expect(written).not.toHaveProperty("workflows");
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
      registry: { agents: { "claude-main": {} }, routing: [] },
    } as unknown as JarvisConfig;
    const result = await writeSettingsFile(path, invalid);

    expect(result).toEqual({
      ok: false,
      detail: "Config `agents.claude-main.command` must be a string",
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

describe("editor roots round-trip", () => {
  it("keeps a project's roots through validateDraft", () => {
    const withEditors: JarvisConfig = {
      ...draft,
      editors: { acme: [{ name: "portal-vue", path: "portal-vue" }] },
    };

    const validated = validateDraft(withEditors);

    expect(validated.ok).toBe(true);
    expect(validated.ok && validated.value.editors["acme"]).toEqual([
      { name: "portal-vue", path: "portal-vue" },
    ]);
  });

  it("omits the editors key entirely when no project has a root", () => {
    const raw = toRawConfig(draft) as Record<string, unknown>;

    expect("editors" in raw).toBe(false);
  });

  it("writes the section to the file when there is one", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");

    await writeSettingsFile(path, {
      ...draft,
      editors: { acme: [{ name: "portal-vue", path: "portal-vue" }] },
    });

    expect(await readFile(path, "utf8")).toContain("editors:");
  });

  // A draft the UI could not produce but a hand-edited file could: the write
  // must be refused whole, not written and rejected at the next startup.
  it("refuses a draft whose root escapes the project", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");

    const result = await writeSettingsFile(path, {
      ...draft,
      editors: { acme: [{ name: "up", path: "../secrets" }] },
    });

    expect(result.ok).toBe(false);
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });
});

describe("clusters and headlamp round-trip", () => {
  it("preserves clusters and headlamp through a save it cannot edit", () => {
    const raw = toRawConfig({
      ...draft,
      clusters: { acme: [{ name: "dev", context: "arn:…:cluster/app_dev" }] },
      headlamp: { binary: "/opt/hl" },
    }) as Record<string, unknown>;

    expect(raw["clusters"]).toEqual({ acme: [{ name: "dev", context: "arn:…:cluster/app_dev" }] });
    expect(raw["headlamp"]).toEqual({ binary: "/opt/hl" });
  });

  it("omits the clusters key entirely when no project has one", () => {
    const raw = toRawConfig(draft) as Record<string, unknown>;

    expect("clusters" in raw).toBe(false);
  });

  it("still writes headlamp when the binary is the platform default", () => {
    const raw = toRawConfig(draft) as Record<string, unknown>;

    expect(raw["headlamp"]).toEqual({ binary: draft.headlamp.binary });
  });
});

describe("docker round-trip", () => {
  const withDocker: JarvisConfig = {
    ...draft,
    docker: { acme: [{ name: "app", container: "acme-app-1" }] },
  };

  it("writes the docker section", () => {
    const raw = toRawConfig(withDocker) as Record<string, unknown>;

    expect(raw["docker"]).toEqual({ acme: [{ name: "app", container: "acme-app-1" }] });
  });

  it("omits the docker key entirely when no project declares a container", () => {
    const raw = toRawConfig(draft) as Record<string, unknown>;

    expect("docker" in raw).toBe(false);
  });

  // The whole renderer→settings-io→file→parseConfig path, in one test: this
  // is the boundary a missing `docker` key in toRawConfig silently deleted,
  // and no test on either side of it could have caught that alone.
  it("survives writeSettingsFile → parseConfig unchanged", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");

    const result = await writeSettingsFile(path, withDocker);
    expect(result).toEqual({ ok: true });

    const written = parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(written["docker"]).toEqual({ acme: [{ name: "app", container: "acme-app-1" }] });
    expect(parseConfig(written).docker).toEqual({
      acme: [{ name: "app", container: "acme-app-1" }],
    });
  });

  // A user who hand-wrote `docker:` and then edits something unrelated in
  // Settings must not lose it — the second half of the same bug.
  it("keeps a hand-written docker section across an unrelated Settings save", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");
    await writeSettingsFile(path, withDocker);

    // What Settings would hand back after a read/edit cycle that never
    // touched the Docker page at all.
    const reread = parseConfig(parse(await readFile(path, "utf8")));
    await writeSettingsFile(path, { ...reread, brain: { ...reread.brain, systemPrompt: "Changed." } });

    const after = parseConfig(parse(await readFile(path, "utf8")));
    expect(after.docker).toEqual({ acme: [{ name: "app", container: "acme-app-1" }] });
    expect(after.brain.systemPrompt).toBe("Changed.");
  });
});

describe("chat round-trip", () => {
  const withChat: JarvisConfig = {
    ...draft,
    chat: { acme: [{ name: "Acme", driver: "slack", account: "acme" }] },
  };

  it("writes the chat section", () => {
    const raw = toRawConfig(withChat) as Record<string, unknown>;

    expect(raw["chat"]).toEqual({
      acme: [{ name: "Acme", driver: "slack", account: "acme" }],
    });
  });

  it("omits the chat key entirely when no project declares a chat", () => {
    const raw = toRawConfig(draft) as Record<string, unknown>;

    expect("chat" in raw).toBe(false);
  });

  // The same boundary the docker section lost a whole section to. A new
  // per-project section is not wired until this passes.
  it("survives writeSettingsFile → parseConfig unchanged", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");

    const result = await writeSettingsFile(path, withChat);
    expect(result).toEqual({ ok: true });

    const written = parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(parseConfig(written).chat).toEqual({
      acme: [{ name: "Acme", driver: "slack", account: "acme" }],
    });
  });

  it("keeps a hand-written chat section across an unrelated Settings save", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");
    await writeSettingsFile(path, withChat);

    const reread = parseConfig(parse(await readFile(path, "utf8")));
    await writeSettingsFile(path, { ...reread, brain: { ...reread.brain, systemPrompt: "Changed." } });

    const after = parseConfig(parse(await readFile(path, "utf8")));
    expect(after.chat).toEqual({
      acme: [{ name: "Acme", driver: "slack", account: "acme" }],
    });
  });

  // An entry with no account is the common case for a one-tenant Teams, and
  // an `account: undefined` key must not reach the YAML as a null.
  it("writes an entry with no account without an empty account key", async () => {
    const dir = await tempDir();
    const path = join(dir, "jarvis.yaml");
    await writeSettingsFile(path, { ...draft, chat: { acme: [{ name: "Globex", driver: "teams" }] } });

    const text = await readFile(path, "utf8");
    expect(text).not.toContain("account");
    expect(parseConfig(parse(text)).chat).toEqual({ acme: [{ name: "Globex", driver: "teams" }] });
  });
});
