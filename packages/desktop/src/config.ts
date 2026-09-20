import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { isAbsolute, join, normalize, sep } from "node:path";
import { parse } from "yaml";
import { DEFAULT_GREETING } from "@jarvis/core";
import type { AgentConfig, ProviderVendor, RegistryConfig, RoutingRule } from "@jarvis/core";
import type {
  BrainConfig,
  ChatConfig,
  ClustersConfig,
  DatabasesConfig,
  DbGateConnection,
  DbGateEngine,
  DockerConfig,
  EditorsConfig,
  WorkflowsConfig,
} from "@jarvis/platform";
import { DB_GATE_ENGINES, isChatDriver } from "@jarvis/platform";
import { PERSONAL_PROJECT } from "./personal.js";

export function providerAgentListsEqual(
  left: readonly AgentConfig[],
  right: readonly AgentConfig[],
): boolean {
  return (
    left.length === right.length &&
    left.every((agent, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        agent.id === other.id &&
        agent.command === other.command &&
        agent.vendor === other.vendor
      );
    })
  );
}

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
  /** The Arabic .onnx model. A Piper model speaks one language, and on a
   *  platform with no system voices this is the only thing that can speak
   *  Arabic — see RoutedSpeech. */
  piperArabicModel: string;
  /** A `say -v` voice name. An unknown name makes macOS fall back to the
   *  system default silently rather than failing, so a typo here is quiet. */
  englishVoice: string;
  arabicVoice: string;
  /** The greeting, per language. `{timeOfDay}` becomes morning/afternoon/
   *  evening; `{ready}`, `{lastSession}` and `{uncommitted}` are available
   *  and left out of the default deliberately — see DEFAULT_GREETING. */
  greeting: { en: string; ar: string };
  /** Whether the greeting is spoken as well as shown. The launch greeting
   *  is the only thing Jarvis ever says unprompted, so this is the switch
   *  for working somewhere that has to stay quiet. It silences the speech
   *  alone: the same text still arrives in the conversation panel, because
   *  what it reports (how long since the last session, what is ready) is
   *  worth reading even when it is not worth hearing. */
  speakGreeting: boolean;
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
  /** Blocks, and the DOM input editor that only exists inside them. Two
   *  switches rather than one: the editor is the invasive half, and turning
   *  it off must not cost the user their blocks. */
  blocks: { enabled: boolean; inputEditor: boolean };
  /** A command that finishes after this many seconds with its pane
   *  unfocused raises a notification. 0 disables it. */
  notifyAfterSeconds: number;
};

/**
 * The `performance:` section — the three numbers that trade a little
 * freshness for a lot of memory.
 *
 * Every one has a default that is the recommended setting, and 0 means
 * "never do this", which restores exactly the behaviour Jarvis had before
 * the section existed. That escape hatch is the point: these are the only
 * settings in the file that can make the app *lose* something (a page
 * reload, a sidecar restart) to save resident memory, so turning each off
 * has to be one number.
 */
export type PerformanceConfig = {
  /** A Workspace tab hidden this long loses the Chromium renderer behind it
   *  — 80-150 MB each. The tab stays; clicking it rebuilds the page. */
  suspendTabsAfterMinutes: number;
  /** A code-server, DbGate or Headlamp instance no live tab needs any more
   *  is stopped after this long, and starts again on the next open. */
  stopSidecarsAfterMinutes: number;
  /** Lines of scrollback each terminal keeps. xterm stores a line as
   *  `Uint32Array(cols * 3)` — 12 bytes per cell — so at 200 columns every
   *  1000 lines is ~2.4 MB *per pane*, and a split tab has one pane per
   *  leaf. */
  terminalScrollback: number;
};

/**
 * The `browser:` section — how the Workspace's hosted pages behave.
 */
export type BrowserConfig = {
  /** Whether a page's `window.open` popup (a sign-in window, a Meet
   *  "present" window) opens as a real window that keeps its link back to
   *  the page that opened it. Off, every popup opens as an ordinary tab
   *  instead, which is what Jarvis always did — and which breaks any flow
   *  that needs the popup to report back to its opener. Links with
   *  target=_blank open as tabs either way. */
  allowPopups: boolean;
  /** What a new Workspace tab opens instead of the built-in blank/search
   *  page, when set. http(s) only — a `jarvis:` or `file:` page (or
   *  anything else `new URL` cannot parse) is refused at parse time rather
   *  than reaching openTab, and absent keeps today's behaviour. */
  homePage?: string;
};

