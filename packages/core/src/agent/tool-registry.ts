// Merges the tool lists of the MCP servers jarvisd runs (spec §5, contracts
// §1). Risk is read from `_meta.jarvis` and trusted only for the allowlisted
// servers; anything else is confirm (or password, if it asks for more). The
// model never sees hidden tools or secret fields, and sees each tool under a
// name providers accept (pkg.install -> pkg_install).
import type { CardSource } from "./contract.js";
import {
  type McpSession,
  type ModelToolSpec,
  type ToolOutcome,
  type ToolRisk,
  isRecord,
} from "./types.js";

export const TRUSTED_MCP_SERVERS = ["jarvis-pkg", "jarvis-diag"] as const;

/** Who vouches for a server's declared risks (contracts M2.5 §3). */
export type ServerTrust = "host" | "official" | "reviewed" | "community" | "unknown";

/** Design §3.3: tools that reach the root helper or install software. No
 *  manifest — not even an allowlisted server's — puts them below this. */
export const HOST_FORCED_RISK: Readonly<Record<string, ToolRisk>> = {
  "pkg.install": "confirm",
  "pkg.remove": "confirm",
  "updates.apply": "confirm",
  "svc.restart": "confirm",
  "net.connection_up": "confirm",
  "net.wifi_connect": "confirm",
  "net.radio_on": "confirm",
  "registry.install": "confirm",
  "registry.remove": "confirm",
};

/** Name spaces only jarvisd's own servers (jarvis-pkg, jarvis-diag) may use. */
export const HOST_TOOL_PREFIXES: readonly string[] = [
  "pkg.",
  "updates.",
  "disk.",
  "sys.",
  "logs.",
  "svc.",
  "net.",
  "hw.",
  "registry.",
  "jarvis.",
];

/** Compare what the model sees (separator and case folded), not the raw name. */
export function isHostNamespaced(name: string): boolean {
  const lower = name.toLowerCase();
  return HOST_TOOL_PREFIXES.some((prefix) => {
    const stem = prefix.toLowerCase().replace(/[^a-z0-9]+$/, "");
    return lower.startsWith(stem) && /^[^a-z0-9]/.test(lower.slice(stem.length));
  });
}

const RISK_ORDER: Readonly<Record<ToolRisk, number>> = { safe: 0, confirm: 1, password: 2 };

export function raiseRisk(a: ToolRisk, b: ToolRisk): ToolRisk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export function effectiveRisk(tool: string, declared: unknown, trust: ServerTrust): ToolRisk {
  const parsed: ToolRisk | undefined =
    declared === "safe" || declared === "confirm" || declared === "password" ? declared : undefined;
  const vouched = trust === "host" || trust === "official" || trust === "reviewed";
  const risk: ToolRisk = vouched
    ? (parsed ?? "confirm")
    : parsed === "password"
      ? "password"
      : "confirm";
  return raiseRisk(risk, HOST_FORCED_RISK[tool] ?? "safe");
}
export const DESCRIBE_TOOL = "jarvis.describe";
export const SAFE_TOOL_TIMEOUT_MS = 60_000;
/** Installs and restarts may take minutes; they are never cut short. Kept
 *  above jarvis-pkg's BatchBudget (80 min, os/go/internal/pkgtools), which
 *  stops starting items while a full helper call no longer fits, so a slow
 *  install is never reported as failed while it is still running. */
export const ACTION_TOOL_TIMEOUT_MS = 5_100_000;
const DESCRIBE_TIMEOUT_MS = 10_000;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CARD_SOURCES: ReadonlySet<string> = new Set(["debian", "flathub", "system", "network"]);

export type RegisteredTool = {
  name: string;
  modelName: string;
  server: string;
  description: string;
  risk: ToolRisk;
  hidden: boolean;
  secrets: string[];
  /** `_meta.jarvis.batch === "items"` (contracts §6 #1): the card shows one
   *  item per element of `input.items` and the tool runs once with the
   *  ticked ones (pkg.install, pkg.remove). */
  batchItems: boolean;
  inputSchema: Record<string, unknown>;
  modelSchema: Record<string, unknown>;
};

export type CardDescription = { title: string; detail: string; source: CardSource };

export interface ToolRegistry {
  modelTools(): ModelToolSpec[];
  resolve(name: string): RegisteredTool | undefined;
  get(name: string): RegisteredTool | undefined;
  sanitizeInput(tool: RegisteredTool, input: unknown): Record<string, unknown>;
  call(name: string, input: Record<string, unknown>): Promise<ToolOutcome>;
  describe(tool: RegisteredTool, input: Record<string, unknown>): Promise<CardDescription>;
}

export function parseJarvisMeta(
  meta: unknown,
  trust: ServerTrust | boolean,
  tool = "",
): { risk: ToolRisk; hidden: boolean; secrets: string[]; batchItems: boolean } {
  const jarvis = isRecord(meta) && isRecord(meta["jarvis"]) ? meta["jarvis"] : {};
  const level: ServerTrust = trust === true ? "host" : trust === false ? "unknown" : trust;
  const rawSecrets = Array.isArray(jarvis["secrets"]) ? jarvis["secrets"] : [];
  const secrets = [
    ...new Set(rawSecrets.filter((s): s is string => typeof s === "string" && SECRET_NAME.test(s))),
  ].slice(0, 8);
  return {
    risk: effectiveRisk(tool, jarvis["risk"], level),
    hidden: jarvis["hidden"] === true,
    secrets,
    batchItems: jarvis["batch"] === "items",
  };
}

