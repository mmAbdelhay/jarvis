import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { defaultSessionsDbPath, ensureConfigFile, loadConfig, parseConfig } from "./config.js";

const valid = {
  agents: { "claude-main": { command: "claude-main", model: "opus", default: true } },
  routing: [{ match: { project: "acme" }, agent: "claude-main" }],
  projects: { acme: "~/projects/acme" },
  brain: { systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain" },
};

describe("parseConfig", () => {
  it("maps agents and routing into a registry config", () => {
    const config = parseConfig(valid);
    expect(config.registry.agents["claude-main"]?.command).toBe("claude-main");
    expect(config.registry.routing?.[0]?.agent).toBe("claude-main");
  });

  it("rejects a routing rule whose agent names no configured agent", () => {
    const raw = {
      agents: { "claude-main": { command: "claude-main" } },
      brain: { cwd: "/tmp/brain" },
      routing: [{ match: { project: "acme" }, agent: "claude-typo" }],
    };

    expect(() => parseConfig(raw)).toThrow(
      'Config `routing[0].agent` names no configured agent: "claude-typo"',
    );
  });

  it("accepts a routing rule whose agent matches a configured one", () => {
    const raw = {
      agents: { "claude-main": { command: "claude-main" } },
      brain: { cwd: "/tmp/brain" },
      routing: [{ match: { project: "acme" }, agent: "claude-main" }],
    };

    expect(() => parseConfig(raw)).not.toThrow();
  });

  it("expands a leading tilde in project paths", () => {
    const config = parseConfig(valid);
    expect(config.projects["acme"]?.startsWith("~")).toBe(false);
    expect(config.projects["acme"]).toContain("/projects/acme");
  });

  it("leaves absolute project paths untouched", () => {
    const config = parseConfig({ ...valid, projects: { a: "/tmp/a" } });
    expect(config.projects["a"]).toBe("/tmp/a");
  });

  it("throws when agents is missing", () => {
    expect(() => parseConfig({ projects: {}, brain: valid.brain })).toThrow(/agents/);
  });

  it("throws when brain is missing or not an object", () => {
    expect(() => parseConfig({ ...valid, brain: undefined })).toThrow(/brain/);
    expect(() => parseConfig({ ...valid, brain: "nope" })).toThrow(/brain/);
  });

  it("defaults routing to an empty list", () => {
    const config = parseConfig({ ...valid, routing: undefined });
    expect(config.registry.routing).toEqual([]);
  });

  it("throws when a routing entry is missing agent", () => {
    expect(() =>
      parseConfig({ ...valid, routing: [{ match: { project: "x" } }] }),
    ).toThrow(/routing\[0\]\.agent/);
  });

  it("throws when an agent entry is not an object", () => {
    expect(() => parseConfig({ ...valid, agents: { foo: "not-an-object" } })).toThrow(
      /agents\.foo/,
    );
  });

  // The personal browser is a project key that deliberately has no path.
  // A jarvis.yaml that claimed it would give it a directory, and with it an
  // Editor, a Terminal and a place in git polling — the exact opposite of
  // what it is for. See personal.ts.
  it("refuses a project that claims the reserved personal key", () => {
    expect(() => parseConfig({ ...valid, projects: { __personal__: "/tmp/p" } })).toThrow(
      /__personal__/,
    );
  });

  it("throws when a projects value is not a string", () => {
    expect(() => parseConfig({ ...valid, projects: { acme: 123 } })).toThrow(
      /projects\.acme/,
    );
  });

  it("throws when agents is an array", () => {
    expect(() => parseConfig({ ...valid, agents: [] })).toThrow(/agents/);
  });

  // 30 days is 90 of the 125 transcripts on the machine this was measured
  // against, and 90 days is all of them — generous without being unbounded
  // on a machine with years of history.
  it("defaults the session import window to 30 days", () => {
    expect(parseConfig(valid).sessions.importWindowDays).toBe(30);
  });

  it("uses a configured session import window", () => {
    expect(
      parseConfig({ ...valid, sessions: { importWindowDays: 90 } }).sessions.importWindowDays,
    ).toBe(90);
  });

  it("throws when sessions.importWindowDays is not a number", () => {
    expect(() => parseConfig({ ...valid, sessions: { importWindowDays: "90" } })).toThrow(
      /sessions\.importWindowDays/,
    );
  });

  it("throws when sessions.importWindowDays is not positive", () => {
    // A window of zero would import nothing and read as a bug in the
    // importer rather than in the config that caused it.
    expect(() => parseConfig({ ...valid, sessions: { importWindowDays: 0 } })).toThrow(
      /sessions\.importWindowDays/,
    );
  });

  it("throws when sessions is not an object", () => {
    expect(() => parseConfig({ ...valid, sessions: [] })).toThrow(/sessions/);
  });

  // The three numbers of the memory pass. Every one has a default, and 0
  // restores exactly what Jarvis did before the section existed.
  it("defaults the performance section when it is absent", () => {
    expect(parseConfig(valid).performance).toEqual({
      suspendTabsAfterMinutes: 15,
      stopSidecarsAfterMinutes: 10,
      terminalScrollback: 5000,
    });
  });

  it("reads the performance section, and takes 0 as off", () => {
    expect(
      parseConfig({
        ...valid,
        performance: {
          suspendTabsAfterMinutes: 0,
          stopSidecarsAfterMinutes: 30,
          terminalScrollback: 20000,
        },
      }).performance,
    ).toEqual({
      suspendTabsAfterMinutes: 0,
      stopSidecarsAfterMinutes: 30,
      terminalScrollback: 20000,
    });
  });

  it("keeps the defaults for the performance keys a config does not name", () => {
    expect(
      parseConfig({ ...valid, performance: { terminalScrollback: 100 } }).performance,
    ).toEqual({
      suspendTabsAfterMinutes: 15,
      stopSidecarsAfterMinutes: 10,
      terminalScrollback: 100,
    });
  });

  it("throws when a performance value is negative or not a number", () => {
    expect(() =>
      parseConfig({ ...valid, performance: { suspendTabsAfterMinutes: -1 } }),
    ).toThrow(/performance\.suspendTabsAfterMinutes/);
    expect(() => parseConfig({ ...valid, performance: { terminalScrollback: "lots" } })).toThrow(
      /performance\.terminalScrollback/,
    );
  });

  it("throws when performance is not an object", () => {
    expect(() => parseConfig({ ...valid, performance: [] })).toThrow(/performance/);
  });

  it("defaults the whisper paths when the section is absent", () => {
    const config = parseConfig(valid);
    expect(config.whisper.binaryPath).toContain("whisper-cli");
    expect(config.whisper.binaryPath.startsWith("~")).toBe(false);
  });

  // Important 7: base corrupts the Arabic project name itself in testing,
  // returning a similar-sounding word that names no project — so the shipped
  // default must be large-v3-turbo, not base.
  it("defaults to the large-v3-turbo whisper model, expanded", () => {
    const config = parseConfig(valid);
    expect(config.whisper.modelPath).toContain("ggml-large-v3-turbo.bin");
    expect(config.whisper.modelPath.startsWith("~")).toBe(false);
  });

  it("uses explicit whisper paths and expands a leading tilde", () => {
    const config = parseConfig({
      ...valid,
      whisper: { binaryPath: "~/custom/whisper-cli", modelPath: "/models/ggml.bin" },
    });
    expect(config.whisper.binaryPath.startsWith("~")).toBe(false);
    expect(config.whisper.binaryPath).toContain("/custom/whisper-cli");
    expect(config.whisper.modelPath).toBe("/models/ggml.bin");
  });

  it("throws when whisper.binaryPath is not a string", () => {
    expect(() => parseConfig({ ...valid, whisper: { binaryPath: 123 } })).toThrow(
      /whisper\.binaryPath/,
    );
  });

  it("throws when whisper is not an object", () => {
    expect(() => parseConfig({ ...valid, whisper: "nope" })).toThrow(/whisper/);
  });

  // Critical 3: the shipped example config sets `brain.cwd: ~/.config/jarvis/brain`,
  // and `~/…` resolved against the SDK's own working-directory logic (not
  // the shell) is not a real path — every turn would fail.
  it("expands a leading tilde in brain.cwd", () => {
    const config = parseConfig({ ...valid, brain: { ...valid.brain, cwd: "~/.config/jarvis/brain" } });
    expect(config.brain.cwd.startsWith("~")).toBe(false);
    expect(config.brain.cwd).toContain("/.config/jarvis/brain");
  });

  it("expands a leading tilde in the default brain.cwd", () => {
    const config = parseConfig({ ...valid, brain: { systemPrompt: "You are Jarvis." } });
    expect(config.brain.cwd.startsWith("~")).toBe(false);
    expect(config.brain.cwd).toContain("/.config/jarvis/brain");
  });

  it("leaves an absolute brain.cwd untouched", () => {
    const config = parseConfig(valid);
    expect(config.brain.cwd).toBe("/tmp/jarvis-brain");
  });

  it("points sessionsDbPath at sessions.db beside the config directory", () => {
    const config = parseConfig(valid);
    expect(config.sessionsDbPath).toBe(join(homedir(), ".config/jarvis/sessions.db"));
    expect(config.sessionsDbPath).toBe(defaultSessionsDbPath());
  });
});

// The example is the file a new machine is told to copy (see SETUP.md), and
// nothing else reads it — so without this it can drift out of parseConfig's
// reach silently, and the first person to find out is someone whose Jarvis
// will not start.
describe("the shipped example config", () => {
  const examplePath = fileURLToPath(new URL("../../../config/jarvis.example.yaml", import.meta.url));

  it("parses", () => {
    const config = parseConfig(parse(readFileSync(examplePath, "utf8")));

    expect(Object.keys(config.projects)).toContain("orbit");
    expect(config.chat["acme"]).toEqual([
      { name: "Acme", driver: "slack", account: "acme" },
    ]);
    expect(config.chat["orbit"]).toEqual([{ name: "Globex", driver: "teams" }]);
  });
});

describe("ensureConfigFile", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // Jarvis read jarvis.yaml with a plain readFile and let the startup catch
  // turn a missing one into "Jarvis failed to start" and a quit. That is the
  // right contract for a file the user wrote and then broke; it is the wrong
  // one for a machine that has never run Jarvis, where it means a downloaded
  // build opens a dialog and dies. First run now gets a working file, which
  // Settings can then edit in place.
  it("writes a starting config when there is none", async () => {
    dir = await mkdtemp(join(tmpdir(), "jarvis-first-run-"));
    const path = join(dir, "nested", "jarvis.yaml");

    const created = await ensureConfigFile(path);

    expect(created).toBe(true);
    // Whatever is seeded has to survive the very parser about to read it,
    // or first run trades one failure dialog for another.
    expect(() => parseConfig(parse(readFileSync(path, "utf8")))).not.toThrow();
  });

  // The file is the user's the moment it exists — including one they cut
  // down on purpose, and one that is invalid because they are mid-edit.
  it("never touches a config that is already there", async () => {
    dir = await mkdtemp(join(tmpdir(), "jarvis-first-run-"));
    const path = join(dir, "jarvis.yaml");
    await writeFile(path, "agents: {}\n", "utf8");

    const created = await ensureConfigFile(path);

    expect(created).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("agents: {}\n");
  });

  // Nothing seeded may depend on a path existing: a new machine has no
  // projects checked out, and a missing agent command is reported as a
  // broken agent at startup rather than refusing to open.
  it("seeds an agent and a brain, and no projects", async () => {
    dir = await mkdtemp(join(tmpdir(), "jarvis-first-run-"));
    const path = join(dir, "jarvis.yaml");
    await ensureConfigFile(path);

    const config = parseConfig(parse(readFileSync(path, "utf8")));

    expect(Object.keys(config.registry.agents)).toContain("claude");
    expect(config.projects).toEqual({});
  });
});