export type PrayerConfig = {
  enabled: boolean;
  location?: { latitude: number; longitude: number; name: string };
  /** Optional, like `location` above: absent means "use the defaults"
   *  (before-notification on, 10 minutes ahead, at-time on) rather than
   *  "notifications off" — prayer notifications are on by default whenever
   *  `enabled` is true, and the user turns them off in Settings. */
  notify?: { before: boolean; beforeMinutes: number; atTime: boolean };
};

/**
 * The `remote:` section: whether a paired phone may reach this machine, and
 * on which address.
 *
 * Absent means the bridge does not exist, and an absent section parses to
 * exactly DEFAULT_REMOTE: off, loopback, no proxy, no push. That is the
 * spec's non-negotiable — a fresh jarvis.yaml has no `remote:` section at
 * all, so upgrading Jarvis can never open a port — and it is why
 * settings-io writes the section back only when it says something the
 * defaults do not.
 *
 * Milestone 3 only parses and edits this. Nothing listens yet.
 */
export type RemoteConfig = {
  enabled: boolean;
  /** An IP literal, never a hostname: a hostname is a DNS lookup in a
   *  security-relevant position. Settings' picker fills it in. */
  bindAddress: string;
  /** 0 asks the OS for a free port; the pairing QR carries whichever it got. */
  port: number;
  /** Separate consent from `enabled`: it widens what a paired phone can open
   *  (Editor, Database, Cluster), and it needs a real certificate. */
  sidecarProxy: boolean;
  /** Both paths or neither. Neither means a self-signed certificate, minted
   *  once and pinned through the pairing QR. */
  tls: { certPath?: string; keyPath?: string };
  /** The one part of the feature that involves a third party. */
  push: { enabled: boolean; includeProjectNames: boolean };
  /** 0 = never; otherwise the bridge turns itself off after this long idle. */
  idleDisableMinutes: number;
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
  /** Per-project chat destinations the Chat button may open, keyed by
   *  project name. An absent `chat:` section parses to {} — that project's
   *  Chat button is disabled, like Personal's. */
  chat: ChatConfig;
  /** Per-project saved-workflow directories, keyed by project name, on top
   *  of the always-read `~/.config/jarvis/workflows/`. An absent
   *  `workflows:` section parses to {} — every project still gets the
   *  always-read directory, which is what every project had before this
   *  existed. */
  workflows: WorkflowsConfig;
  /** Where `headlamp-server` lives. Not on PATH and never will be: it is
   *  only distributed inside the Headlamp desktop bundle, so this is a
   *  declared path like `voice.piperBinary`, with a per-OS default. */
  /** Where `headlamp-server` lives, when the user has said. Undefined means
   *  they have not, and the per-OS default applies — resolved by main.ts
   *  with `defaultHeadlampBinary`, not here. Config parsing is pure and
   *  knows nothing about the host it is running on. */
  headlamp: { binary: string | undefined };
  terminal: TerminalConfig;
  performance: PerformanceConfig;
  browser: BrowserConfig;
  prayer: PrayerConfig;
  brain: BrainConfig;
  voice: VoiceConfig;
  whisper: { binaryPath: string; modelPath: string };
  /** How the transcript importer behaves. Absent from jarvis.yaml for
   *  everyone until they want to change it — the defaults are the whole
   *  point of the section. */
  sessions: { importWindowDays: number };
  /** The `remote:` section. Absent from jarvis.yaml for everyone who has
   *  never turned it on — see RemoteConfig. */
  remote: RemoteConfig;
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

// `~/.config/jarvis/sessions-scan.json`, beside the config file — the last
// process scan's externally-discovered rows (see session-scan-cache.ts),
// so they still show at the next launch, unchanged, until the user presses
// Refresh. Not a yaml setting, same reasoning as defaultSessionsDbPath()
// above: it is Jarvis's own bookkeeping, not something to relocate.
export function defaultSessionsScanPath(): string {
  return join(homedir(), ".config/jarvis/sessions-scan.json");
}

// The always-read workflow directory, on top of whatever `workflows:`
// names for the current project — every project gets these, which is why
// it lives beside jarvis.yaml rather than under a project root.
export function defaultWorkflowsDir(): string {
  return join(homedir(), ".config/jarvis/workflows");
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
const DEFAULT_PIPER_ARABIC_MODEL = join(homedir(), ".config/jarvis/voices/ar_JO-kareem-low.onnx");

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
// acceptance sentence showed base corrupting the Arabic project name itself
// — returning a similar-sounding word that names no project. Routing depends
// on that exact token, so a corrupted one sends the instruction nowhere.
// large-v3-turbo is already on disk at this path.
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
      throw new Error(
        `Config \`routing[${index}].agent\` names no configured agent: "${rule.agent}"`,
      );
    }
  });
  const projects = parseProjects(root["projects"]);
  const databases = parseDatabases(root["databases"], projects);
  const editors = parseEditors(root["editors"], projects);
  const clusters = parseClusters(root["clusters"], projects);
  const docker = parseDocker(root["docker"], projects);
  const chat = parseChat(root["chat"], projects);
  const workflows = parseWorkflows(root["workflows"], projects);
  const headlamp = parseHeadlamp(root["headlamp"]);
  const terminal = parseTerminal(root["terminal"]);
  const performance = parsePerformance(root["performance"]);
  const browser = parseBrowser(root["browser"]);
  const prayer = parsePrayer(root["prayer"]);
  const whisper = parseWhisper(root["whisper"]);
  const sessions = parseSessions(root["sessions"]);
  const remote = parseRemote(root["remote"]);
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
      throw new Error(
        `Config \`brain.accountId\` names "${accountId}", which declares no configDir`,
      );
    }
    brainAccount = { accountId, configDir: agent.configDir };
  }

  return {
    registry: { agents, routing },
    // `projects` is already parseProjects's null-prototype record (its
    // members above only ever indexed into it, never replaced it), so the
    // tilde-expanded values are assigned back onto that same object rather
    // than into a fresh Object.fromEntries({}) — which would reintroduce
    // Object.prototype and undo parseProjects's guard right before it
    // reaches dispatch.ts.
    projects: Object.assign(
      projects,
      Object.fromEntries(Object.entries(projects).map(([name, path]) => [name, expandTilde(path)])),
    ),
    databases,
    editors,
    clusters,
    docker,
    chat,
    workflows,
    headlamp,
    terminal,
    performance,
    browser,
    prayer,
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
    remote,
    sessionsDbPath: defaultSessionsDbPath(),
  };
}

