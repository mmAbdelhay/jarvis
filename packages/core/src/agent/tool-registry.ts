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
export const DESCRIBE_TOOL = "jarvis.describe";
export const SAFE_TOOL_TIMEOUT_MS = 60_000;
/** Installs and restarts may take minutes; they are never cut short. */
export const ACTION_TOOL_TIMEOUT_MS = 900_000;
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
  trusted: boolean,
): { risk: ToolRisk; hidden: boolean; secrets: string[]; batchItems: boolean } {
  const jarvis = isRecord(meta) && isRecord(meta["jarvis"]) ? meta["jarvis"] : {};
  const declared = jarvis["risk"];
  let risk: ToolRisk;
  if (!trusted) risk = declared === "password" ? "password" : "confirm";
  else
    risk =
      declared === "safe" || declared === "confirm" || declared === "password"
        ? declared
        : "confirm";
  const rawSecrets = Array.isArray(jarvis["secrets"]) ? jarvis["secrets"] : [];
  const secrets = [
    ...new Set(rawSecrets.filter((s): s is string => typeof s === "string" && SECRET_NAME.test(s))),
  ].slice(0, 8);
  return {
    risk,
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
  options: { trusted: ReadonlySet<string>; log(line: string): void },
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
    const trusted = options.trusted.has(session.name);
    for (const tool of tools) {
      if (tool.name === DESCRIBE_TOOL) {
        describable.add(session.name);
        continue;
      }
      const parsed = parseJarvisMeta(tool.meta, trusted);
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