describe("loadConfig", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("creates the brain cwd directory if it does not already exist", async () => {
    dir = await mkdtemp(join(tmpdir(), "jarvis-config-test-"));
    const brainCwd = join(dir, "brain-does-not-exist-yet");
    const configPath = join(dir, "jarvis.yaml");
    await writeFile(
      configPath,
      [
        "agents:",
        "  claude-main:",
        "    command: claude-main",
        "    default: true",
        "brain:",
        "  systemPrompt: You are Jarvis.",
        `  cwd: ${brainCwd}`,
      ].join("\n"),
    );

    const config = await loadConfig(configPath);

    expect(config.brain.cwd).toBe(brainCwd);
    const stats = await stat(brainCwd);
    expect(stats.isDirectory()).toBe(true);
  });
});

describe("agent provider fields", () => {
  it("parses configDir and vendor, expanding a tilde in configDir", () => {
    const config = parseConfig({
      agents: {
        "claude-main": { command: "claude-main", configDir: "~/.claude-main", vendor: "anthropic" },
      },
      brain: {},
    });
    expect(config.registry.agents["claude-main"]?.configDir).toBe(join(homedir(), ".claude-main"));
    expect(config.registry.agents["claude-main"]?.vendor).toBe("anthropic");
  });

  it("leaves both fields absent when the config omits them", () => {
    const config = parseConfig({ agents: { copilot: { command: "copilot" } }, brain: {} });
    expect(config.registry.agents["copilot"]).not.toHaveProperty("configDir");
    expect(config.registry.agents["copilot"]).not.toHaveProperty("vendor");
  });

  it("rejects a vendor it does not know rather than passing it through", () => {
    expect(() =>
      parseConfig({ agents: { x: { command: "x", vendor: "acme" } }, brain: {} }),
    ).toThrow(/vendor/);
  });

  it("rejects a non-string configDir", () => {
    expect(() =>
      parseConfig({ agents: { x: { command: "x", configDir: 7 } }, brain: {} }),
    ).toThrow(/configDir/);
  });
});