export const DEFAULT_PRAYER: PrayerConfig = { enabled: false };

/** `prayer.notify`'s defaults when the whole section is absent — not
 *  exported, the same way Alexandria's coordinates are only a local
 *  literal in prayer.ts rather than a config.ts export: the renderer keeps
 *  its own copy of this fallback (prayer-notify.ts's DEFAULT_PRAYER_NOTIFY)
 *  so it never needs a runtime import of this node-touching module. */
const DEFAULT_PRAYER_NOTIFY = { before: true, beforeMinutes: 10, atTime: true };

function parsePrayerNotify(raw: unknown): NonNullable<PrayerConfig["notify"]> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Config `prayer.notify` must be an object");
  }
  const section = raw as Record<string, unknown>;
  const before = section["before"];
  if (before !== undefined && typeof before !== "boolean") {
    throw new Error("Config `prayer.notify.before` must be a boolean");
  }
  const atTime = section["atTime"];
  if (atTime !== undefined && typeof atTime !== "boolean") {
    throw new Error("Config `prayer.notify.atTime` must be a boolean");
  }
  const beforeMinutes = section["beforeMinutes"];
  if (
    beforeMinutes !== undefined &&
    (typeof beforeMinutes !== "number" ||
      !Number.isInteger(beforeMinutes) ||
      beforeMinutes < 1 ||
      beforeMinutes > 60)
  ) {
    throw new Error("Config `prayer.notify.beforeMinutes` must be an integer from 1 to 60");
  }
  return {
    before: before ?? DEFAULT_PRAYER_NOTIFY.before,
    beforeMinutes: beforeMinutes ?? DEFAULT_PRAYER_NOTIFY.beforeMinutes,
    atTime: atTime ?? DEFAULT_PRAYER_NOTIFY.atTime,
  };
}

function parsePrayer(raw: unknown): PrayerConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_PRAYER };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Config `prayer` must be an object");
  }
  const section = raw as Record<string, unknown>;
  if (typeof section["enabled"] !== "boolean") {
    throw new Error("Config `prayer.enabled` must be a boolean");
  }
  const rawNotify = section["notify"];
  const notify = rawNotify === undefined ? {} : { notify: parsePrayerNotify(rawNotify) };
  const rawLocation = section["location"];
  if (rawLocation === undefined) return { enabled: section["enabled"], ...notify };
  if (typeof rawLocation !== "object" || rawLocation === null || Array.isArray(rawLocation)) {
    throw new Error("Config `prayer.location` must be an object");
  }
  const location = rawLocation as Record<string, unknown>;
  const latitude = location["latitude"];
  const longitude = location["longitude"];
  const name = location["name"];
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    throw new Error("Config `prayer.location.latitude` must be a number from -90 to 90");
  }
  if (
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error("Config `prayer.location.longitude` must be a number from -180 to 180");
  }
  if (typeof name !== "string" || name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new Error(
      "Config `prayer.location.name` must be at most 60 characters with no control characters",
    );
  }
  return { enabled: section["enabled"], location: { latitude, longitude, name }, ...notify };
}

