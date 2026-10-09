// A createOsAgent with in-memory config, keys and MCP sessions, for tests
// that drive the agent the way the control socket does.
import {
  type AgentEvent,
  type McpCallResult,
  type McpSession,
  type McpTool,
  type ModelChatRequest,
  type ModelEvent,
  type ModelProvider,
  ProviderError,
} from "@jarvis/core";
import { createMemorySecretStore } from "@jarvis/platform/model";
import { createOsAgent, type OsAgent, type OsAgentDeps } from "../agent-service.js";
import type { ProviderSection } from "../provider-config.js";

export const CONFIG_PATH = "/home/u/.config/jarvis/jarvis.yaml";
export const DONE: ModelEvent = { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };

export function scripted(
  replies: (ModelEvent[] | Error)[],
  models: string[] = [],
): ModelProvider & { requests: ModelChatRequest[] } {
  const requests: ModelChatRequest[] = [];
  const queue = [...replies];
  return {
    requests,
    async *chat(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const next = queue.shift() ?? [{ type: "text", delta: "ok" }, DONE];
      if (next instanceof Error) throw next;
      yield* next;
    },
    probe: async () => ({ ok: true, supportsTools: true, models }),
    listModels: async () => models,
    reachable: async () => ({ ok: true }),
  };
}

export function down(message = "connect ECONNREFUSED 127.0.0.1:11434"): ModelProvider {
  const error = () => new ProviderError("network", message);
  return {
    // biome-ignore lint/correctness/useYield: it fails before it yields anything.
    async *chat() {
      throw error();
    },
    probe: async () => ({ ok: false, supportsTools: false, models: [], error: message }),
    listModels: async () => {
      throw error();
    },
    reachable: async () => ({ ok: false, error: message }),
  };
}

export function tool(
  name: string,
  risk: "safe" | "confirm",
  jarvis: Record<string, unknown> = {},
): McpTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    meta: { jarvis: { risk, ...jarvis } },
  };
}

export function fakeSession(
  name: string,
  tools: McpTool[],
  answer?: (tool: string, args: Record<string, unknown>) => McpCallResult | undefined,
): McpSession & { calls: { tool: string; args: Record<string, unknown> }[] } {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  return {
    name,
    alive: true,
    calls,
    listTools: async () => tools,
    callTool: async (called, args) => {
      calls.push({ tool: called, args });
      return (
        answer?.(called, args) ?? {
          isError: false,
          structuredContent: { tool: called },
          text: JSON.stringify({ tool: called }),
        }
      );
    },
    close: () => {},
  };
}

export async function startAgent(options: {
  yaml?: string;
  sessions?: McpSession[];
  providers?: Record<string, ModelProvider>;
  overrides?: Partial<OsAgentDeps>;
}): Promise<{
  agent: OsAgent;
  files: Map<string, string>;
  pushed: { channel: string; payload: unknown }[];
  events(): AgentEvent[];
  waitFor(match: (event: AgentEvent) => boolean): Promise<AgentEvent>;
}> {
  const files = new Map<string, string>();
  if (options.yaml !== undefined) files.set(CONFIG_PATH, options.yaml);
  const pushed: { channel: string; payload: unknown }[] = [];
  const listeners = new Set<() => void>();
  let ids = 0;
  const deps: OsAgentDeps = {
    push: (channel, payload) => {
      pushed.push({ channel, payload });
      for (const listener of [...listeners]) listener();
    },
    configPath: CONFIG_PATH,
    configIo: {
      readFile: async (path) => {
        const text = files.get(path);
        if (text === undefined)
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return text;
      },
      writeFile: async (path, text) => {
        files.set(path, text);
      },
    },
    secrets: createMemorySecretStore(),
    providerKeys: createMemorySecretStore(),
    makeProvider: (section: ProviderSection) =>
      options.providers?.[`${section.kind} ${section.baseUrl} ${section.model}`] ?? down(),
    connectMcp: async () => options.sessions ?? [],
    readModelState: async () => null,
    audit: { append: async () => {}, list: async () => [] },
    now: () => 1_000,
    newId: () => `id${++ids}`,
    timers: {
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    },
    log: () => {},
    ...options.overrides,
  };
  const agent = createOsAgent(deps);
  await agent.start();
  const events = () =>
    pushed.filter((p) => p.channel === "agent:events").map((p) => p.payload as AgentEvent);
  const waitFor = (match: (event: AgentEvent) => boolean) =>
    new Promise<AgentEvent>((resolve) => {
      const check = () => {
        const found = events().find(match);
        if (found === undefined) return;
        listeners.delete(check);
        resolve(found);
      };
      listeners.add(check);
      check();
    });
  return { agent, files, pushed, events, waitFor };
}