describe("brain.accountId", () => {
  it("resolves the named account's config dir onto the brain config", () => {
    const config = parseConfig({
      agents: { "claude-main": { command: "claude-main", configDir: "/c/mm" } },
      brain: { accountId: "claude-main" },
    });
    expect(config.brain.accountId).toBe("claude-main");
    expect(config.brain.configDir).toBe("/c/mm");
  });

  it("rejects an accountId that names no agent, rather than silently ignoring it", () => {
    expect(() =>
      parseConfig({ agents: { "claude-main": { command: "claude-main" } }, brain: { accountId: "ghost" } }),
    ).toThrow(/accountId/);
  });

  it("rejects an accountId whose agent declares no configDir", () => {
    expect(() =>
      parseConfig({ agents: { copilot: { command: "copilot" } }, brain: { accountId: "copilot" } }),
    ).toThrow(/configDir/);
  });

  it("leaves the brain unchanged when accountId is absent", () => {
    const config = parseConfig({ agents: { x: { command: "x" } }, brain: {} });
    expect(config.brain).not.toHaveProperty("accountId");
    expect(config.brain).not.toHaveProperty("configDir");
  });
});

describe("databases", () => {
  const base = {
    agents: { "claude-main": { command: "claude-main", default: true } },
    brain: { cwd: "/tmp/brain" },
    projects: { "storefront": "/p/storefront" },
  };

  it("defaults to an empty record when the section is absent", () => {
    expect(parseConfig(base).databases).toEqual({});
  });

  it("parses a connection list for a configured project", () => {
    const config = parseConfig({
      ...base,
      databases: {
        "storefront": [
          {
            id: "main",
            label: "Sail (local)",
            engine: "mysql",
            host: "127.0.0.1",
            port: 3306,
            user: "sail",
            database: "store_saas",
            passwordEnv: "STORE_SAAS_DB_PASSWORD",
          },
        ],
      },
    });

    expect(config.databases["storefront"]).toEqual([
      {
        id: "main",
        label: "Sail (local)",
        engine: "mysql",
        host: "127.0.0.1",
        port: 3306,
        user: "sail",
        database: "store_saas",
        passwordEnv: "STORE_SAAS_DB_PASSWORD",
      },
    ]);
  });

  it("keeps a connection that declares nothing but an id and an engine", () => {
    const config = parseConfig({ ...base, databases: { "storefront": [{ id: "main", engine: "sqlite" }] } });

    expect(config.databases["storefront"]).toEqual([{ id: "main", engine: "sqlite" }]);
  });

  it("rejects a key naming no configured project", () => {
    expect(() => parseConfig({ ...base, databases: { nope: [] } })).toThrow(
      'Config `databases` names no configured project: "nope"',
    );
  });

  it("rejects an unknown engine", () => {
    expect(() =>
      parseConfig({ ...base, databases: { "storefront": [{ id: "main", engine: "oracle" }] } }),
    ).toThrow("Config `databases.storefront[0].engine` must be one of mysql, mariadb, postgres, sqlite");
  });

  it("rejects a duplicate id within one project", () => {
    expect(() =>
      parseConfig({
        ...base,
        databases: {
          "storefront": [
            { id: "main", engine: "mysql" },
            { id: "main", engine: "mysql" },
          ],
        },
      }),
    ).toThrow('Config `databases.storefront[1].id` duplicates an earlier connection: "main"');
  });

  it("rejects an id that is not usable as an environment-variable suffix", () => {
    expect(() =>
      parseConfig({ ...base, databases: { "storefront": [{ id: "main db", engine: "mysql" }] } }),
    ).toThrow("Config `databases.storefront[0].id` must contain only letters, digits and underscores");
  });

  it("rejects a non-numeric port", () => {
    expect(() =>
      parseConfig({
        ...base,
        databases: { "storefront": [{ id: "main", engine: "mysql", port: "3306" }] },
      }),
    ).toThrow("Config `databases.storefront[0].port` must be a number");
  });

  it("rejects a project whose value is not an array", () => {
    expect(() => parseConfig({ ...base, databases: { "storefront": {} } })).toThrow(
      "Config `databases.storefront` must be an array",
    );
  });

  it("rejects a non-boolean readonly", () => {
    expect(() =>
      parseConfig({
        ...base,
        databases: { "storefront": [{ id: "main", engine: "mysql", readonly: "yes" }] },
      }),
    ).toThrow("Config `databases.storefront[0].readonly` must be true or false");
  });
});