export function mergeConfigInPlace(
  target: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  for (const key of Object.keys(target)) if (!(key in next)) delete target[key];
  for (const [key, newValue] of Object.entries(next)) {
    const oldValue = target[key];
    if (Array.isArray(oldValue) && Array.isArray(newValue)) {
      oldValue.splice(0, oldValue.length, ...newValue);
    } else if (
      oldValue &&
      newValue &&
      typeof oldValue === "object" &&
      typeof newValue === "object" &&
      !Array.isArray(oldValue) &&
      !Array.isArray(newValue)
    ) {
      const destination = oldValue as Record<string, unknown>;
      for (const nested of Object.keys(destination)) delete destination[nested];
      Object.assign(destination, newValue);
    } else target[key] = newValue;
  }
}

/** Extracted so Settings (settings-io.ts, via main.ts) reads and writes the
 *  exact same file `loadConfig` reads at startup, rather than duplicating
 *  this path as a second literal that could drift from this one. */
export const DEFAULT_CONFIG_PATH = join(homedir(), ".config/jarvis/jarvis.yaml");

/**
 * The file a machine that has never run Jarvis starts from.
 *
 * Deliberately the smallest thing that parses and still does something: one
 * agent, and the brain's own directory. No `projects:` — a new machine has
 * nothing checked out, and a project pointing at a directory that is not
 * there is worse than no project at all. Everything else in the file has a
 * default worth having, and Settings writes the rest back in the user's own
 * words once they change it.
 *
 * `claude` rather than one of the wrapper names this repo's example config
 * uses: a wrapper is something you set up, and the plain CLI is what a new
 * machine is most likely to have. A command that is not installed is
 * reported as a broken agent in the startup line, which is a thing you can
 * read and fix — unlike the dialog this exists to prevent.
 */
const FIRST_RUN_CONFIG = `# Written by Jarvis on first run. Yours to edit — by hand, or in Settings.
# Every key, with worked examples: docs/guide/configuration.md
agents:
  claude:
    command: claude
    default: true
    vendor: anthropic

brain:
  systemPrompt: You are Jarvis.

# Projects Jarvis can open an editor, terminal, database or API tab for.
# Add your own; the name is what you say to route work to it.
# projects:
#   my-app: ~/projects/my-app
`;

/**
 * Makes sure there is a config to read, and says whether it had to write
 * one. Never overwrites: the moment the file exists it is the user's, even
 * when it is mid-edit and currently invalid.
 *
 * This is the whole of first run. Without it `loadConfig` below throws
 * ENOENT on a machine that has never run Jarvis, and the startup handler
 * turns that into "Jarvis failed to start" and quits — which is exactly
 * what a downloaded build did on every machine but the one it was built on.
 */
export async function ensureConfigFile(path: string = DEFAULT_CONFIG_PATH): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return false;
  } catch {
    // Unreadable for any reason is treated as absent, and the write below
    // is what decides: a directory in the way, or a permission problem,
    // throws from there and reaches the startup dialog with a real message.
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, FIRST_RUN_CONFIG, "utf8");
    return true;
  }
}

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
      throw new Error(`Config \`agents.${id}.vendor\` must be one of: ${VENDORS.join(", ")}`);
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

/** The `browser:` section as it stands with nothing in jarvis.yaml. */
export const DEFAULT_BROWSER: BrowserConfig = {
  allowPopups: true,
};

function parseBrowser(rawBrowser: unknown): BrowserConfig {
  if (rawBrowser === undefined || rawBrowser === null) return { ...DEFAULT_BROWSER };
  if (typeof rawBrowser !== "object" || Array.isArray(rawBrowser)) {
    throw new Error("Config `browser` must be an object");
  }
  const section = rawBrowser as Record<string, unknown>;
  const allowPopups = section["allowPopups"];
  if (allowPopups !== undefined && typeof allowPopups !== "boolean") {
    throw new Error("Config `browser.allowPopups` must be a boolean");
  }
  const rawHomePage = section["homePage"];
  if (
    rawHomePage !== undefined &&
    (typeof rawHomePage !== "string" ||
      rawHomePage.length > 2048 ||
      /[\p{Cc}\p{Cf}]/u.test(rawHomePage))
  ) {
    throw new Error(
      "Config `browser.homePage` must be at most 2048 characters with no control characters",
    );
  }
  if (rawHomePage !== undefined) {
    let protocol: string;
    try {
      protocol = new URL(rawHomePage).protocol;
    } catch {
      throw new Error("Config `browser.homePage` must be a valid http(s) URL");
    }
    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error("Config `browser.homePage` must be a valid http(s) URL");
    }
  }
  return {
    allowPopups: allowPopups ?? DEFAULT_BROWSER.allowPopups,
    ...(rawHomePage === undefined ? {} : { homePage: rawHomePage }),
  };
}

