import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { AgentConfig, ProviderVendor, RegistryConfig, RoutingRule } from "@jarvis/core";
import type { BrainConfig } from "@jarvis/platform";

export type JarvisConfig = {
  registry: RegistryConfig;
  projects: Record<string, string>;
  brain: BrainConfig;
  whisper: { binaryPath: string; modelPath: string };
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

// A directory with no `.claude` project config of its own — see the
// isolation note on `BrainConfig.cwd` in @jarvis/platform. Headless SDK
// sessions inherit hooks and skills from their cwd, so this must never
// default to the repo or to `process.cwd()`.
const DEFAULT_BRAIN_CWD = join(homedir(), ".config/jarvis/brain");

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
  const projects = parseProjects(root["projects"]);
  const whisper = parseWhisper(root["whisper"]);

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
    brain: {
      systemPrompt:
        typeof brainConfig.systemPrompt === "string"
          ? brainConfig.systemPrompt
          : DEFAULT_SYSTEM_PROMPT,
      cwd: expandTilde(typeof brainConfig.cwd === "string" ? brainConfig.cwd : DEFAULT_BRAIN_CWD),
      ...(brainAccount === undefined ? {} : brainAccount),
    },
    whisper,
    sessionsDbPath: defaultSessionsDbPath(),
  };
}

export async function loadConfig(
  path: string = join(homedir(), ".config/jarvis/jarvis.yaml"),
): Promise<JarvisConfig> {
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

function parseProjects(rawProjects: unknown): Record<string, string> {
  if (rawProjects === undefined) {
    return {};
  }
  if (typeof rawProjects !== "object" || rawProjects === null || Array.isArray(rawProjects)) {
    throw new Error("Config `projects` must be an object");
  }

  const projects: Record<string, string> = {};
  for (const [name, path] of Object.entries(rawProjects)) {
    if (typeof path !== "string") {
      throw new Error(`Config \`projects.${name}\` must be a string`);
    }
    projects[name] = path;
  }
  return projects;
}