describe("voice", () => {
  const base = {
    agents: { a: { command: "a", default: true } },
    brain: { cwd: "/tmp/brain" },
  };

  // Left unset, `say` uses the system default, which is female — the thing
  // this default exists to change.
  it("defaults to the British male voice and the plain greeting", () => {
    const config = parseConfig(base);

    expect(config.voice.englishVoice).toBe("Daniel");
    expect(config.voice.arabicVoice).toBe("Majed");
    expect(config.voice.greeting.en).toBe("Good {timeOfDay} sir, how can I help you today?");
  });

  // The greeting is the one thing the app says without being asked, and
  // someone who works next to other people needs it to stop talking without
  // losing the greeting itself — the text still arrives in the panel.
  it("speaks the greeting unless told not to", () => {
    expect(parseConfig(base).voice.speakGreeting).toBe(true);
    expect(parseConfig({ ...base, voice: { speakGreeting: false } }).voice.speakGreeting).toBe(false);
  });

  it("refuses a speakGreeting that is not a boolean", () => {
    expect(() => parseConfig({ ...base, voice: { speakGreeting: "no" } })).toThrow(
      "Config `voice.speakGreeting` must be a boolean",
    );
  });

  // A sign-in or Meet popup that opens as a tab loses its link back to the
  // page that opened it, so real popups are the default; turning them off
  // puts back the tab behaviour.
  it("allows popups unless told not to", () => {
    expect(parseConfig(base).browser.allowPopups).toBe(true);
    expect(parseConfig({ ...base, browser: {} }).browser.allowPopups).toBe(true);
    expect(parseConfig({ ...base, browser: { allowPopups: false } }).browser.allowPopups).toBe(false);
  });

  it("refuses an allowPopups that is not a boolean", () => {
    expect(() => parseConfig({ ...base, browser: { allowPopups: "yes" } })).toThrow(
      "Config `browser.allowPopups` must be a boolean",
    );
    expect(() => parseConfig({ ...base, browser: ["x"] })).toThrow("Config `browser` must be an object");
  });

  it("takes the configured voices and greetings", () => {
    const config = parseConfig({
      ...base,
      voice: {
        englishVoice: "Oliver",
        arabicVoice: "Tarik",
        greeting: { en: "Evening, boss.", ar: "مرحبا" },
      },
    });

    expect(config.voice).toMatchObject({
      englishVoice: "Oliver",
      arabicVoice: "Tarik",
      greeting: { en: "Evening, boss.", ar: "مرحبا" },
    });
  });

  // Preference, not configuration the app cannot run without: a half-filled
  // section keeps the defaults for the rest.
  it("fills a missing field from the defaults", () => {
    const config = parseConfig({ ...base, voice: { englishVoice: "Oliver" } });

    expect(config.voice.englishVoice).toBe("Oliver");
    expect(config.voice.arabicVoice).toBe("Majed");
    expect(config.voice.greeting.en).toContain("{timeOfDay}");
  });

  it("rejects a section that is not an object", () => {
    expect(() => parseConfig({ ...base, voice: "loud" })).toThrow("Config `voice` must be an object");
  });

  it("rejects a voice name that is not a string", () => {
    expect(() => parseConfig({ ...base, voice: { englishVoice: 7 } })).toThrow(
      "Config `voice.englishVoice` must be a string",
    );
  });

  // Piper is the default because macOS ships only compact voices and its
  // Enhanced downloads have no command-line installer.
  it("defaults to the piper engine, with absolute paths", () => {
    const config = parseConfig(base);

    expect(config.voice.engine).toBe("piper");
    expect(config.voice.piperBinary.startsWith("/")).toBe(true);
    expect(config.voice.piperModel.endsWith(".onnx")).toBe(true);
  });

  it("takes say as the engine when asked", () => {
    expect(parseConfig({ ...base, voice: { engine: "say" } }).voice.engine).toBe("say");
  });

  it("rejects an engine it does not have", () => {
    expect(() => parseConfig({ ...base, voice: { engine: "elevenlabs" } })).toThrow(
      "Config `voice.engine` must be piper or say",
    );
  });

  it("rejects a greeting that is not a string", () => {
    expect(() => parseConfig({ ...base, voice: { greeting: { en: 7 } } })).toThrow(
      "Config `voice.greeting.en` must be a string",
    );
  });
});

