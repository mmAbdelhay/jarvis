import { describe, expect, it } from "vitest";
import { loadToolRegistry } from "./tool-registry.js";
import type { McpSession } from "./types.js";

function session(refuseLang: boolean) {
  const describeArgs: Record<string, unknown>[] = [];
  const s: McpSession = {
    name: "jarvis-pkg",
    alive: true,
    listTools: async () => [
      { name: "jarvis.describe", description: "", inputSchema: { type: "object" }, meta: {} },
      {
        name: "pkg.install",
        description: "i",
        inputSchema: { type: "object" },
        meta: { jarvis: { risk: "confirm" } },
      },
    ],
    callTool: async (_tool, args) => {
      describeArgs.push(args);
      if (refuseLang && "lang" in args)
        return { isError: true, structuredContent: { code: "invalid" }, text: "bad arguments" };
      const lang = args["lang"] === "ar" ? "ar" : "en";
      return {
        isError: false,
        structuredContent: {
          title: lang === "ar" ? "تثبيت vlc" : "Install vlc",
          detail: "",
          source: "debian",
        },
        text: "",
      };
    },
    close: () => {},
  };
  return { s, describeArgs };
}

describe("jarvis.describe gets the turn language (M4 §3)", () => {
  it("sends lang only for Arabic", async () => {
    const { s, describeArgs } = session(false);
    const registry = await loadToolRegistry([s], {
      trusted: new Set(["jarvis-pkg"]),
      log: () => {},
    });
    const tool = registry.get("pkg.install");
    if (tool === undefined) throw new Error("no tool");
    expect((await registry.describe(tool, { items: ["vlc"] }, "ar")).title).toBe("تثبيت vlc");
    expect((await registry.describe(tool, { items: ["vlc"] })).title).toBe("Install vlc");
    expect(describeArgs).toEqual([
      { tool: "pkg.install", input: { items: ["vlc"] }, lang: "ar" },
      { tool: "pkg.install", input: { items: ["vlc"] } },
    ]);
  });

  it("asks again without lang when an older server refuses it", async () => {
    const { s, describeArgs } = session(true);
    const registry = await loadToolRegistry([s], {
      trusted: new Set(["jarvis-pkg"]),
      log: () => {},
    });
    const tool = registry.get("pkg.install");
    if (tool === undefined) throw new Error("no tool");
    expect((await registry.describe(tool, { items: ["vlc"] }, "ar")).title).toBe("Install vlc");
    expect(describeArgs).toHaveLength(2);
  });
});
