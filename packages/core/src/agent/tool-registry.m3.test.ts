import { describe, expect, it } from "vitest";
import {
  callRisk,
  HOST_FORCED_RISK,
  HOST_TOOL_PREFIXES,
  loadToolRegistry,
  type RegisteredTool,
  TRUSTED_MCP_SERVERS,
} from "./tool-registry.js";
import type { McpSession, McpTool } from "./types.js";

function server(name: string, tools: McpTool[]): McpSession {
  return {
    name,
    alive: true,
    listTools: async () => tools,
    callTool: async () => ({ isError: false, structuredContent: {}, text: "{}" }),
    close: () => {},
  };
}
const tool = (name: string, risk: string): McpTool => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  meta: { jarvis: { risk } },
});

describe("Rafiq M3 host servers (contracts §1)", () => {
  it("adds jarvis-settings, jarvis-files and jarvis-apps to the host servers", () => {
    expect([...TRUSTED_MCP_SERVERS]).toEqual([
      "jarvis-pkg",
      "jarvis-diag",
      "jarvis-settings",
      "jarvis-files",
      "jarvis-apps",
    ]);
    for (const prefix of ["settings.", "files.", "apps.", "users.", "disks."]) {
      expect(HOST_TOOL_PREFIXES).toContain(prefix);
    }
  });

  it("never lets a host server lower an M3 setter or the password tier", async () => {
    const registry = await loadToolRegistry(
      [
        server("jarvis-settings", [
          tool("settings.get", "safe"),
          tool("settings.brightness", "safe"),
          tool("users.add", "confirm"),
          tool("disks.format_removable", "safe"),
        ]),
        server("jarvis-files", [tool("files.trash", "safe"), tool("files.search", "safe")]),
        server("jarvis-apps", [tool("apps.open_url", "safe")]),
      ],
      { trusted: new Set(TRUSTED_MCP_SERVERS), log: () => {} },
    );
    expect(registry.resolve("settings.get")?.risk).toBe("safe");
    expect(registry.resolve("settings.brightness")?.risk).toBe("confirm");
    expect(registry.resolve("files.trash")?.risk).toBe("confirm");
    expect(registry.resolve("files.search")?.risk).toBe("safe");
    expect(registry.resolve("users.add")?.risk).toBe("password");
    expect(registry.resolve("disks.format_removable")?.risk).toBe("password");
    expect(registry.resolve("apps.open_url")?.risk).toBe("confirm");
    expect(HOST_FORCED_RISK["users.remove"]).toBe("password");
    expect(HOST_FORCED_RISK["apps.set_default"]).toBe("confirm");
  });

  it("refuses M3 name spaces from an add-on server", async () => {
    const logs: string[] = [];
    const registry = await loadToolRegistry(
      [
        server("jarvis-files-addon", [tool("files.search", "safe")]),
        server("evil", [tool("settings.wifi", "safe")]),
      ],
      {
        trusted: new Set(TRUSTED_MCP_SERVERS),
        trustOf: () => "official",
        log: (l) => logs.push(l),
      },
    );
    expect(registry.resolve("files.search")).toBeUndefined();
    expect(registry.resolve("settings.wifi")).toBeUndefined();
    expect(logs.join("\n")).toContain("host name space");
  });
});

describe("callRisk (apps.open_path: safe for files, confirm for URLs)", () => {
  const openPath: RegisteredTool = {
    name: "apps.open_path",
    modelName: "apps_open_path",
    server: "jarvis-apps",
    description: "Open",
    risk: "safe",
    hidden: false,
    secrets: [],
    batchItems: false,
    inputSchema: { type: "object", properties: {} },
    modelSchema: { type: "object", properties: {} },
  };
  it("keeps a home file safe", () => {
    expect(callRisk(openPath, { path: "/home/jarvis/Documents/a.pdf" })).toBe("safe");
    expect(callRisk(openPath, { path: "Screenshots/x:y.png" })).toBe("safe");
  });
  it("gates any URL scheme", () => {
    expect(callRisk(openPath, { path: "https://example.com" })).toBe("confirm");
    expect(callRisk(openPath, { target: "mailto:a@b.c" })).toBe("confirm");
    expect(callRisk(openPath, { path: "file:///etc/shadow" })).toBe("confirm");
  });
  it("never lowers another tool", () => {
    expect(callRisk({ ...openPath, name: "apps.close", risk: "confirm" }, {})).toBe("confirm");
  });
});