describe("editors", () => {
  const base = {
    agents: { "claude-main": { command: "claude-main", default: true } },
    brain: { cwd: "/tmp/brain" },
    projects: { acme: "/p/acme" },
  };

  it("defaults to an empty record when the section is absent", () => {
    expect(parseConfig(base).editors).toEqual({});
  });

  it("parses a project's editor roots", () => {
    const config = parseConfig({
      ...base,
      editors: {
        acme: [
          { name: "portal-vue", path: "portal-vue" },
          { name: "api", path: "services/api" },
        ],
      },
    });

    expect(config.editors["acme"]).toEqual([
      { name: "portal-vue", path: "portal-vue" },
      { name: "api", path: "services/api" },
    ]);
  });

  // The path is kept exactly as written: it is relative to the project, and
  // resolving it here would make Settings write an absolute path back into
  // a file the user still edits by hand.
  it("keeps the path relative rather than resolving it against the project", () => {
    const config = parseConfig({ ...base, editors: { acme: [{ name: "a", path: "./portal-vue/" }] } });

    expect(config.editors["acme"]).toEqual([{ name: "a", path: "./portal-vue/" }]);
  });

  it("rejects a key naming no configured project", () => {
    expect(() => parseConfig({ ...base, editors: { nope: [] } })).toThrow(
      'Config `editors` names no configured project: "nope"',
    );
  });

  it("rejects a list that is not an array", () => {
    expect(() => parseConfig({ ...base, editors: { acme: {} } })).toThrow(
      "Config `editors.acme` must be an array",
    );
  });

  it("rejects an entry with no name", () => {
    expect(() => parseConfig({ ...base, editors: { acme: [{ path: "portal-vue" }] } })).toThrow(
      "Config `editors.acme[0].name` must be a non-empty string",
    );
  });

  it("rejects an entry with no path", () => {
    expect(() => parseConfig({ ...base, editors: { acme: [{ name: "a" }] } })).toThrow(
      "Config `editors.acme[0].path` must be a non-empty string",
    );
  });

  it("rejects a duplicate name within one project", () => {
    expect(() =>
      parseConfig({
        ...base,
        editors: {
          acme: [
            { name: "api", path: "services/api" },
            { name: "api", path: "other" },
          ],
        },
      }),
    ).toThrow('Config `editors.acme[1].name` duplicates an earlier root: "api"');
  });

  // A root that escapes its project can never be opened — the code-server
  // manager refuses it — so it is refused here, where the user is looking
  // at the config, rather than as a dead Editor menu entry later.
  it("rejects a path that climbs out of the project", () => {
    expect(() => parseConfig({ ...base, editors: { acme: [{ name: "up", path: "../secrets" }] } })).toThrow(
      "Config `editors.acme[0].path` must stay inside the project",
    );
  });

  it("rejects a path that climbs out through a subdirectory", () => {
    expect(() =>
      parseConfig({ ...base, editors: { acme: [{ name: "up", path: "services/../../etc" }] } }),
    ).toThrow("Config `editors.acme[0].path` must stay inside the project");
  });

  it("rejects an absolute path", () => {
    expect(() => parseConfig({ ...base, editors: { acme: [{ name: "etc", path: "/etc" }] } })).toThrow(
      "Config `editors.acme[0].path` must be relative to the project",
    );
  });

  // `~` is expanded everywhere else in this file, and would be a home-
  // relative — that is, absolute — path here. Refused with the message that
  // names the actual rule rather than being silently expanded.
  it("rejects a home-relative path", () => {
    expect(() => parseConfig({ ...base, editors: { acme: [{ name: "home", path: "~/x" }] } })).toThrow(
      "Config `editors.acme[0].path` must be relative to the project",
    );
  });

  it("accepts the project directory itself, written as .", () => {
    const config = parseConfig({ ...base, editors: { acme: [{ name: "all", path: "." }] } });

    expect(config.editors["acme"]).toEqual([{ name: "all", path: "." }]);
  });
});

