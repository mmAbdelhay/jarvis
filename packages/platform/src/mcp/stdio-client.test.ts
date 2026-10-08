import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connectMcpServer, type McpChild, type McpSpawn, nodeMcpSpawn } from "./stdio-client.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/fake-mcp-server.mjs", import.meta.url));
const realTimers = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
};

/** A scripted child: `respond` decides each answer from the request. */
function scriptedSpawn(
  respond: (
    message: Record<string, unknown>,
    child: { emit(line: string): void; exit(code: number): void },
  ) => void,
) {
  const written: Record<string, unknown>[] = [];
  let lineListener: (line: string) => void = () => {};
  let exitListener: (code: number | null) => void = () => {};
  let killed = false;
  const handle = {
    emit: (line: string) => lineListener(line),
    exit: (code: number) => exitListener(code),
  };
  const spawn: McpSpawn = () => {
    const child: McpChild = {
      write(line) {
        const message = JSON.parse(line) as Record<string, unknown>;
        written.push(message);
        queueMicrotask(() => respond(message, handle));
      },
      onLine(listener) {
        lineListener = listener;
      },
      onExit(listener) {
        exitListener = listener;
      },
      kill() {
        killed = true;
      },
    };
    return child;
  };
  return { spawn, written, handle, wasKilled: () => killed };
}

const initOk = (message: Record<string, unknown>, child: { emit(line: string): void }) => {
  if (message["method"] === "initialize") {
    child.emit(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message["id"],
        result: { protocolVersion: "2025-06-18", capabilities: {} },
      }),
    );
  }
};

const base = {
  name: "jarvis-diag",
  command: "/usr/lib/jarvis/mcp/jarvis-diag",
  timers: realTimers,
  clientVersion: "test",
  log: () => {},
};

describe("connectMcpServer over a scripted child", () => {
  it("initializes with the pinned version and sends notifications/initialized", async () => {
    const { spawn, written } = scriptedSpawn(initOk);
    await connectMcpServer({ ...base, spawn });
    expect(written[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "jarvisd", version: "test" },
      },
    });
    expect(written[1]).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
  });

  it("refuses a server that negotiates another protocol version, and kills it", async () => {
    const scripted = scriptedSpawn((message, child) => {
      child.emit(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message["id"],
          result: { protocolVersion: "2024-11-05" },
        }),
      );
    });
    await expect(connectMcpServer({ ...base, spawn: scripted.spawn })).rejects.toThrow(
      /2024-11-05/,
    );
    expect(scripted.wasKilled()).toBe(true);
  });

  it("answers a server ping, ignores notifications and non-JSON lines", async () => {
    const { spawn, written, handle } = scriptedSpawn(initOk);
    await connectMcpServer({ ...base, spawn });
    handle.emit("this is a log line, not JSON");
    handle.emit(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
    handle.emit(JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "ping" }));
    handle.emit(JSON.stringify({ jsonrpc: "2.0", id: "srv-2", method: "roots/list" }));
    expect(written).toContainEqual({ jsonrpc: "2.0", id: "srv-1", result: {} });
    expect(written).toContainEqual({
      jsonrpc: "2.0",
      id: "srv-2",
      error: { code: -32601, message: "Method not found: roots/list" },
    });
  });

  it("rejects pending calls when the server exits, and is then not alive", async () => {
    const { spawn, handle } = scriptedSpawn(initOk);
    const session = await connectMcpServer({ ...base, spawn });
    const pending = session.callTool("net.status", {});
    handle.exit(1);
    await expect(pending).rejects.toThrow(/exited/);
    expect(session.alive).toBe(false);
    await expect(session.callTool("net.status", {})).rejects.toThrow(/not running/);
  });

  it("times a call out", async () => {
    const { spawn } = scriptedSpawn(initOk);
    const session = await connectMcpServer({ ...base, spawn });
    await expect(session.callTool("net.status", {}, { timeoutMs: 20 })).rejects.toThrow(
      /did not answer/,
    );
  });

  it("maps an MCP error result to isError with structured content", async () => {
    const { spawn } = scriptedSpawn((message, child) => {
      initOk(message, child);
      if (message["method"] === "tools/call") {
        child.emit(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message["id"],
            result: {
              isError: true,
              structuredContent: {
                code: "not_allowed",
                message: "sshd is not on the restart allowlist",
              },
              content: [{ type: "text", text: "sshd is not on the restart allowlist" }],
            },
          }),
        );
      }
    });
    const session = await connectMcpServer({ ...base, spawn });
    await expect(session.callTool("svc.restart", { unit: "sshd" })).resolves.toEqual({
      isError: true,
      structuredContent: { code: "not_allowed", message: "sshd is not on the restart allowlist" },
      text: "sshd is not on the restart allowlist",
    });
  });
});

describe("connectMcpServer against a real process", () => {
  it("lists every page of tools with their _meta and calls one", async () => {
    const session = await connectMcpServer({
      ...base,
      name: "jarvis-pkg",
      command: process.execPath,
      args: [FIXTURE, "jarvis-pkg"],
      spawn: nodeMcpSpawn(process.env, () => {}),
    });
    try {
      const tools = await session.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "pkg.search",
        "pkg.install",
        "net.wifi_connect",
        "test.crash",
        "updates.list",
        "updates.apply",
        "jarvis.describe",
      ]);
      expect(tools[1]?.meta).toEqual({
        jarvis: { risk: "confirm", hidden: false, secrets: [], batch: "items" },
      });
      const result = await session.callTool("pkg.search", { query: "vlc" });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        results: [{ source: "apt", id: "vlc", name: "vlc", version: "1.0", summary: "x" }],
      });
      expect(JSON.parse(result.text)).toEqual(result.structuredContent);
    } finally {
      session.close();
    }
  });

  it("notices a server that dies mid-call", async () => {
    const session = await connectMcpServer({
      ...base,
      name: "jarvis-pkg",
      command: process.execPath,
      args: [FIXTURE, "jarvis-pkg"],
      spawn: nodeMcpSpawn(process.env, () => {}),
    });
    await expect(session.callTool("test.crash", {})).rejects.toThrow(/exited/);
    expect(session.alive).toBe(false);
  });
});

it("settings fixture describes the exact transition and returns a reversible setter", async () => {
  const session = await connectMcpServer({
    ...base,
    name: "jarvis-settings",
    command: process.execPath,
    args: [FIXTURE, "jarvis-settings"],
    spawn: nodeMcpSpawn(process.env, () => {}),
  });
  try {
    expect((await session.listTools()).map((tool) => tool.name)).toEqual([
      "settings.brightness",
      "jarvis.describe",
    ]);
    expect(
      (
        await session.callTool("jarvis.describe", {
          tool: "settings.brightness",
          input: { percent: 80 },
        })
      ).structuredContent,
    ).toMatchObject({ detail: "40 → 80" });
    expect(
      (await session.callTool("settings.brightness", { percent: 80 })).structuredContent,
    ).toEqual({
      previous: 40,
      current: 80,
      undo: { tool: "settings.brightness", input: { percent: 40 } },
    });
    expect(
      (await session.callTool("settings.brightness", { percent: 40 })).structuredContent,
    ).toMatchObject({ previous: 80, current: 40 });
  } finally {
    session.close();
  }
});