/** The `remote:` section as it stands with nothing in jarvis.yaml. Exported
 *  so settings-io can tell "never written" from "written" — see
 *  DEFAULT_TERMINAL's note. */
export const DEFAULT_REMOTE: RemoteConfig = {
  enabled: false,
  bindAddress: "127.0.0.1",
  port: 7717,
  sidecarProxy: false,
  tls: {},
  push: { enabled: false, includeProjectNames: false },
  idleDisableMinutes: 0,
};

const BIND_ADDRESS_ERROR =
  "Config `remote.bindAddress` must be an IP address such as 127.0.0.1, not a hostname";

function parseRemote(rawRemote: unknown): RemoteConfig {
  // Fresh nested objects, not DEFAULT_REMOTE's own: a caller mutating the
  // parsed config must not be able to change what "default" means for
  // settings-io's comparison.
  const defaults = (): RemoteConfig => ({
    ...DEFAULT_REMOTE,
    tls: {},
    push: { ...DEFAULT_REMOTE.push },
  });
  if (rawRemote === undefined || rawRemote === null) return defaults();
  if (typeof rawRemote !== "object" || Array.isArray(rawRemote)) {
    throw new Error("Config `remote` must be an object");
  }
  const remote = rawRemote as Record<string, unknown>;

  const flag = (key: "enabled" | "sidecarProxy"): boolean => {
    const value = remote[key];
    if (value === undefined) return DEFAULT_REMOTE[key];
    if (typeof value !== "boolean") {
      throw new Error(`Config \`remote.${key}\` must be true or false`);
    }
    return value;
  };

  const bindAddress = remote["bindAddress"];
  // isIP, not a pattern: it is the same parser the listener will hand the
  // address to, so "accepted here" and "bindable there" cannot disagree.
  // 0.0.0.0 and :: pass — binding every interface is a legitimate choice,
  // and Settings warns about it rather than refusing it.
  if (bindAddress !== undefined && (typeof bindAddress !== "string" || isIP(bindAddress) === 0)) {
    throw new Error(BIND_ADDRESS_ERROR);
  }

  const port = remote["port"];
  if (
    port !== undefined &&
    (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
  ) {
    throw new Error("Config `remote.port` must be a whole number from 0 to 65535");
  }

  const idle = remote["idleDisableMinutes"];
  // 0 is meaningful — it is "never" — so the floor is 0, as in performance:.
  // The ceiling, 10080, is one week in minutes: past that the setting stops
  // meaning "disable while idle" and starts meaning "disabled" (ruling 32).
  if (
    idle !== undefined &&
    (typeof idle !== "number" || !Number.isInteger(idle) || idle < 0 || idle > 10080)
  ) {
    throw new Error(
      "Config `remote.idleDisableMinutes` must be a whole number of minutes from 0 to 10080",
    );
  }

  return {
    enabled: flag("enabled"),
    bindAddress: typeof bindAddress === "string" ? bindAddress : DEFAULT_REMOTE.bindAddress,
    port: typeof port === "number" ? port : DEFAULT_REMOTE.port,
    sidecarProxy: flag("sidecarProxy"),
    tls: parseRemoteTls(remote["tls"]),
    push: parseRemotePush(remote["push"]),
    idleDisableMinutes: typeof idle === "number" ? idle : DEFAULT_REMOTE.idleDisableMinutes,
  };
}

function parseRemoteTls(rawTls: unknown): RemoteConfig["tls"] {
  if (rawTls === undefined || rawTls === null) return {};
  if (typeof rawTls !== "object" || Array.isArray(rawTls)) {
    throw new Error("Config `remote.tls` must be an object");
  }
  const tls = rawTls as Record<string, unknown>;
  const path = (key: "certPath" | "keyPath"): string | undefined => {
    const value = tls[key];
    // `~` in YAML is null, and the spec's own example spells "absent" that way.
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value === "") {
      throw new Error(`Config \`remote.tls.${key}\` must be a non-empty string`);
    }
    return expandTilde(value);
  };
  const certPath = path("certPath");
  const keyPath = path("keyPath");
  // A certificate without its key (or the reverse) can never be served;
  // saying so at load beats a bridge that fails the first time it starts.
  if (certPath === undefined || keyPath === undefined) {
    if (certPath !== keyPath) {
      throw new Error("Config `remote.tls.certPath` and `remote.tls.keyPath` must be set together");
    }
    return {};
  }
  return { certPath, keyPath };
}

