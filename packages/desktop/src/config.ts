import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { RegistryConfig } from "@jarvis/core";
import type { BrainConfig } from "@jarvis/platform";

export type JarvisConfig = {
  registry: RegistryConfig;
  projects: Record<string, string>;
  brain: BrainConfig;
};

const DEFAULT_SYSTEM_PROMPT = "You are Jarvis.";

// A directory with no `.claude` project config of its own — see the
// isolation note on `BrainConfig.cwd` in @jarvis/platform. Headless SDK
// sessions inherit hooks and skills from their cwd, so this must never
// default to the repo or to `process.cwd()`.
const DEFAULT_BRAIN_CWD = join(homedir(), ".config/jarvis/brain");

export function parseConfig(raw: unknown): JarvisConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config must be an object");
  }
  const root = raw as Record<string, unknown>;

  const agents = root["agents"];
  if (typeof agents !== "object" || agents === null) {
    throw new Error("Config is missing an `agents` section");
  }

  const brain = root["brain"];
  if (typeof brain !== "object" || brain === null) {
    throw new Error("Config is missing a `brain` section");
  }
  const brainConfig = brain as Partial<BrainConfig>;

  const projects = (root["projects"] ?? {}) as Record<string, string>;

  return {
    registry: {
      agents: agents as RegistryConfig["agents"],
      routing: (root["routing"] ?? []) as RegistryConfig["routing"],
    },
    projects: Object.fromEntries(
      Object.entries(projects).map(([name, path]) => [name, expandTilde(path)]),
    ),
    brain: {
      systemPrompt:
        typeof brainConfig.systemPrompt === "string"
          ? brainConfig.systemPrompt
          : DEFAULT_SYSTEM_PROMPT,
      cwd: typeof brainConfig.cwd === "string" ? brainConfig.cwd : DEFAULT_BRAIN_CWD,
    },
  };
}

export async function loadConfig(
  path: string = join(homedir(), ".config/jarvis/jarvis.yaml"),
): Promise<JarvisConfig> {
  const text = await readFile(path, "utf8");
  return parseConfig(parse(text));
}

function expandTilde(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
