// What Settings shows about the paired laptop's own configuration, read
// through `settings:read`. Only the fields shown here are taken off the
// wire, each checked. The one thing the phone edits is the worktree mode:
// agents name commands the laptop runs and projects name its folders, so
// those stay read-only. A save re-reads the `sessions` section, changes that
// one field and sends only that section back; the laptop applies nothing
// else from a phone's save.
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

export type SaveOutcome = { ok: true } | { ok: false; text: string };

/**
 * The only thing a phone's save carries: the `sessions` section with
 * `worktrees` changed. The section's other fields are carried through
 * untouched because the laptop replaces the whole section — this is an
 * outgoing draft, not a parse of input.
 */
export function buildWorktreeDraft(raw: unknown, mode: WorktreeMode): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const sessions = (raw as Record<string, unknown>)["sessions"];
    if (typeof sessions === "object" && sessions !== null && !Array.isArray(sessions)) {
      Object.assign(kept, sessions);
    }
  }
  kept["worktrees"] = mode;
  return { sessions: kept };
}

/** `settings:save`'s reply: `{ok:true}` or `{ok:false,text,...}`. */
export function parseSaveReply(value: unknown): SaveOutcome {
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (obj["ok"] === true) return { ok: true };
    if (obj["ok"] === false && typeof obj["text"] === "string" && obj["text"] !== "") {
      return { ok: false, text: obj["text"] };
    }
  }
  return { ok: false, text: "laptopSettings.saveFailed" };
}

export async function saveWorktreeMode(
  client: Pick<RpcClient, "call">,
  mode: WorktreeMode,
): Promise<SaveOutcome> {
  const current = await client.call("settings:read", [], { whenNotOpen: "reject" });
  if (!current.ok) {
    return {
      ok: false,
      text: current.error.kind === "remote" ? current.error.text : "laptopSettings.saveFailed",
    };
  }
  const result = await client.call("settings:save", [buildWorktreeDraft(current.value, mode)], {
    whenNotOpen: "reject",
  });
  if (!result.ok) {
    return {
      ok: false,
      text: result.error.kind === "remote" ? result.error.text : "laptopSettings.saveFailed",
    };
  }
  return parseSaveReply(result.value);
}