describe("clusters", () => {
  const base = {
    agents: { "claude-main": { command: "claude-main", default: true } },
    brain: { cwd: "/tmp/brain" },
    projects: { acme: "/p/acme" },
  };

  it("parses a project's clusters in config order", () => {
    const config = parseConfig({
      ...base,
      clusters: {
        acme: [
          { name: "dev", context: "arn:aws:eks:eu-west-1:123456789012:cluster/app_dev" },
          { name: "chaos", context: "arn:aws:eks:eu-west-1:123456789012:cluster/app_staging" },
        ],
      },
    });
    expect(config.clusters["acme"]).toEqual([
      { name: "dev", context: "arn:aws:eks:eu-west-1:123456789012:cluster/app_dev" },
      { name: "chaos", context: "arn:aws:eks:eu-west-1:123456789012:cluster/app_staging" },
    ]);
  });

  it("parses a project's docker containers in config order", () => {
    const config = parseConfig({
      ...base,
      docker: {
        acme: [
          { name: "app", container: "acme-app-1" },
          { name: "mysql", container: "acme-mysql-1" },
        ],
      },
    });
    expect(config.docker["acme"]).toEqual([
      { name: "app", container: "acme-app-1" },
      { name: "mysql", container: "acme-mysql-1" },
    ]);
  });

  it("parses an absent docker section as an empty map", () => {
    expect(parseConfig(base).docker).toEqual({});
  });

  it("rejects a docker key that names no configured project", () => {
    expect(() =>
      parseConfig({ ...base, docker: { nope: [{ name: "a", container: "c" }] } }),
    ).toThrow(/names no configured project/);
  });

  it("rejects a docker entry with an empty name", () => {
    expect(() =>
      parseConfig({ ...base, docker: { acme: [{ name: "", container: "c" }] } }),
    ).toThrow(/name/);
  });

  it("rejects a docker entry with an empty container", () => {
    expect(() =>
      parseConfig({ ...base, docker: { acme: [{ name: "a", container: "" }] } }),
    ).toThrow(/container/);
  });

  it("rejects two docker entries with the same name in one project", () => {
    expect(() =>
      parseConfig({
        ...base,
        docker: {
          acme: [
            { name: "app", container: "one" },
            { name: "app", container: "two" },
          ],
        },
      }),
    ).toThrow(/duplicates an earlier container/);
  });

  it("parses a project's chat entries in config order", () => {
    const config = parseConfig({
      ...base,
      chat: {
        acme: [
          { name: "Acme", driver: "slack", account: "acme" },
          { name: "Vendors", driver: "teams" },
        ],
      },
    });
    expect(config.chat["acme"]).toEqual([
      { name: "Acme", driver: "slack", account: "acme" },
      { name: "Vendors", driver: "teams" },
    ]);
  });

  it("parses an absent chat section as an empty map", () => {
    expect(parseConfig(base).chat).toEqual({});
  });

  it("rejects a chat key that names no configured project", () => {
    expect(() =>
      parseConfig({ ...base, chat: { nope: [{ name: "a", driver: "slack" }] } }),
    ).toThrow(/names no configured project/);
  });

  it("rejects a chat entry with an empty name", () => {
    expect(() =>
      parseConfig({ ...base, chat: { acme: [{ name: "", driver: "slack" }] } }),
    ).toThrow(/name/);
  });

  it("rejects a chat entry whose driver is not one this build knows", () => {
    expect(() =>
      parseConfig({ ...base, chat: { acme: [{ name: "a", driver: "discord" }] } }),
    ).toThrow(/driver/);
  });

  // An empty account is not the same as an absent one: absent means "the
  // provider's own picker", while "" would build https://.slack.com/.
  it("rejects a chat entry with an empty account rather than treating it as absent", () => {
    expect(() =>
      parseConfig({
        ...base,
        chat: { acme: [{ name: "a", driver: "slack", account: "" }] },
      }),
    ).toThrow(/account/);
  });

  it("rejects two chat entries with the same name in one project", () => {
    expect(() =>
      parseConfig({
        ...base,
        chat: {
          acme: [
            { name: "Chat", driver: "slack" },
            { name: "Chat", driver: "teams" },
          ],
        },
      }),
    ).toThrow(/duplicates an earlier chat/);
  });

  it("defaults to no clusters when the section is absent", () => {
    expect(parseConfig(base).clusters).toEqual({});
  });

  it("refuses a project it does not know", () => {
    expect(() =>
      parseConfig({ ...base, clusters: { nope: [{ name: "d", context: "c" }] } }),
    ).toThrow(/names no configured project/);
  });

  it("refuses an empty name", () => {
    expect(() =>
      parseConfig({ ...base, clusters: { acme: [{ name: "", context: "c" }] } }),
    ).toThrow(/`clusters.acme\[0\].name` must be a non-empty string/);
  });

  it("refuses an empty context", () => {
    expect(() =>
      parseConfig({ ...base, clusters: { acme: [{ name: "d", context: "" }] } }),
    ).toThrow(/`clusters.acme\[0\].context` must be a non-empty string/);
  });

  it("refuses two clusters of one project sharing a name", () => {
    expect(() =>
      parseConfig({
        ...base,
        clusters: { acme: [{ name: "dev", context: "a" }, { name: "dev", context: "b" }] },
      }),
    ).toThrow(/duplicates an earlier cluster/);
  });

  it("takes headlamp.binary when given, and leaves the default to the caller when not", () => {
    expect(parseConfig({ ...base, headlamp: { binary: "/opt/hl" } }).headlamp.binary).toBe("/opt/hl");
    // Undefined, not a per-OS path: resolving one here would mean reading
    // process.platform during config parsing, and this assertion would then
    // hold only on the OS it happened to run on. main.ts fills it in with
    // defaultHeadlampBinary, which headlamp.test.ts covers for all three.
    expect(parseConfig(base).headlamp.binary).toBeUndefined();
  });

  it("expands a tilde in headlamp.binary", () => {
    expect(parseConfig({ ...base, headlamp: { binary: "~/hl" } }).headlamp.binary).toBe(
      join(homedir(), "hl"),
    );
  });
});

