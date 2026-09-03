import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { parse } from "yaml";
import { DEFAULT_GREETING } from "@jarvis/core";
import type { AgentConfig, ProviderVendor, RegistryConfig, RoutingRule } from "@jarvis/core";
import type {
  BrainConfig,
  ClustersConfig,
  DatabasesConfig,
  DbGateConnection,
  DbGateEngine,
  DockerConfig,
  EditorsConfig,
} from "@jarvis/platform";
import { DB_GATE_ENGINES, defaultHeadlampBinary } from "@jarvis/platform";
import { PERSONAL_PROJECT } from "./personal.js";

/** What Jarvis sounds like, and what it says on opening. */
export type VoiceConfig = {
  /** "piper" is a local neural engine and sounds markedly better than any
   *  macOS voice that can be installed without the GUI; "say" is macOS's own.
   *  Arabic always goes through `say`, whichever is chosen — a Piper model
   *  speaks one language. */
  engine: "piper" | "say";
  /** Absolute, because the app is launched from Finder and its PATH does not
   *  include ~/.local/bin. */
  piperBinary: string;
  piperModel: string;
  /** A `say -v` voice name. An unknown name makes macOS fall back to the
   *  system default silently rather than failing, so a typo here is quiet. */
  englishVoice: string;
  arabicVoice: string;
  /** The greeting, per language. `{timeOfDay}` becomes morning/afternoon/
   *  evening; `{ready}`, `{lastSession}` and `{uncommitted}` are available
   *  and left out of the default deliberately — see DEFAULT_GREETING. */
  greeting: { en: string; ar: string };
};

/**
 * The Terminal tab's own settings.
 *
 * `completion.enabled` is the single switch for the autocomplete feature,
 * and it reaches all the way down: false installs no ZDOTDIR wrapper
 * either, so the shell is started exactly as it was before the feature
 * existed. One switch, no half-state.
 */
export type TerminalConfig = {
  completion: {
    enabled: boolean;
    /** The shell history the suggestions are ranked from. Read, never
     *  written — Jarvis does not touch the user's history. */
    historyPath: string;
    /** Jarvis's own `<epoch>\t<cwd>\t<command>` log, written by the
     *  wrapper's preexec hook. It exists because zsh's history records no
     *  working directory and directory affinity needs one. */
    commandLogPath: string;
  };
};

export type JarvisConfig = {
  registry: RegistryConfig;
  projects: Record<string, string>;
  /** Per-project DbGate connections, keyed by project name. An absent
   *  `databases:` section parses to {} — a project with no entry spawns a
   *  DbGate that manages its own connections instead. */
  databases: DatabasesConfig;
  /** Per-project editor roots, keyed by project name. An absent `editors:`
   *  section parses to {} — a project with no entry opens the editor at the
   *  project directory, which is what every project did before this existed. */
  editors: EditorsConfig;
  /** Per-project Kubernetes contexts the Cluster button may open, keyed by
   *  project name. An absent `clusters:` section parses to {} — that
   *  project's button is disabled, like Personal's. */
  clusters: ClustersConfig;
  /** Per-project containers the Docker tab manages, keyed by project name.
   *  An absent `docker:` section parses to {} — that project's Docker
   *  button is disabled, like Personal's. */
  docker: DockerConfig;
  /** Where `headlamp-server` lives. Not on PATH and never will be: it is
   *  only distributed inside the Headlamp desktop bundle, so this is a
   *  declared path like `voice.piperBinary`, with a per-OS default. */
  headlamp: { binary: string };
  terminal: TerminalConfig;
  brain: BrainConfig;
  voice: VoiceConfig;
  whisper: { binaryPath: string; modelPath: string };
  /** How the transcript importer behaves. Absent from jarvis.yaml for
   *  everyone until they want to change it — the defaults are the whole
   *  point of the section. */
  sessions: { importWindowDays: number };
  // Beside jarvis.yaml itself, not user-configurable — see the note on
  // defaultSessionsDbPath().
  sessionsDbPath: string;
};