export function toModelName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

export function stripSecrets(
  schema: Record<string, unknown>,
  secrets: readonly string[],
): Record<string, unknown> {
  if (secrets.length === 0) return schema;
  const out: Record<string, unknown> = { ...schema };
  const properties = schema["properties"];
  if (isRecord(properties)) {
    out["properties"] = Object.fromEntries(
      Object.entries(properties).filter(([key]) => !secrets.includes(key)),
    );
  }
  const required = schema["required"];
  if (Array.isArray(required)) {
    out["required"] = required.filter((key) => typeof key === "string" && !secrets.includes(key));
  }
  return out;
}

function compactJson(value: unknown, max: number): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function parseDescription(data: unknown): CardDescription | undefined {
  if (!isRecord(data)) return undefined;
  const { title, detail, source } = data;
  if (typeof title !== "string" || title.length === 0 || title.length > 200) return undefined;
  if (typeof detail !== "string" || detail.length > 1_000) return undefined;
  if (typeof source !== "string" || !CARD_SOURCES.has(source)) return undefined;
  return { title, detail, source: source as CardSource };
}

export async function loadToolRegistry(
  sessions: readonly McpSession[],
  options: {
    trusted: ReadonlySet<string>;
    /** Registry servers' tiers (registry-servers.ts); host names win. */
    trustOf?(server: string): ServerTrust;
    log(line: string): void;
  },
): Promise<ToolRegistry> {
  const byName = new Map<string, RegisteredTool>();
  const byModelName = new Map<string, RegisteredTool>();
  const bySession = new Map<string, McpSession>();
  const describable = new Set<string>();

  for (const session of sessions) {
    let tools: Awaited<ReturnType<McpSession["listTools"]>>;
    try {
      tools = await session.listTools();
    } catch (error) {
      options.log(
        `[tools] ${session.name}: tools/list failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    bySession.set(session.name, session);
    const trust: ServerTrust = options.trusted.has(session.name)
      ? "host"
      : (options.trustOf?.(session.name) ?? "unknown");
    for (const tool of tools) {
      if (tool.name === DESCRIBE_TOOL) {
        // Card text from an add-on is untrusted: only host servers describe.
        if (trust === "host") describable.add(session.name);
        continue;
      }
      if (trust !== "host" && isHostNamespaced(tool.name)) {
        options.log(`[tools] ${session.name}: ${tool.name} uses a host name space; skipped`);
        continue;
      }
      const parsed = parseJarvisMeta(tool.meta, trust, tool.name);
      const modelName = toModelName(tool.name);
      if (byName.has(tool.name) || byModelName.has(modelName)) {
        options.log(
          `[tools] ${session.name}: ${tool.name} collides with a tool already registered; skipped`,
        );
        continue;
      }
      const registered: RegisteredTool = {
        name: tool.name,
        modelName,
        server: session.name,
        description: tool.description,
        risk: parsed.risk,
        hidden: parsed.hidden,
        secrets: parsed.secrets,
        batchItems: parsed.batchItems,
        inputSchema: tool.inputSchema,
        modelSchema: stripSecrets(tool.inputSchema, parsed.secrets),
      };
      byName.set(tool.name, registered);
      byModelName.set(modelName, registered);
    }
  }

  return {
    modelTools() {
      return [...byName.values()]
        .filter((tool) => !tool.hidden)
        .map((tool) => ({
          name: tool.modelName,
          description: tool.description,
          inputSchema: tool.modelSchema,
        }));
    },
    resolve(name) {
      const tool = byModelName.get(name) ?? byName.get(name);
      return tool === undefined || tool.hidden ? undefined : tool;
    },
    get(name) {
      return byName.get(name);
    },
    sanitizeInput(tool, input) {
      if (!isRecord(input)) return {};
      return Object.fromEntries(
        Object.entries(input).filter(([key]) => !tool.secrets.includes(key)),
      );
    },
    async call(name, input) {
      const tool = byName.get(name);
      const session = tool === undefined ? undefined : bySession.get(tool.server);
      if (tool === undefined || session === undefined) {
        return { ok: false, data: null, text: `No tool named ${name}`, code: "not_found" };
      }
      try {
        const result = await session.callTool(name, input, {
          timeoutMs: tool.risk === "safe" ? SAFE_TOOL_TIMEOUT_MS : ACTION_TOOL_TIMEOUT_MS,
        });
        if (!result.isError) return { ok: true, data: result.structuredContent, text: result.text };
        const data = result.structuredContent;
        const code = isRecord(data) && typeof data["code"] === "string" ? data["code"] : "failed";
        return { ok: false, data, text: result.text, code };
      } catch (error) {
        return {
          ok: false,
          data: null,
          text: error instanceof Error ? error.message : String(error),
          code: "failed",
        };
      }
    },
    async describe(tool, input) {
      const fallback: CardDescription = {
        title: tool.name,
        detail: compactJson(input, 300),
        source: "system",
      };
      const session = bySession.get(tool.server);
      if (session === undefined || !session.alive || !describable.has(tool.server)) return fallback;
      try {
        const result = await session.callTool(
          DESCRIBE_TOOL,
          { tool: tool.name, input },
          { timeoutMs: DESCRIBE_TIMEOUT_MS },
        );
        return (
          (result.isError ? undefined : parseDescription(result.structuredContent)) ?? fallback
        );
      } catch {
        return fallback;
      }
    },
  };
}