function parseRemotePush(rawPush: unknown): RemoteConfig["push"] {
  if (rawPush === undefined || rawPush === null) return { ...DEFAULT_REMOTE.push };
  if (typeof rawPush !== "object" || Array.isArray(rawPush)) {
    throw new Error("Config `remote.push` must be an object");
  }
  const push = rawPush as Record<string, unknown>;
  const flag = (key: "enabled" | "includeProjectNames"): boolean => {
    const value = push[key];
    if (value === undefined) return DEFAULT_REMOTE.push[key];
    if (typeof value !== "boolean") {
      throw new Error(`Config \`remote.push.${key}\` must be true or false`);
    }
    return value;
  };
  return { enabled: flag("enabled"), includeProjectNames: flag("includeProjectNames") };
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
      typeof whisper["binaryPath"] === "string"
        ? whisper["binaryPath"]
        : DEFAULT_WHISPER_BINARY_PATH,
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
  if (rawEditors === undefined) return Object.create(null) as EditorsConfig;
  if (typeof rawEditors !== "object" || rawEditors === null || Array.isArray(rawEditors)) {
    throw new Error("Config `editors` must be an object");
  }

  // Object.create(null), same reasoning as parseProjects above (ruling 30):
  // a project named "constructor" must read back as an own, undefined
  // entry from this map too, not Object.prototype's method.
  const result: EditorsConfig = Object.create(null) as EditorsConfig;
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
  if (rawClusters === undefined) return Object.create(null) as ClustersConfig;
  if (typeof rawClusters !== "object" || rawClusters === null || Array.isArray(rawClusters)) {
    throw new Error("Config `clusters` must be an object");
  }

  const result: ClustersConfig = Object.create(null) as ClustersConfig;
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
  if (rawDocker === undefined) return Object.create(null) as DockerConfig;
  if (typeof rawDocker !== "object" || rawDocker === null || Array.isArray(rawDocker)) {
    throw new Error("Config `docker` must be an object");
  }

  const result: DockerConfig = Object.create(null) as DockerConfig;
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

/** `chat:` is keyed by project name, exactly as `docker:` and `clusters:`
 *  are, and rejected on the same grounds plus two of its own: a `driver`
 *  outside the table this build knows, and an empty `account`.
 *
 *  An empty `account` is rejected rather than quietly read as absent
 *  because the two mean different things — absent opens the provider's own
 *  picker, while "" would build `https://.slack.com/` — and a key someone
 *  typed and then emptied is far more likely a mistake than a request for
 *  the picker.
 *
 *  Unlike `editors:` there is nothing here to contain: an account is a
 *  subdomain or a tenant id, and the driver decides the host, so no entry
 *  can point the tab at a site of its own choosing. */
function parseChat(rawChat: unknown, projects: Record<string, string>): ChatConfig {
  if (rawChat === undefined) return Object.create(null) as ChatConfig;
  if (typeof rawChat !== "object" || rawChat === null || Array.isArray(rawChat)) {
    throw new Error("Config `chat` must be an object");
  }

  const result: ChatConfig = Object.create(null) as ChatConfig;
  for (const [project, rawList] of Object.entries(rawChat as Record<string, unknown>)) {
    if (projects[project] === undefined) {
      throw new Error(`Config \`chat\` names no configured project: "${project}"`);
    }
    if (!Array.isArray(rawList)) {
      throw new Error(`Config \`chat.${project}\` must be an array`);
    }

    const seen = new Set<string>();
    result[project] = rawList.map((rawEntry, index) => {
      const where = `chat.${project}[${index}]`;
      if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
        throw new Error(`Config \`${where}\` must be an object`);
      }
      const entry = rawEntry as Record<string, unknown>;

      const name = entry["name"];
      if (typeof name !== "string" || name === "") {
        throw new Error(`Config \`${where}.name\` must be a non-empty string`);
      }
      if (seen.has(name)) {
        throw new Error(`Config \`${where}.name\` duplicates an earlier chat: "${name}"`);
      }
      seen.add(name);

      const driver = entry["driver"];
      if (!isChatDriver(driver)) {
        throw new Error(`Config \`${where}.driver\` must be one of: slack, teams`);
      }

      const account = entry["account"];
      if (account !== undefined && (typeof account !== "string" || account === "")) {
        throw new Error(`Config \`${where}.account\` must be a non-empty string when present`);
      }

      return account === undefined ? { name, driver } : { name, driver, account };
    });
  }
  return result;
}