describe("terminal completion", () => {
  const base = {
    agents: { "claude-main": { command: "claude-main", default: true } },
    brain: { cwd: "/tmp/brain" },
    projects: { acme: "/p/acme" },
  };

  // On by default: every jarvis.yaml written before this feature existed
  // gets it, and a user who wants their terminal exactly as zsh gives it
  // has one line to write.
  it("defaults completion on, reading the user's own zsh history", () => {
    const { completion } = parseConfig(base).terminal;

    expect(completion.enabled).toBe(true);
    expect(completion.historyPath).toBe(join(homedir(), ".zsh_history"));
    expect(completion.commandLogPath).toBe(join(homedir(), ".config/jarvis/terminal-commands.log"));
  });

  it("accepts terminal.completion.enabled: false", () => {
    const raw = { ...base, terminal: { completion: { enabled: false } } };

    expect(parseConfig(raw).terminal.completion.enabled).toBe(false);
  });

  it("takes a configured history path, expanding a leading tilde", () => {
    const raw = { ...base, terminal: { completion: { historyPath: "~/.histfile" } } };

    expect(parseConfig(raw).terminal.completion.historyPath).toBe(join(homedir(), ".histfile"));
  });

  it("takes a configured command-log path", () => {
    const raw = { ...base, terminal: { completion: { commandLogPath: "/tmp/cmd.log" } } };

    expect(parseConfig(raw).terminal.completion.commandLogPath).toBe("/tmp/cmd.log");
  });

  it("keeps the defaults for the fields a partial section leaves out", () => {
    const raw = { ...base, terminal: { completion: { enabled: false } } };

    expect(parseConfig(raw).terminal.completion.historyPath).toBe(join(homedir(), ".zsh_history"));
  });

  it("refuses a non-boolean terminal.completion.enabled", () => {
    const raw = { ...base, terminal: { completion: { enabled: "yes" } } };

    expect(() => parseConfig(raw)).toThrow(/terminal\.completion\.enabled/);
  });

  it("refuses a non-string terminal.completion.historyPath", () => {
    const raw = { ...base, terminal: { completion: { historyPath: 7 } } };

    expect(() => parseConfig(raw)).toThrow(/terminal\.completion\.historyPath/);
  });

  it("refuses a terminal section that is not an object", () => {
    expect(() => parseConfig({ ...base, terminal: "on" })).toThrow(/`terminal`/);
  });
});