// `~/.config/jarvis/sessions.db`, beside the config file. Not exposed as a
// yaml setting (unlike brain.cwd or whisper paths) because the history
// store is Jarvis's own bookkeeping, not something a user has a reason to
// relocate — same reasoning DEFAULT_BRAIN_CWD documents for the brain's
// isolation directory below.
export function defaultSessionsDbPath(): string {
  return join(homedir(), ".config/jarvis/sessions.db");
}

const DEFAULT_SYSTEM_PROMPT = "You are Jarvis.";

/**
 * Daniel is macOS's British male voice, and the register the app is named
 * for. Left unset, `say` uses the system default, which is female — the
 * thing this default exists to change.
 *
 * Majed is the Arabic male voice, and was already what Arabic used.
 */
const DEFAULT_ENGLISH_VOICE = "Daniel";
const DEFAULT_ARABIC_VOICE = "Majed";

/**
 * Piper by default, falling back to `say` at runtime when the model is not
 * there. macOS ships only compact voices and its Enhanced downloads have no
 * command-line installer, so a local neural engine is the only good English
 * voice that can be set up without the user opening System Settings.
 */
const DEFAULT_ENGINE = "piper";
const DEFAULT_PIPER_BINARY = join(homedir(), ".local/bin/piper");
const DEFAULT_PIPER_MODEL = join(homedir(), ".config/jarvis/voices/en-gb-alan-low.onnx");

// A directory with no `.claude` project config of its own — see the
// isolation note on `BrainConfig.cwd` in @jarvis/platform. Headless SDK
// sessions inherit hooks and skills from their cwd, so this must never
// default to the repo or to `process.cwd()`.
const DEFAULT_BRAIN_CWD = join(homedir(), ".config/jarvis/brain");

/**
 * How far back the transcript backfill reaches, by file mtime.
 *
 * 30 days was 90 of the 125 transcripts on the machine this was designed
 * against, and 90 days was all of them — generous without being unbounded
 * on a machine with years of history.
 */
const DEFAULT_IMPORT_WINDOW_DAYS = 30;

const DEFAULT_WHISPER_BINARY_PATH = "~/.voicemode/services/whisper/build/bin/whisper-cli";
// large-v3-turbo, not base: synthesised-speech testing of the spec's own
// acceptance sentence showed base corrupting the Arabic project name
// itself ("سعودي سيل" -> "سعودي ينسيل"), which breaks project resolution
// since routing depends on that exact token. large-v3-turbo is already on
// disk at this path.
const DEFAULT_WHISPER_MODEL_PATH = "~/.whisper-models/ggml-large-v3-turbo.bin";

export function parseConfig(raw: unknown): JarvisConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config must be an object");
  }
  const root = raw as Record<string, unknown>;

  const agents = parseAgents(root["agents"]);

  const brain = root["brain"];
  if (typeof brain !== "object" || brain === null) {
    throw new Error("Config is missing a `brain` section");
  }
  const brainConfig = brain as Partial<BrainConfig>;

  const routing = parseRouting(root["routing"]);
  routing.forEach((rule, index) => {
    if (agents[rule.agent] === undefined) {
      throw new Error(`Config \`routing[${index}].agent\` names no configured agent: "${rule.agent}"`);
    }
  });
  const projects = parseProjects(root["projects"]);
  const databases = parseDatabases(root["databases"], projects);
  const editors = parseEditors(root["editors"], projects);
  const clusters = parseClusters(root["clusters"], projects);
  const docker = parseDocker(root["docker"], projects);
  const headlamp = parseHeadlamp(root["headlamp"]);
  const terminal = parseTerminal(root["terminal"]);
  const whisper = parseWhisper(root["whisper"]);
  const sessions = parseSessions(root["sessions"]);
  const voice = parseVoice(root["voice"]);

  const accountId = brainConfig.accountId;
  if (accountId !== undefined && typeof accountId !== "string") {
    throw new Error("Config `brain.accountId` must be a string");
  }
  let brainAccount: { accountId: string; configDir: string } | undefined;
  if (accountId !== undefined) {
    const agent = agents[accountId];
    if (agent === undefined) {
      throw new Error(`Config \`brain.accountId\` names no configured agent: "${accountId}"`);
    }
    if (agent.configDir === undefined) {
      throw new Error(`Config \`brain.accountId\` names "${accountId}", which declares no configDir`);
    }
    brainAccount = { accountId, configDir: agent.configDir };
  }

  return {
    registry: { agents, routing },
    projects: Object.fromEntries(
      Object.entries(projects).map(([name, path]) => [name, expandTilde(path)]),
    ),
    databases,
    editors,
    clusters,
    docker,
    headlamp,
    terminal,
    brain: {
      systemPrompt:
        typeof brainConfig.systemPrompt === "string"
          ? brainConfig.systemPrompt
          : DEFAULT_SYSTEM_PROMPT,
      cwd: expandTilde(typeof brainConfig.cwd === "string" ? brainConfig.cwd : DEFAULT_BRAIN_CWD),
      ...(brainAccount === undefined ? {} : brainAccount),
    },
    voice,
    whisper,
    sessions,
    sessionsDbPath: defaultSessionsDbPath(),
  };
}