/**
 * The `workflows:` section — a project name to a single directory of
 * workflow files, on top of the always-read
 * `~/.config/jarvis/workflows/`. The section is optional and an absent one
 * is not an error: most projects will never have an entry, and every
 * project still gets the always-read directory.
 *
 *     workflows:
 *       acme: ./.jarvis/workflows
 */
function parseWorkflows(rawWorkflows: unknown, projects: Record<string, string>): WorkflowsConfig {
  if (rawWorkflows === undefined) return Object.create(null) as WorkflowsConfig;
  if (typeof rawWorkflows !== "object" || rawWorkflows === null || Array.isArray(rawWorkflows)) {
    throw new Error("Config `workflows` must be an object");
  }

  const result: WorkflowsConfig = Object.create(null) as WorkflowsConfig;
  for (const [project, rawDir] of Object.entries(rawWorkflows as Record<string, unknown>)) {
    if (projects[project] === undefined) {
      throw new Error(`Config \`workflows\` names no configured project: "${project}"`);
    }
    if (typeof rawDir !== "string" || rawDir === "") {
      throw new Error(`Config \`workflows.${project}\` must be a non-empty string`);
    }
    result[project] = expandTilde(rawDir);
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
/**
 * The three numbers of the `performance:` section, with the measurements
 * behind each. Absent section, or an absent key, means the default.
 */
export const DEFAULT_PERFORMANCE: PerformanceConfig = {
  // Long enough that switching between two tabs you are working across never
  // pays a reload; short enough that a morning's tabs are not still resident
  // at lunch.
  suspendTabsAfterMinutes: 15,
  // A code-server restart is ~1.2s warm. Ten minutes of nothing needing it is
  // not an accident, and 1.2s to get 200 MB back is the right trade.
  stopSidecarsAfterMinutes: 10,
  // Was 20000, which at 200 columns is ~48 MB of Uint32Array per pane once
  // filled — and a split tab has one pane per leaf, beside the Session
  // route's own. 5000 is ~12 MB and still further back than anyone scrolls.
  terminalScrollback: 5000,
};

function parsePerformance(rawPerformance: unknown): PerformanceConfig {
  if (rawPerformance === undefined || rawPerformance === null) {
    return { ...DEFAULT_PERFORMANCE };
  }
  if (typeof rawPerformance !== "object" || Array.isArray(rawPerformance)) {
    throw new Error("Config `performance` must be an object");
  }
  const performance = rawPerformance as Record<string, unknown>;

  const read = (key: keyof PerformanceConfig): number => {
    const value = performance[key];
    if (value === undefined) return DEFAULT_PERFORMANCE[key];
    // 0 is meaningful here — it is how each of these is turned off — so the
    // floor is 0 rather than the 1 `sessions.importWindowDays` insists on.
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Config \`performance.${key}\` must be a number of 0 or more`);
    }
    return value;
  };

  return {
    suspendTabsAfterMinutes: read("suspendTabsAfterMinutes"),
    stopSidecarsAfterMinutes: read("stopSidecarsAfterMinutes"),
    terminalScrollback: read("terminalScrollback"),
  };
}

/** The `terminal:` section as it stands with nothing in jarvis.yaml.
 *  Exported so settings-io can tell "the user never wrote this section"
 *  from "the user wrote it and it happens to match" — the difference
 *  between growing a key in a hand-edited file and losing one. */
export const DEFAULT_TERMINAL: TerminalConfig = {
  completion: {
    enabled: true,
    historyPath: DEFAULT_HISTORY_PATH,
    commandLogPath: DEFAULT_COMMAND_LOG_PATH,
  },
  blocks: { enabled: true, inputEditor: true },
  notifyAfterSeconds: 30,
};

/** The same, for `sessions:`. */
export const DEFAULT_SESSIONS: JarvisConfig["sessions"] = {
  importWindowDays: DEFAULT_IMPORT_WINDOW_DAYS,
};

function parseTerminal(rawTerminal: unknown): TerminalConfig {
  const defaults: TerminalConfig = DEFAULT_TERMINAL;
  if (rawTerminal === undefined) return defaults;
  if (typeof rawTerminal !== "object" || rawTerminal === null || Array.isArray(rawTerminal)) {
    throw new Error("Config `terminal` must be an object");
  }
  const terminal = rawTerminal as Record<string, unknown>;

  return {
    completion: parseTerminalCompletion(terminal["completion"], defaults.completion),
    blocks: parseTerminalBlocks(terminal["blocks"], defaults.blocks),
    notifyAfterSeconds: parseNotifyAfterSeconds(
      terminal["notifyAfterSeconds"],
      defaults.notifyAfterSeconds,
    ),
  };
}

