// A minimal MCP client over stdio (contracts §1): newline-delimited JSON-RPC
// 2.0, protocol 2025-06-18 only. Four operations — initialize,
// notifications/initialized, tools/list (paged), tools/call — plus answering
// a server's ping. Our own servers (jarvis-pkg, jarvis-diag) are the only
// peers in M1, so a ~200-line client with an injected spawn beats the
// official SDK's dependency tree in a RAM-budgeted image; every field it
// reads is parsed by hand.
import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { type McpCallResult, type McpSession, type McpTool, isRecord } from "@jarvis/core";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MAX_MCP_LINE_CHARS = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TOOL_PAGES = 20;

export type McpChild = {
  write(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
};
export type McpSpawn = (command: string, args: readonly string[]) => McpChild;
export type McpTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type ConnectMcpOptions = {
  /** The server's allowlist name: "jarvis-pkg" or "jarvis-diag". */
  name: string;
  command: string;
  args?: readonly string[];
  spawn: McpSpawn;
  timers: McpTimers;
  clientVersion: string;
  log(line: string): void;
  timeoutMs?: number;
};

function parseTool(raw: unknown): McpTool | undefined {
  if (!isRecord(raw)) return undefined;
  const { name, description, inputSchema } = raw;
  if (typeof name !== "string" || name.length === 0 || name.length > 128) return undefined;
  return {
    name,
    description: typeof description === "string" ? description : "",
    inputSchema: isRecord(inputSchema) ? inputSchema : { type: "object" },
    meta: raw["_meta"],
  };
}

function parseCallResult(raw: unknown): McpCallResult {
  if (!isRecord(raw))
    return { isError: true, structuredContent: null, text: "The tool sent no result" };
  const content = Array.isArray(raw["content"]) ? raw["content"] : [];
  const text = content
    .flatMap((item) =>
      isRecord(item) && item["type"] === "text" && typeof item["text"] === "string"
        ? [item["text"]]
        : [],
    )
    .join("\n");
  const structured = raw["structuredContent"] ?? null;
  return {
    isError: raw["isError"] === true,
    structuredContent: structured,
    text: text !== "" ? text : structured === null ? "" : JSON.stringify(structured),
  };
}

export async function connectMcpServer(options: ConnectMcpOptions): Promise<McpSession> {
  const child = options.spawn(options.command, options.args ?? []);
  let alive = true;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: unknown }
  >();
  const send = (message: Record<string, unknown>) =>
    child.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

  child.onExit((code) => {
    alive = false;
    for (const waiter of pending.values()) {
      options.timers.clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP server ${options.name} exited (${code ?? "signal"})`));
    }
    pending.clear();
  });

  child.onLine((line) => {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      options.log(`[mcp ${options.name}] ignored a line that is not JSON`);
      return;
    }
    if (!isRecord(message)) return;
    const id = message["id"];
    const method = message["method"];
    if (typeof method === "string") {
      if (id === undefined) return; // A notification: nothing to answer.
      if (method === "ping") send({ id, result: {} });
      else send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    if (typeof id !== "number") return;
    const waiter = pending.get(id);
    if (waiter === undefined) return;
    pending.delete(id);
    options.timers.clearTimeout(waiter.timer);
    const error = message["error"];
    if (isRecord(error)) {
      waiter.reject(
        new Error(typeof error["message"] === "string" ? error["message"] : "MCP error"),
      );
    } else {
      waiter.resolve(message["result"]);
    }
  });

  function call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (!alive) return Promise.reject(new Error(`MCP server ${options.name} is not running`));
    const id = nextId++;
    const limit = timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = options.timers.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP server ${options.name} did not answer ${method} within ${limit} ms`));
      }, limit);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }

  let init: unknown;
  try {
    init = await call("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "jarvisd", version: options.clientVersion },
    });
  } catch (error) {
    child.kill();
    throw error;
  }
  const version = isRecord(init) ? init["protocolVersion"] : undefined;
  if (version !== MCP_PROTOCOL_VERSION) {
    alive = false;
    child.kill();
    throw new Error(
      `MCP server ${options.name} speaks protocol ${String(version)}, not ${MCP_PROTOCOL_VERSION}`,
    );
  }
  send({ method: "notifications/initialized" });

  return {
    name: options.name,
    get alive() {
      return alive;
    },
    async listTools() {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const result = await call("tools/list", cursor === undefined ? {} : { cursor });
        if (!isRecord(result) || !Array.isArray(result["tools"])) {
          throw new Error(`MCP server ${options.name} sent a malformed tools/list`);
        }
        for (const raw of result["tools"]) {
          const tool = parseTool(raw);
          if (tool === undefined) options.log(`[mcp ${options.name}] skipped a malformed tool`);
          else tools.push(tool);
        }
        cursor = typeof result["nextCursor"] === "string" ? result["nextCursor"] : undefined;
        if (cursor === undefined) break;
      }
      return tools;
    },
    async callTool(name, args, callOptions) {
      return parseCallResult(
        await call("tools/call", { name, arguments: args }, callOptions?.timeoutMs),
      );
    },
    close() {
      if (alive) child.kill();
      alive = false;
    },
  };
}

/** The real spawn: stdout split into lines (one decoder for the whole
 *  stream), stderr kept as a 4 KiB tail and logged when the server exits. */
export function nodeMcpSpawn(env: NodeJS.ProcessEnv, log: (line: string) => void): McpSpawn {
  return (command, args) => {
    const child = nodeSpawn(command, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    const lineListeners: Array<(line: string) => void> = [];
    const exitListeners: Array<(code: number | null) => void> = [];
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let stderrTail = "";
    let exited = false;

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        for (const listener of lineListeners) listener(line);
      }
      if (buffer.length > MAX_MCP_LINE_CHARS) {
        log(`[mcp] ${command} sent a line over ${MAX_MCP_LINE_CHARS} characters; stopping it`);
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4_096);
    });
    const finish = (code: number | null) => {
      if (exited) return;
      exited = true;
      if (stderrTail.trim() !== "")
        log(`[mcp] ${command} stderr: ${stderrTail.trim().slice(-1_000)}`);
      for (const listener of exitListeners) listener(code);
    };
    child.on("error", (error) => {
      log(`[mcp] ${command}: ${error.message}`);
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {
      // The server went away; "close" reports it.
    });
    return {
      write(line) {
        if (child.stdin.writable) child.stdin.write(line);
      },
      onLine(listener) {
        lineListeners.push(listener);
      },
      onExit(listener) {
        exitListeners.push(listener);
      },
      kill() {
        child.kill("SIGTERM");
      },
    };
  };
}