/** Extracted so Settings (settings-io.ts, via main.ts) reads and writes the
 *  exact same file `loadConfig` reads at startup, rather than duplicating
 *  this path as a second literal that could drift from this one. */
export const DEFAULT_CONFIG_PATH = join(homedir(), ".config/jarvis/jarvis.yaml");

export async function loadConfig(path: string = DEFAULT_CONFIG_PATH): Promise<JarvisConfig> {
  const text = await readFile(path, "utf8");
  const config = parseConfig(parse(text));
  // The brain's cwd is Jarvis's own isolation artifact (see the note on
  // BrainConfig.cwd in @jarvis/platform), not something the user should
  // have to create by hand before first launch.
  await mkdir(config.brain.cwd, { recursive: true });
  return config;
}

function expandTilde(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

const VENDORS: readonly ProviderVendor[] = ["anthropic", "github", "openai"];

function isVendor(value: unknown): value is ProviderVendor {
  return VENDORS.some((vendor) => vendor === value);
}

function parseAgents(rawAgents: unknown): RegistryConfig["agents"] {
  if (typeof rawAgents !== "object" || rawAgents === null || Array.isArray(rawAgents)) {
    throw new Error("Config is missing an `agents` section");
  }

  const agents: RegistryConfig["agents"] = {};
  for (const [id, rawAgent] of Object.entries(rawAgents)) {
    if (typeof rawAgent !== "object" || rawAgent === null || Array.isArray(rawAgent)) {
      throw new Error(`Config \`agents.${id}\` must be an object`);
    }
    const agent = rawAgent as Partial<Omit<AgentConfig, "id">>;
    if (typeof agent.command !== "string") {
      throw new Error(`Config \`agents.${id}.command\` must be a string`);
    }
    if (agent.args !== undefined) {
      if (!Array.isArray(agent.args) || !agent.args.every((arg) => typeof arg === "string")) {
        throw new Error(`Config \`agents.${id}.args\` must be an array of strings`);
      }
    }
    if (agent.model !== undefined && typeof agent.model !== "string") {
      throw new Error(`Config \`agents.${id}.model\` must be a string`);
    }
    if (agent.default !== undefined && typeof agent.default !== "boolean") {
      throw new Error(`Config \`agents.${id}.default\` must be a boolean`);
    }
    if (agent.configDir !== undefined && typeof agent.configDir !== "string") {
      throw new Error(`Config \`agents.${id}.configDir\` must be a string`);
    }
    if (agent.vendor !== undefined && !isVendor(agent.vendor)) {
      throw new Error(
        `Config \`agents.${id}.vendor\` must be one of: ${VENDORS.join(", ")}`,
      );
    }
    agents[id] = {
      command: agent.command,
      ...(agent.args === undefined ? {} : { args: agent.args }),
      ...(agent.model === undefined ? {} : { model: agent.model }),
      ...(agent.default === undefined ? {} : { default: agent.default }),
      ...(agent.configDir === undefined ? {} : { configDir: expandTilde(agent.configDir) }),
      ...(agent.vendor === undefined ? {} : { vendor: agent.vendor }),
    };
  }
  return agents;
}

function parseRouting(rawRouting: unknown): RoutingRule[] {
  if (rawRouting === undefined) {
    return [];
  }
  if (!Array.isArray(rawRouting)) {
    throw new Error("Config `routing` must be a list");
  }

  return rawRouting.map((rawRule, index) => {
    if (typeof rawRule !== "object" || rawRule === null || Array.isArray(rawRule)) {
      throw new Error(`Config \`routing[${index}]\` must be an object`);
    }
    const rule = rawRule as Partial<RoutingRule>;
    if (typeof rule.agent !== "string") {
      throw new Error(`Config \`routing[${index}].agent\` must be a string`);
    }
    if (typeof rule.match !== "object" || rule.match === null || Array.isArray(rule.match)) {
      throw new Error(`Config \`routing[${index}].match\` must be an object`);
    }
    const match = rule.match;
    if (match.project !== undefined && typeof match.project !== "string") {
      throw new Error(`Config \`routing[${index}].match.project\` must be a string`);
    }
    if (match.intent !== undefined && typeof match.intent !== "string") {
      throw new Error(`Config \`routing[${index}].match.intent\` must be a string`);
    }
    return {
      agent: rule.agent,
      match: {
        ...(match.project === undefined ? {} : { project: match.project }),
        ...(match.intent === undefined ? {} : { intent: match.intent }),
      },
    };
  });
}

function parseSessions(rawSessions: unknown): { importWindowDays: number } {
  if (rawSessions === undefined) {
    return { importWindowDays: DEFAULT_IMPORT_WINDOW_DAYS };
  }
  if (typeof rawSessions !== "object" || rawSessions === null || Array.isArray(rawSessions)) {
    throw new Error("Config `sessions` must be an object");
  }
  const sessions = rawSessions as Record<string, unknown>;
  const window = sessions["importWindowDays"];
  if (window === undefined) {
    return { importWindowDays: DEFAULT_IMPORT_WINDOW_DAYS };
  }
  // Rejected rather than clamped: a window of zero or a string imports
  // nothing, and silently reads as a bug in the importer rather than in
  // the config line that caused it.
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) {
    throw new Error("Config `sessions.importWindowDays` must be a positive number");
  }
  return { importWindowDays: window };
}