function parseTerminalCompletion(
  rawCompletion: unknown,
  defaults: TerminalConfig["completion"],
): TerminalConfig["completion"] {
  if (rawCompletion === undefined) return defaults;
  if (typeof rawCompletion !== "object" || rawCompletion === null || Array.isArray(rawCompletion)) {
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
    enabled: enabled ?? defaults.enabled,
    historyPath: path("historyPath", defaults.historyPath),
    commandLogPath: path("commandLogPath", defaults.commandLogPath),
  };
}

function parseTerminalBlocks(
  rawBlocks: unknown,
  defaults: TerminalConfig["blocks"],
): TerminalConfig["blocks"] {
  if (rawBlocks === undefined) return defaults;
  if (typeof rawBlocks !== "object" || rawBlocks === null || Array.isArray(rawBlocks)) {
    throw new Error("Config `terminal.blocks` must be an object");
  }
  const blocks = rawBlocks as Record<string, unknown>;

  const enabled = blocks["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("Config `terminal.blocks.enabled` must be true or false");
  }
  const inputEditor = blocks["inputEditor"];
  if (inputEditor !== undefined && typeof inputEditor !== "boolean") {
    throw new Error("Config `terminal.blocks.inputEditor` must be true or false");
  }

  return {
    enabled: enabled ?? defaults.enabled,
    inputEditor: inputEditor ?? defaults.inputEditor,
  };
}

function parseNotifyAfterSeconds(rawValue: unknown, fallback: number): number {
  if (rawValue === undefined) return fallback;
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue < 0) {
    throw new Error("Config `terminal.notifyAfterSeconds` must be a number of seconds, or 0");
  }
  return rawValue;
}

/** The `headlamp:` section. One optional key, so an absent section is not an
 *  error — only a binary that turns out not to exist is, and that is the
 *  manager's failure to report, not this one's.
 *
 *  An absent key yields undefined rather than the per-OS default it used to.
 *  Resolving that default meant reading `process.platform` here, which made
 *  every headlamp assertion in config.test.ts true only on the OS the test
 *  ran on. The default now lives at main.ts's edge, where the host is
 *  already known — see defaultHeadlampBinary. */
function parseHeadlamp(rawHeadlamp: unknown): { binary: string | undefined } {
  const fallback = { binary: undefined };
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
    piperArabicModel: DEFAULT_PIPER_ARABIC_MODEL,
    englishVoice: DEFAULT_ENGLISH_VOICE,
    arabicVoice: DEFAULT_ARABIC_VOICE,
    greeting: { ...DEFAULT_GREETING },
    speakGreeting: true,
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

  const speakGreeting = voice["speakGreeting"];
  if (speakGreeting !== undefined && typeof speakGreeting !== "boolean") {
    throw new Error("Config `voice.speakGreeting` must be a boolean");
  }

  return {
    engine: engine ?? DEFAULT_ENGINE,
    piperBinary: expandTilde(text("piperBinary", DEFAULT_PIPER_BINARY)),
    piperModel: expandTilde(text("piperModel", DEFAULT_PIPER_MODEL)),
    piperArabicModel: expandTilde(text("piperArabicModel", DEFAULT_PIPER_ARABIC_MODEL)),
    englishVoice: text("englishVoice", DEFAULT_ENGLISH_VOICE),
    arabicVoice: text("arabicVoice", DEFAULT_ARABIC_VOICE),
    greeting: {
      en: typeof greeting["en"] === "string" ? greeting["en"] : DEFAULT_GREETING.en,
      ar: typeof greeting["ar"] === "string" ? greeting["ar"] : DEFAULT_GREETING.ar,
    },
    speakGreeting: speakGreeting ?? true,
  };
}

function parseProjects(rawProjects: unknown): Record<string, string> {
  // Object.create(null), not `{}`: a project literally named "constructor"
  // or "__proto__" must read back as an own, undefined entry — never as
  // Object.prototype's method or as a prototype swap — so every consumer
  // that tests `projects[name] === undefined` for membership (dispatch.ts,
  // config.ts's own parseDatabases/parseEditors/... family, ipc.ts) stays
  // correct no matter what a project is named (ruling 30).
  if (rawProjects === undefined) {
    return Object.create(null) as Record<string, string>;
  }
  if (typeof rawProjects !== "object" || rawProjects === null || Array.isArray(rawProjects)) {
    throw new Error("Config `projects` must be an object");
  }

  const projects: Record<string, string> = Object.create(null) as Record<string, string>;
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
