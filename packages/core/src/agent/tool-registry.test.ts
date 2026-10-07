import { describe, expect, it } from "vitest";
import {
  loadToolRegistry,
  parseJarvisMeta,
  stripSecrets,
  toModelName,
  TRUSTED_MCP_SERVERS,
} from "./tool-registry.js";
import type { McpCallResult, McpSession, McpTool } from "./types.js";

const meta = (risk: unknown, extra: Record<string, unknown> = {}) => ({
  jarvis: { risk, ...extra },
});

function fakeSession(
  name: string,
  tools: McpTool[],
  answer?: (tool: string, args: Record<string, unknown>) => McpCallResult,
) {
  const calls: { tool: string; args: Record<string, unknown>; timeoutMs?: number }[] = [];
  const session: McpSession = {
    name,
    alive: true,
    listTools: async () => tools,
    callTool: async (tool, args, options) => {
      calls.push({
        tool,
        args,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      if (answer === undefined) throw new Error("no answer");
      return answer(tool, args);
    },
    close: () => {},
  };
  return { session, calls };
}

const tool = (
  name: string,
  metaValue: unknown,
  schema: Record<string, unknown> = { type: "object", properties: {} },
): McpTool => ({
  name,
  description: `${name} description`,
  inputSchema: schema,
  meta: metaValue,
});

const trusted = new Set<string>(TRUSTED_MCP_SERVERS);

describe("parseJarvisMeta", () => {
  it("trusts declared risk only from allowlisted servers", () => {
    expect(parseJarvisMeta(meta("safe"), true).risk).toBe("safe");
    expect(parseJarvisMeta(meta("safe"), false).risk).toBe("confirm");
    expect(parseJarvisMeta(meta("password"), false).risk).toBe("password");
  });
  it("fails closed on missing or unknown risk", () => {
    expect(parseJarvisMeta(undefined, true).risk).toBe("confirm");
    expect(parseJarvisMeta(meta("harmless"), true).risk).toBe("confirm");
  });
  it("reads hidden and well-formed secret names only", () => {
    expect(
      parseJarvisMeta(
        meta("confirm", { hidden: true, secrets: ["password", 7, "a b", "password"] }),
        true,
      ),
    ).toEqual({
      risk: "confirm",
      hidden: true,
      secrets: ["password"],
      batchItems: false,
    });
  });
  it('reads batch: "items" (contracts §6 #1) and ignores any other value', () => {
    expect(parseJarvisMeta(meta("confirm", { batch: "items" }), true).batchItems).toBe(true);
    expect(parseJarvisMeta(meta("confirm", { batch: "all" }), true).batchItems).toBe(false);
    expect(parseJarvisMeta(meta("confirm"), true).batchItems).toBe(false);
  });
});

describe("toModelName and stripSecrets", () => {
  it("maps dotted names to the [A-Za-z0-9_-] alphabet providers accept", () => {
    expect(toModelName("pkg.install")).toBe("pkg_install");
    expect(toModelName("net.wifi_connect")).toBe("net_wifi_connect");
  });
  it("removes secret properties and requirements from the schema the model sees", () => {
    expect(
      stripSecrets(
        {
          type: "object",
          properties: { ssid: { type: "string" }, password: { type: "string" } },
          required: ["ssid", "password"],
        },
        ["password"],
      ),
    ).toEqual({ type: "object", properties: { ssid: { type: "string" } }, required: ["ssid"] });
  });
});

describe("loadToolRegistry", () => {
  it("offers visible tools under model names with secrets stripped, hides hidden ones", async () => {
    const pkg = fakeSession("jarvis-pkg", [
      tool("pkg.install", meta("confirm")),
      tool("jarvis.describe", meta("safe", { hidden: true })),
    ]);
    const diag = fakeSession("jarvis-diag", [
      tool("net.wifi_connect", meta("confirm", { secrets: ["password"] }), {
        type: "object",
        properties: { ssid: { type: "string" }, password: { type: "string" } },
        required: ["ssid"],
      }),
    ]);
    const registry = await loadToolRegistry([pkg.session, diag.session], {
      trusted,
      log: () => {},
    });
    expect(registry.modelTools().map((t) => t.name)).toEqual(["pkg_install", "net_wifi_connect"]);
    expect(registry.modelTools()[1]?.inputSchema).toEqual({
      type: "object",
      properties: { ssid: { type: "string" } },
      required: ["ssid"],
    });
    expect(registry.resolve("pkg_install")?.name).toBe("pkg.install");
    expect(registry.resolve("pkg.install")?.name).toBe("pkg.install");
    expect(registry.resolve("jarvis_describe")).toBeUndefined();
    expect(registry.get("net.wifi_connect")?.secrets).toEqual(["password"]);
  });

  it("makes an unknown server's tools confirm even when they claim safe", async () => {
    const other = fakeSession("someone-else", [tool("files.delete_all", meta("safe"))]);
    const registry = await loadToolRegistry([other.session], { trusted, log: () => {} });
    expect(registry.get("files.delete_all")?.risk).toBe("confirm");
  });

  it("keeps the first of two tools whose names collide, and logs it", async () => {
    const lines: string[] = [];
    const a = fakeSession("jarvis-pkg", [tool("x.y", meta("safe"))]);
    const b = fakeSession("jarvis-diag", [tool("x_y", meta("confirm"))]);
    const registry = await loadToolRegistry([a.session, b.session], {
      trusted,
      log: (l) => lines.push(l),
    });
    expect(registry.modelTools().map((t) => t.name)).toEqual(["x_y"]);
    expect(registry.resolve("x_y")?.server).toBe("jarvis-pkg");
    expect(lines.join("\n")).toMatch(/collides/);
  });

  it("skips a server whose tools/list fails", async () => {
    const broken: McpSession = {
      name: "jarvis-diag",
      alive: true,
      listTools: async () => {
        throw new Error("boom");
      },
      callTool: async () => ({ isError: false, structuredContent: null, text: "" }),
      close: () => {},
    };
    const pkg = fakeSession("jarvis-pkg", [tool("pkg.search", meta("safe"))]);
    const registry = await loadToolRegistry([broken, pkg.session], { trusted, log: () => {} });
    expect(registry.modelTools().map((t) => t.name)).toEqual(["pkg_search"]);
  });

  it("drops secret fields and non-object input the model sends", async () => {
    const diag = fakeSession("jarvis-diag", [
      tool("net.wifi_connect", meta("confirm", { secrets: ["password"] })),
    ]);
    const registry = await loadToolRegistry([diag.session], { trusted, log: () => {} });
    const wifi = registry.get("net.wifi_connect");
    if (wifi === undefined) throw new Error("missing");
    expect(registry.sanitizeInput(wifi, { ssid: "Home", password: "model-guessed" })).toEqual({
      ssid: "Home",
    });
    expect(registry.sanitizeInput(wifi, "Home")).toEqual({});
  });

  it("calls a tool with a timeout by risk and maps errors to ToolOutcome", async () => {
    const pkg = fakeSession(
      "jarvis-pkg",
      [tool("pkg.search", meta("safe")), tool("pkg.install", meta("confirm"))],
      (name) =>
        name === "pkg.search"
          ? { isError: false, structuredContent: { results: [] }, text: '{"results":[]}' }
          : {
              isError: true,
              structuredContent: { code: "offline", message: "no network" },
              text: "no network",
            },
    );
    const registry = await loadToolRegistry([pkg.session], { trusted, log: () => {} });
    await expect(registry.call("pkg.search", { query: "vlc" })).resolves.toEqual({
      ok: true,
      data: { results: [] },
      text: '{"results":[]}',
    });
    await expect(registry.call("pkg.install", { items: [] })).resolves.toEqual({
      ok: false,
      data: { code: "offline", message: "no network" },
      text: "no network",
      code: "offline",
    });
    expect(pkg.calls.map((c) => c.timeoutMs)).toEqual([60_000, 5_100_000]);
    await expect(registry.call("nope", {})).resolves.toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("describes a call through the server's jarvis.describe, with a fallback", async () => {
    const pkg = fakeSession(
      "jarvis-pkg",
      [
        tool("pkg.install", meta("confirm")),
        tool("jarvis.describe", meta("safe", { hidden: true })),
      ],
      (name, args) =>
        name === "jarvis.describe"
          ? {
              isError: false,
              structuredContent: {
                title: "Install VLC 3.0.21 from Debian, 45 MB",
                detail: "media player",
                source: "debian",
              },
              text: "",
            }
          : { isError: false, structuredContent: args, text: "" },
    );
    const registry = await loadToolRegistry([pkg.session], { trusted, log: () => {} });
    const install = registry.get("pkg.install");
    if (install === undefined) throw new Error("missing");
    await expect(
      registry.describe(install, { items: [{ source: "apt", id: "vlc" }] }),
    ).resolves.toEqual({
      title: "Install VLC 3.0.21 from Debian, 45 MB",
      detail: "media player",
      source: "debian",
    });
    expect(pkg.calls[0]).toMatchObject({
      tool: "jarvis.describe",
      args: { tool: "pkg.install", input: { items: [{ source: "apt", id: "vlc" }] } },
    });

    const bare = fakeSession("jarvis-diag", [tool("svc.restart", meta("confirm"))]);
    const plain = await loadToolRegistry([bare.session], { trusted, log: () => {} });
    const restart = plain.get("svc.restart");
    if (restart === undefined) throw new Error("missing");
    await expect(plain.describe(restart, { unit: "NetworkManager" })).resolves.toEqual({
      title: "svc.restart",
      detail: '{"unit":"NetworkManager"}',
      source: "system",
    });
  });
});