function parseWhisper(rawWhisper: unknown): { binaryPath: string; modelPath: string } {
  if (rawWhisper === undefined) {
    return {
      binaryPath: expandTilde(DEFAULT_WHISPER_BINARY_PATH),
      modelPath: expandTilde(DEFAULT_WHISPER_MODEL_PATH),
    };
  }
  if (typeof rawWhisper !== "object" || rawWhisper === null || Array.isArray(rawWhisper)) {
    throw new Error("Config `whisper` must be an object");
  }
  const whisper = rawWhisper as Record<string, unknown>;
  if (whisper["binaryPath"] !== undefined && typeof whisper["binaryPath"] !== "string") {
    throw new Error("Config `whisper.binaryPath` must be a string");
  }
  if (whisper["modelPath"] !== undefined && typeof whisper["modelPath"] !== "string") {
    throw new Error("Config `whisper.modelPath` must be a string");
  }
  return {
    binaryPath: expandTilde(
      typeof whisper["binaryPath"] === "string" ? whisper["binaryPath"] : DEFAULT_WHISPER_BINARY_PATH,
    ),
    modelPath: expandTilde(
      typeof whisper["modelPath"] === "string" ? whisper["modelPath"] : DEFAULT_WHISPER_MODEL_PATH,
    ),
  };
}

