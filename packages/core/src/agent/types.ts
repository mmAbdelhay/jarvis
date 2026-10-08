// The provider-neutral agent vocabulary (spec §4). Named Model* so nothing
// collides with the orchestrator's ToolSpec/Brain, which stay as they are.
// Pure: no node:*, no workspace imports.
import type { ProbeResult } from "./contract.js";

export type ModelToolSpec = {
  /** The name the model sees: [A-Za-z0-9_-]{1,64} (ToolRegistry maps it back). */
  name: string;
  description: string;
  /** JSON Schema of the input, with secret fields already removed. */
  inputSchema: Record<string, unknown>;
};

export type ModelToolCall = { id: string; name: string; input: unknown };
export type ModelToolResult = { callId: string; name: string; content: string; isError: boolean };

export type ModelMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ModelToolCall[] }
  | { role: "tool"; results: ModelToolResult[] };

export type ModelUsage = { inputTokens: number; outputTokens: number };

export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "done"; usage: ModelUsage };

export type ModelChatRequest = {
  system: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  /** The step-limit report: answer in words, never with a tool, whichever
   *  provider (and tool profile) takes the request. */
  final?: boolean;
  signal: AbortSignal;
};

export interface ModelProvider {
  chat(request: ModelChatRequest): AsyncIterable<ModelEvent>;
  /** Lists models and sends one tiny tool-call request (spec §4). */
  probe(): Promise<ProbeResult>;
  /** Lists models only; throws ProviderError. provider:probe with model ""
   *  uses it (contracts §6 #10). */
  listModels(signal?: AbortSignal): Promise<string[]>;
  /** Cheap: lists models only. Drives provider:status and the doctor's last step. */
  reachable(signal?: AbortSignal): Promise<{ ok: boolean; error?: string }>;
}

/** network: no answer at all; auth: 401/403 or no key; http: any other non-2xx;
 *  bad-response: an answer we cannot read. */
export type ProviderErrorKind = "network" | "auth" | "http" | "bad-response";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ToolRisk = "safe" | "confirm" | "password";

/** One tool call's result as the loop and the doctor see it. `text` is what
 *  the model gets (fenced); `data` is structuredContent; `code` is the
 *  contract §1 error code when ok is false. */
export type ToolOutcome = { ok: boolean; data: unknown; text: string; code?: string };

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The tool's raw `_meta`; ToolRegistry parses `_meta.jarvis` from it. */
  meta: unknown;
};

export type McpCallResult = { isError: boolean; structuredContent: unknown; text: string };

export interface McpSession {
  readonly name: string;
  readonly alive: boolean;
  listTools(): Promise<McpTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<McpCallResult>;
  close(): void;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
