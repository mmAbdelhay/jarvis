// RegistryEntry (contracts M2.5 §3) from jarvis-pkg's registry.list result or
// the verified index cache, field by field: it is index data from the
// network, signed but still parsed like any untrusted input. Pure.
import type { RegistryEntry, RegistryRuntime, RegistryTier } from "./contract.js";
import { isRecord } from "./types.js";

const TIERS: ReadonlySet<string> = new Set(["official", "reviewed", "community"]);
const RUNTIMES: ReadonlySet<string> = new Set(["go-static", "node", "python"]);
const SHA256 = /^[0-9a-f]{64}$/;
const HOME_PATH = /^~\/[^\s]+$/;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

export function parseRegistryEntry(raw: unknown): RegistryEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, name, description, tier, version, artifact, permissions, tools } = raw;
  if (
    !text(id, 48) ||
    !text(name, 100) ||
    typeof description !== "string" ||
    description.length > 1_000
  ) {
    return undefined;
  }
  if (typeof tier !== "string" || !TIERS.has(tier) || !text(version, 32)) return undefined;
  if (!isRecord(artifact) || !isRecord(permissions) || !Array.isArray(tools)) return undefined;
  const { url, sha256, runtime } = artifact;
  if (!text(url, 2_048) || typeof sha256 !== "string" || !SHA256.test(sha256)) return undefined;
  if (typeof runtime !== "string" || !RUNTIMES.has(runtime)) return undefined;
  const { network, paths } = permissions;
  if (typeof network !== "boolean" || !Array.isArray(paths) || paths.length > 8) return undefined;
  if (!paths.every((path) => typeof path === "string" && HOME_PATH.test(path))) return undefined;
  const parsedTools: RegistryEntry["tools"] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || !text(tool["name"], 128)) return undefined;
    const risk = tool["risk"];
    if (risk !== "safe" && risk !== "confirm") return undefined;
    parsedTools.push({ name: tool["name"], risk });
  }
  return {
    id,
    name,
    description,
    tier: tier as RegistryTier,
    version,
    artifact: { url, sha256, runtime: runtime as RegistryRuntime },
    permissions: { network, paths: [...(paths as string[])] },
    tools: parsedTools,
  };
}

/** `{results: [...]}` (registry.list / registry.search) or `{entries: [...]}`
 *  (the index file); entries that fail to parse are dropped. */
export function parseRegistrySearch(data: unknown): RegistryEntry[] {
  const list = isRecord(data) ? (data["results"] ?? data["entries"]) : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const entry = parseRegistryEntry(raw);
    return entry === undefined ? [] : [entry];
  });
}