// A DbGate connection id is interpolated straight into environment
// variable *names* (SERVER_main, PASSWORD_MODE_main, …), so it is held to
// what a variable name may contain rather than to what YAML will accept.
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * `databases:` maps a project name to that project's DbGate connections.
 * Validated against the already-parsed `projects` for the same reason
 * routing rules are validated against agents: a section keyed to a project
 * that does not exist can never be opened, and saying so at load time beats
 * a Database button that silently does nothing.
 *
 * The section is optional and an absent one is not an error — every
 * jarvis.yaml written before this feature existed keeps loading unchanged.
 */
function parseDatabases(rawDatabases: unknown, projects: Record<string, string>): DatabasesConfig {
  if (rawDatabases === undefined) return {};
  if (typeof rawDatabases !== "object" || rawDatabases === null || Array.isArray(rawDatabases)) {
    throw new Error("Config `databases` must be an object");
  }

  const result: DatabasesConfig = {};
  for (const [project, rawList] of Object.entries(rawDatabases as Record<string, unknown>)) {
    if (projects[project] === undefined) {
      throw new Error(`Config \`databases\` names no configured project: "${project}"`);
    }
    if (!Array.isArray(rawList)) {
      throw new Error(`Config \`databases.${project}\` must be an array`);
    }

    const seen = new Set<string>();
    result[project] = rawList.map((rawEntry, index) => {
      const where = `databases.${project}[${index}]`;
      if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
        throw new Error(`Config \`${where}\` must be an object`);
      }
      const entry = rawEntry as Record<string, unknown>;

      const id = entry["id"];
      if (typeof id !== "string" || id === "") {
        throw new Error(`Config \`${where}.id\` must be a non-empty string`);
      }
      if (!CONNECTION_ID_PATTERN.test(id)) {
        throw new Error(`Config \`${where}.id\` must contain only letters, digits and underscores`);
      }
      if (seen.has(id)) {
        throw new Error(`Config \`${where}.id\` duplicates an earlier connection: "${id}"`);
      }
      seen.add(id);

      const engine = entry["engine"];
      if (typeof engine !== "string" || !DB_GATE_ENGINES.includes(engine as DbGateEngine)) {
        throw new Error(`Config \`${where}.engine\` must be one of ${DB_GATE_ENGINES.join(", ")}`);
      }

      const port = entry["port"];
      if (port !== undefined && typeof port !== "number") {
        throw new Error(`Config \`${where}.port\` must be a number`);
      }
      const readonly = entry["readonly"];
      if (readonly !== undefined && typeof readonly !== "boolean") {
        throw new Error(`Config \`${where}.readonly\` must be true or false`);
      }

      const connection: DbGateConnection = { id, engine: engine as DbGateEngine };
      for (const key of ["label", "host", "user", "database", "file", "passwordEnv"] as const) {
        const value = entry[key];
        if (value === undefined) continue;
        if (typeof value !== "string") {
          throw new Error(`Config \`${where}.${key}\` must be a string`);
        }
        connection[key] = value;
      }
      if (port !== undefined) connection.port = port;
      if (readonly !== undefined) connection.readonly = readonly;
      return connection;
    });
  }
  return result;
}

/**
 * `editors:` maps a project name to the folders inside it the Editor button
 * can be rooted at:
 *
 *     editors:
 *       acme:
 *         - { name: portal-vue, path: portal-vue }
 *         - { name: api, path: services/api }
 *
 * Validated against the already-parsed `projects` for the same reason
 * parseDatabases is: a section keyed to a project that does not exist can
 * never be opened.
 *
 * `path` is relative to the project and stays that way. Absolute (and
 * therefore `~`-prefixed) paths are refused rather than expanded, for two
 * reasons worth stating: an editor root is a *narrowing* of a project — the
 * project directory is what its terminal, git view and API tab all key off,
 * and a root outside it would be an editor onto something none of them can
 * see — and keeping it relative makes "stays inside the project" decidable
 * here, on the string, with no filesystem to consult. The code-server
 * manager checks containment again before it spawns; this is the layer that
 * makes the escape impossible to write down in the first place.
 *
 * The section is optional and an absent one is not an error — most projects
 * will never have an entry, and they keep opening at their own root.
 */
