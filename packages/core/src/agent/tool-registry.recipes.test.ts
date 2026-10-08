import { describe, expect, it } from "vitest";
import { loadToolRegistry } from "./tool-registry.js";
import type { McpSession } from "./types.js";

const session = (name: string, risk: string): McpSession => ({
  name,
  alive: true,
  listTools: async () => [
    {
      name: "recipes.run",
      description: "r",
      inputSchema: { type: "object" },
      meta: { jarvis: { risk } },
    },
  ],
  callTool: async () => ({ isError: false, structuredContent: {}, text: "" }),
  close: () => {},
});

describe("recipes.run is a host tool that always cards (M4 §4)", () => {
  it("is confirm even when the host server says safe", async () => {
    const registry = await loadToolRegistry([session("jarvis-pkg", "safe")], {
      trusted: new Set(["jarvis-pkg"]),
      log: () => {},
    });
    expect(registry.get("recipes.run")?.risk).toBe("confirm");
  });

  it("is refused from an add-on server", async () => {
    const registry = await loadToolRegistry([session("acme", "confirm")], {
      trusted: new Set(["jarvis-pkg"]),
      trustOf: () => "official",
      log: () => {},
    });
    expect(registry.get("recipes.run")).toBeUndefined();
  });
});