describe("terminal blocks and notifications", () => {
  const base = {
    agents: { "claude-main": { command: "claude-main", default: true } },
    brain: { cwd: "/tmp/brain" },
    projects: { acme: "/p/acme" },
  };

  it("defaults blocks and the input editor on, and notifications to thirty seconds", () => {
    const config = parseConfig(base);
    expect(config.terminal.blocks).toEqual({ enabled: true, inputEditor: true });
    expect(config.terminal.notifyAfterSeconds).toBe(30);
  });

  it("takes blocks off without touching completion", () => {
    const raw = { ...base, terminal: { blocks: { enabled: false } } };

    const config = parseConfig(raw);
    expect(config.terminal.blocks.enabled).toBe(false);
    expect(config.terminal.completion.enabled).toBe(true);
  });

  it("takes completion off without touching blocks", () => {
    const raw = { ...base, terminal: { completion: { enabled: false } } };

    const config = parseConfig(raw);
    expect(config.terminal.completion.enabled).toBe(false);
    expect(config.terminal.blocks).toEqual({ enabled: true, inputEditor: true });
  });

  it("rejects a non-boolean blocks switch", () => {
    const raw = { ...base, terminal: { blocks: { enabled: "sometimes" } } };

    expect(() => parseConfig(raw)).toThrow(/terminal\.blocks\.enabled/);
  });

  it("rejects a non-boolean input editor switch", () => {
    const raw = { ...base, terminal: { blocks: { inputEditor: "sometimes" } } };

    expect(() => parseConfig(raw)).toThrow(/terminal\.blocks\.inputEditor/);
  });

  it("rejects a negative notification threshold", () => {
    const raw = { ...base, terminal: { notifyAfterSeconds: -1 } };

    expect(() => parseConfig(raw)).toThrow(/terminal\.notifyAfterSeconds/);
  });

  it("accepts 0 to disable notifications", () => {
    const raw = { ...base, terminal: { notifyAfterSeconds: 0 } };

    expect(parseConfig(raw).terminal.notifyAfterSeconds).toBe(0);
  });

  it("rejects a non-number notification threshold", () => {
    const raw = { ...base, terminal: { notifyAfterSeconds: "soon" } };

    expect(() => parseConfig(raw)).toThrow(/terminal\.notifyAfterSeconds/);
  });
});

describe("workflows", () => {
  const base = {
    agents: { "claude-main": { command: "claude-main", default: true } },
    brain: { cwd: "/tmp/brain" },
    projects: { acme: "/p/acme" },
  };

  it("defaults to an empty record when the section is absent — a jarvis.yaml written before workflows existed keeps loading", () => {
    expect(parseConfig(base).workflows).toEqual({});
  });

  it("parses a project's workflow directory", () => {
    const config = parseConfig({
      ...base,
      workflows: { acme: "/p/acme/.jarvis/workflows" },
    });

    expect(config.workflows["acme"]).toBe("/p/acme/.jarvis/workflows");
  });

  it("expands a leading ~ the same way other paths in config do", () => {
    const config = parseConfig({ ...base, workflows: { acme: "~/workflows" } });

    expect(config.workflows["acme"]).toBe(join(homedir(), "workflows"));
  });

  it("rejects a key naming no configured project", () => {
    expect(() => parseConfig({ ...base, workflows: { nope: "/x" } })).toThrow(
      'Config `workflows` names no configured project: "nope"',
    );
  });

  it("rejects a non-string directory", () => {
    expect(() => parseConfig({ ...base, workflows: { acme: 7 } })).toThrow(
      "Config `workflows.acme` must be a non-empty string",
    );
  });

  it("rejects a workflows section that is not an object", () => {
    expect(() => parseConfig({ ...base, workflows: ["nope"] })).toThrow(
      "Config `workflows` must be an object",
    );
  });
});