function parseEditors(rawEditors: unknown, projects: Record<string, string>): EditorsConfig {
  if (rawEditors === undefined) return {};
  if (typeof rawEditors !== "object" || rawEditors === null || Array.isArray(rawEditors)) {
    throw new Error("Config `editors` must be an object");
  }

  const result: EditorsConfig = {};
  for (const [project, rawList] of Object.entries(rawEditors as Record<string, unknown>)) {
    if (projects[project] === undefined) {
      throw new Error(`Config \`editors\` names no configured project: "${project}"`);
    }
    if (!Array.isArray(rawList)) {
      throw new Error(`Config \`editors.${project}\` must be an array`);
    }

    const seen = new Set<string>();
    result[project] = rawList.map((rawEntry, index) => {
      const where = `editors.${project}[${index}]`;
      if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
        throw new Error(`Config \`${where}\` must be an object`);
      }
      const entry = rawEntry as Record<string, unknown>;

      const name = entry["name"];
      if (typeof name !== "string" || name === "") {
        throw new Error(`Config \`${where}.name\` must be a non-empty string`);
      }
      if (seen.has(name)) {
        throw new Error(`Config \`${where}.name\` duplicates an earlier root: "${name}"`);
      }
      seen.add(name);

      const path = entry["path"];
      if (typeof path !== "string" || path === "") {
        throw new Error(`Config \`${where}.path\` must be a non-empty string`);
      }
      if (isAbsolute(path) || path.startsWith("~")) {
        throw new Error(`Config \`${where}.path\` must be relative to the project`);
      }
      // normalize collapses "services/../.." to ".." — the only form an
      // escape can take once absolutes are already out.
      const normalized = normalize(path);
      if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
        throw new Error(`Config \`${where}.path\` must stay inside the project`);
      }

      return { name, path };
    });
  }
  return result;
}

/**
 * The `clusters:` section — the same shape as `editors:`, and validated the
 * same way, minus the containment rules: a context is a name in the user's
 * kubeconfig, not a path, so there is nothing to escape from.
 *
 * It deliberately does not check a context against ~/.kube/config. That
 * would mean reading the kubeconfig at startup and refusing to launch
 * Jarvis at all over a cluster the user was not going to open; a context
 * that is missing or renamed surfaces when the button is pressed instead.
 */
function parseClusters(rawClusters: unknown, projects: Record<string, string>): ClustersConfig {
  if (rawClusters === undefined) return {};
  if (typeof rawClusters !== "object" || rawClusters === null || Array.isArray(rawClusters)) {
    throw new Error("Config `clusters` must be an object");
  }

  const result: ClustersConfig = {};
  for (const [project, rawList] of Object.entries(rawClusters as Record<string, unknown>)) {
    if (projects[project] === undefined) {
      throw new Error(`Config \`clusters\` names no configured project: "${project}"`);
    }
    if (!Array.isArray(rawList)) {
      throw new Error(`Config \`clusters.${project}\` must be an array`);
    }

    const seen = new Set<string>();
    result[project] = rawList.map((rawEntry, index) => {
      const where = `clusters.${project}[${index}]`;
      if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
        throw new Error(`Config \`${where}\` must be an object`);
      }
      const entry = rawEntry as Record<string, unknown>;

      const name = entry["name"];
      if (typeof name !== "string" || name === "") {
        throw new Error(`Config \`${where}.name\` must be a non-empty string`);
      }
      if (seen.has(name)) {
        throw new Error(`Config \`${where}.name\` duplicates an earlier cluster: "${name}"`);
      }
      seen.add(name);

      const context = entry["context"];
      if (typeof context !== "string" || context === "") {
        throw new Error(`Config \`${where}.context\` must be a non-empty string`);
      }

      return { name, context };
    });
  }
  return result;
}

/** `docker:` is keyed by project name, exactly as `clusters:` is, and is
 *  rejected on the same three grounds: a key naming no configured project,
 *  an empty display name, an empty container name. Duplicate display names
 *  within one project are rejected too — the Docker tab keys its rows by
 *  that name, so two rows called "app" would be indistinguishable. */
