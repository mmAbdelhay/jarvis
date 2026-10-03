// What Settings shows about the paired laptop's own configuration, read
// through `settings:read`. Read-only by design: a paired device may not save
// the laptop's settings (they name the commands its agents run). Only the
// fields shown here are taken off the wire, each checked; nothing else of
// jarvis.yaml is kept.
import type { RpcClient } from "./rpc-client";

export type LaptopAgent = { id: string; vendor: string | undefined };
export type WorktreeMode = "off" | "parallel" | "always";

export type LaptopSettings = {
  agents: LaptopAgent[];
  projects: string[];
  worktrees: WorktreeMode;
};

const NAME_MAX = 120;

function names(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter((name) => name !== "" && name.length <= NAME_MAX)
    .sort((a, b) => a.localeCompare(b));
}

export function parseLaptopSettings(value: unknown): LaptopSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const config = value as Record<string, unknown>;
  const registry = config["registry"];
  const agentsRecord =
    typeof registry === "object" && registry !== null
      ? (registry as Record<string, unknown>)["agents"]
      : undefined;
  const agents: LaptopAgent[] = names(agentsRecord).map((id) => {
    const entry = (agentsRecord as Record<string, unknown>)[id];
    const vendor =
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>)["vendor"]
        : undefined;
    return { id, vendor: typeof vendor === "string" && vendor.length <= 40 ? vendor : undefined };
  });
  const sessions = config["sessions"];
  const mode =
    typeof sessions === "object" && sessions !== null
      ? (sessions as Record<string, unknown>)["worktrees"]
      : undefined;
  return {
    agents,
    projects: names(config["projects"]),
    worktrees: mode === "parallel" || mode === "always" ? mode : "off",
  };
}

export async function readLaptopSettings(
  client: Pick<RpcClient, "call">,
): Promise<LaptopSettings | undefined> {
  const result = await client.call("settings:read", [], { whenNotOpen: "reject" });
  return result.ok ? parseLaptopSettings(result.value) : undefined;
}
