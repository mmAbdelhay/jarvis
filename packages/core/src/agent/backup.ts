// Rafiq M4 contracts §1: the backup brain. A ≈1–2B local model that answers
// when every configured provider failed. It sees only the simple tools, at
// most 8 steps a turn, and a note that keeps it modest. The tool loop also
// refuses any other tool it names (it was never offered one). Pure.
import { insertBeforeSafetyRules } from "./safety.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ModelProvider, ModelToolSpec } from "./types.js";

export const BACKUP_PROVIDER_ID = "backup";
/** Fixed loopback: the backup never comes from jarvis.yaml. */
export const BACKUP_BASE_URL = "http://127.0.0.1:11434";
export const BACKUP_MAX_STEPS = 8;

export const SIMPLE_TOOLS: readonly string[] = [
  "pkg.search",
  "pkg.info",
  "pkg.list_installed",
  "disk.usage",
  "sys.health",
  "svc.status",
  "svc.list_failed",
  "svc.restart",
  "net.status",
  "net.wifi_scan",
  "net.connection_up",
  "net.radio_on",
  "apps.list",
  "apps.open",
  "apps.open_path",
  "files.search",
  "files.preview",
  "settings.get",
  "updates.list",
];
const SIMPLE = new Set(SIMPLE_TOOLS);

export type ToolProfile = {
  name: "full" | "simple";
  maxSteps: number;
  allows(tool: string): boolean;
};

export const SIMPLE_PROFILE: ToolProfile = {
  name: "simple",
  maxSteps: BACKUP_MAX_STEPS,
  allows: (tool) => SIMPLE.has(tool),
};

/** Model-facing (English). */
export const BACKUP_SYSTEM_NOTE =
  "You are the small backup model on this computer: the user's usual model provider is not answering. Only a few simple tools are available. Use one tool at a time, keep answers short, and when a request needs more than these tools can do, say that the usual model is unavailable and suggest trying again later or checking the provider in Settings.";

export function simpleToolSpecs(
  registry: Pick<ToolRegistry, "modelTools" | "resolve">,
): ModelToolSpec[] {
  return registry
    .modelTools()
    .filter((spec) => SIMPLE.has(registry.resolve(spec.name)?.name ?? ""));
}

/** The backup only ever sees the simple tools and the backup note. A request
 *  with no tools (the step-limit report) keeps none. */
export function withSimpleProfile(
  provider: ModelProvider,
  tools: () => ModelToolSpec[],
): ModelProvider {
  return {
    chat: (request) =>
      provider.chat({
        ...request,
        system: insertBeforeSafetyRules(request.system, BACKUP_SYSTEM_NOTE),
        tools: request.tools.length === 0 ? [] : tools(),
      }),
    probe: () => provider.probe(),
    listModels: (signal) => provider.listModels(signal),
    reachable: (signal) => provider.reachable(signal),
  };
}