function parseDocker(rawDocker: unknown, projects: Record<string, string>): DockerConfig {
  if (rawDocker === undefined) return {};
  if (typeof rawDocker !== "object" || rawDocker === null || Array.isArray(rawDocker)) {
    throw new Error("Config `docker` must be an object");
  }

  const result: DockerConfig = {};
  for (const [project, rawList] of Object.entries(rawDocker as Record<string, unknown>)) {
    if (projects[project] === undefined) {
      throw new Error(`Config \`docker\` names no configured project: "${project}"`);
    }
    if (!Array.isArray(rawList)) {
      throw new Error(`Config \`docker.${project}\` must be an array`);
    }

    const seen = new Set<string>();
    result[project] = rawList.map((rawEntry, index) => {
      const where = `docker.${project}[${index}]`;
      if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
        throw new Error(`Config \`${where}\` must be an object`);
      }
      const entry = rawEntry as Record<string, unknown>;

      const name = entry["name"];
      if (typeof name !== "string" || name === "") {
        throw new Error(`Config \`${where}.name\` must be a non-empty string`);
      }
      if (seen.has(name)) {
        throw new Error(`Config \`${where}.name\` duplicates an earlier container: "${name}"`);
      }
      seen.add(name);

      const container = entry["container"];
      if (typeof container !== "string" || container === "") {
        throw new Error(`Config \`${where}.container\` must be a non-empty string`);
      }

      return { name, container };
    });
  }
  return result;
}

// The user's history, read and never written. zsh's default HISTFILE, and
// the file this design's frequency analysis was built from.
const DEFAULT_HISTORY_PATH = join(homedir(), ".zsh_history");
// Jarvis's own log lives with Jarvis's own bookkeeping, beside jarvis.yaml
// — the same reasoning defaultSessionsDbPath() documents.
const DEFAULT_COMMAND_LOG_PATH = join(homedir(), ".config/jarvis/terminal-commands.log");

/**
 * The `terminal:` section. Every field has a default and the whole section
 * is optional, so a jarvis.yaml written before autocomplete existed keeps
 * loading and gets the feature — this is preference, not configuration the
 * app cannot run without.
 */
function parseTerminal(rawTerminal: unknown): TerminalConfig {
  const defaults: TerminalConfig = {
    completion: {
      enabled: true,
      historyPath: DEFAULT_HISTORY_PATH,
      commandLogPath: DEFAULT_COMMAND_LOG_PATH,
    },
  };
  if (rawTerminal === undefined) return defaults;
  if (typeof rawTerminal !== "object" || rawTerminal === null || Array.isArray(rawTerminal)) {
    throw new Error("Config `terminal` must be an object");
  }

  const rawCompletion = (rawTerminal as Record<string, unknown>)["completion"];
  if (rawCompletion === undefined) return defaults;
  if (
    typeof rawCompletion !== "object" ||
    rawCompletion === null ||
    Array.isArray(rawCompletion)
  ) {
    throw new Error("Config `terminal.completion` must be an object");
  }
  const completion = rawCompletion as Record<string, unknown>;

  const enabled = completion["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("Config `terminal.completion.enabled` must be true or false");
  }
  const path = (key: "historyPath" | "commandLogPath", fallback: string): string => {
    const value = completion[key];
    if (value === undefined) return fallback;
    if (typeof value !== "string" || value === "") {
      throw new Error(`Config \`terminal.completion.${key}\` must be a non-empty string`);
    }
    return expandTilde(value);
  };

  return {
    completion: {
      enabled: enabled ?? true,
      historyPath: path("historyPath", DEFAULT_HISTORY_PATH),
      commandLogPath: path("commandLogPath", DEFAULT_COMMAND_LOG_PATH),
    },
  };
}

/** The `headlamp:` section. One key, with a per-OS default, so an absent
 *  section is not an error — only a binary that turns out not to exist is,
 *  and that is the manager's failure to report, not this one's. */
function parseHeadlamp(rawHeadlamp: unknown): { binary: string } {
  const fallback = { binary: defaultHeadlampBinary(process.platform, process.env) };
  if (rawHeadlamp === undefined) return fallback;
  if (typeof rawHeadlamp !== "object" || rawHeadlamp === null || Array.isArray(rawHeadlamp)) {
    throw new Error("Config `headlamp` must be an object");
  }
  const binary = (rawHeadlamp as Record<string, unknown>)["binary"];
  if (binary === undefined) return fallback;
  if (typeof binary !== "string" || binary === "") {
    throw new Error("Config `headlamp.binary` must be a non-empty string");
  }
  return { binary: expandTilde(binary) };
}

/**
 * The `voice:` section. Every field has a default, so an absent section — or
 * an absent field within it — is not an error: this is preference, not
 * configuration the app cannot run without.
 */
function parseVoice(rawVoice: unknown): VoiceConfig {
  const defaults: VoiceConfig = {
    engine: DEFAULT_ENGINE,
    piperBinary: DEFAULT_PIPER_BINARY,
    piperModel: DEFAULT_PIPER_MODEL,
    englishVoice: DEFAULT_ENGLISH_VOICE,
    arabicVoice: DEFAULT_ARABIC_VOICE,
    greeting: { ...DEFAULT_GREETING },
  };
  if (rawVoice === undefined) return defaults;
  if (typeof rawVoice !== "object" || rawVoice === null || Array.isArray(rawVoice)) {
    throw new Error("Config `voice` must be an object");
  }

  const voice = rawVoice as Record<string, unknown>;
  const text = (key: string, fallback: string): string => {
    const value = voice[key];
    if (value === undefined) return fallback;
    if (typeof value !== "string") throw new Error(`Config \`voice.${key}\` must be a string`);
    return value;
  };

  const rawGreeting = voice["greeting"];
  if (
    rawGreeting !== undefined &&
    (typeof rawGreeting !== "object" || rawGreeting === null || Array.isArray(rawGreeting))
  ) {
    throw new Error("Config `voice.greeting` must be an object");
  }
  const greeting = (rawGreeting ?? {}) as Record<string, unknown>;
  for (const language of ["en", "ar"] as const) {
    const value = greeting[language];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`Config \`voice.greeting.${language}\` must be a string`);
    }
  }

  const engine = voice["engine"];
  if (engine !== undefined && engine !== "piper" && engine !== "say") {
    throw new Error("Config `voice.engine` must be piper or say");
  }

  return {
    engine: engine ?? DEFAULT_ENGINE,
    piperBinary: expandTilde(text("piperBinary", DEFAULT_PIPER_BINARY)),
    piperModel: expandTilde(text("piperModel", DEFAULT_PIPER_MODEL)),
    englishVoice: text("englishVoice", DEFAULT_ENGLISH_VOICE),
    arabicVoice: text("arabicVoice", DEFAULT_ARABIC_VOICE),
    greeting: {
      en: typeof greeting["en"] === "string" ? greeting["en"] : DEFAULT_GREETING.en,
      ar: typeof greeting["ar"] === "string" ? greeting["ar"] : DEFAULT_GREETING.ar,
    },
  };
}

function parseProjects(rawProjects: unknown): Record<string, string> {
  if (rawProjects === undefined) {
    return {};
  }
  if (typeof rawProjects !== "object" || rawProjects === null || Array.isArray(rawProjects)) {
    throw new Error("Config `projects` must be an object");
  }

  const projects: Record<string, string> = {};
  for (const [name, path] of Object.entries(rawProjects)) {
    // The personal browser is this key with no path behind it, and the
    // whole of its isolation is that `projects` never contains it: every
    // consumer that needs a directory (Editor, Database, Terminal, API,
    // git polling, the Changes view, session routing) resolves a project
    // through this map and refuses what is missing. See personal.ts.
    if (name === PERSONAL_PROJECT) {
      throw new Error(`Config \`projects.${name}\` uses a name reserved for the personal browser`);
    }
    if (typeof path !== "string") {
      throw new Error(`Config \`projects.${name}\` must be a string`);
    }
    projects[name] = path;
  }
  return projects;
}
