import {
  type AgentEvent,
  type AuditEntry,
  type DoctorState,
  type McpSession,
  type McpTool,
  type ModelProvider,
  parseFakeScript,
} from "@jarvis/core";
import { createMemorySecretStore, providerAccount } from "@jarvis/platform/model";
import { describe, expect, it } from "vitest";
import { createOsAgent, OsAgentError, type OsAgentDeps } from "./agent-service.js";
import type { ConfigIo } from "./provider-config.js";

const pkgTools: McpTool[] = [
  {
    name: "pkg.install",
    description: "Install",
    inputSchema: { type: "object", properties: {} },
    meta: { jarvis: { risk: "confirm" } },
  },
];
const diagTools: McpTool[] = [
  {
    name: "net.status",
    description: "Status",
    inputSchema: { type: "object", properties: {} },
    meta: { jarvis: { risk: "safe" } },
  },
  {
    name: "sys.health",
    description: "Health",
    inputSchema: { type: "object", properties: {} },
    meta: { jarvis: { risk: "safe" } },
  },
  {
    name: "svc.list_failed",
    description: "Failed",
    inputSchema: { type: "object", properties: {} },
    meta: { jarvis: { risk: "safe" } },
  },
];

function session(
  name: string,
  tools: McpTool[],
  calls: string[],
  alive = { value: true },
): McpSession {
  return {
    name,
    get alive() {
      return alive.value;
    },
    listTools: async () => tools,
    callTool: async (tool) => {
      calls.push(tool);
      if (tool === "net.status") {
        return {
          isError: false,
          structuredContent: {
            nmRunning: true,
            connectivity: "full",
            devices: [{ name: "eth0", type: "ethernet", state: "connected", connection: "Wired" }],
            ips: [],
            defaultRoute: "10.0.0.1 dev eth0",
            dnsOk: true,
            gatewayPingOk: true,
            wifiSoftBlocked: false,
            wifiHardBlocked: false,
          },
          text: "{}",
        };
      }
      if (tool === "sys.health") {
        return {
          isError: false,
          structuredContent: {
            uptimeSec: 60,
            load1: 0.1,
            memTotalBytes: 8_000_000_000,
            memUsedBytes: 500_000_000,
            swapUsedBytes: 0,
            disks: [{ mount: "/", sizeBytes: 64_000_000_000, usedBytes: 6_000_000_000 }],
            failedUnits: 1,
            bootErrors: 0,
          },
          text: "{}",
        };
      }
      if (tool === "svc.list_failed") {
        return {
          isError: false,
          structuredContent: {
            units: [
              {
                unit: "cups.service",
                scope: "system",
                result: "exit-code",
                since: "2026-10-07T09:00:00Z",
              },
            ],
          },
          text: "{}",
        };
      }
      return { isError: false, structuredContent: { ok: true }, text: '{"ok":true}' };
    },
    close: () => {},
  };
}

function harness(overrides: Partial<OsAgentDeps> = {}) {
  const pushes: { channel: string; payload: unknown }[] = [];
  const files = new Map<string, string>();
  const configIo: ConfigIo = {
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    writeFile: async (path, text) => {
      files.set(path, text);
    },
  };
  const audit: AuditEntry[] = [];
  const toolCalls: string[] = [];
  let connects = 0;
  const alive = { value: true };
  let ids = 0;
  const secrets = createMemorySecretStore();
  const agent = createOsAgent({
    push: (channel, payload) => pushes.push({ channel, payload }),
    configPath: "/home/jarvis/.config/jarvis/jarvis.yaml",
    configIo,
    secrets,
    makeProvider: () => {
      throw new Error("makeProvider not expected in this test");
    },
    connectMcp: async () => {
      connects++;
      return [
        session("jarvis-pkg", pkgTools, toolCalls, alive),
        session("jarvis-diag", diagTools, toolCalls, alive),
      ];
    },
    audit: {
      append: async (entry) => {
        audit.push(entry);
      },
      list: async (query) => audit.slice(0, query.limit),
    },
    now: () => 1_000,
    newId: () => `id${++ids}`,
    timers: {
      // Short waits (the keyring retry) run at once; the 5-minute card
      // timeout and the 30 s provider recheck never fire in these tests.
      setTimeout: (callback: () => void, ms: number) => (ms <= 5_000 ? setTimeout(callback, 0) : 0),
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    },
    log: () => {},
    ...overrides,
  });
  const events = () =>
    pushes.filter((p) => p.channel === "agent:events").map((p) => p.payload as AgentEvent);
  const until = async (check: () => boolean) => {
    // `check` may have side effects (some start a prompt), so call it once per tick.
    for (let i = 0; i < 500; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("condition never became true");
  };
  return {
    agent,
    pushes,
    files,
    audit,
    toolCalls,
    events,
    until,
    secrets,
    connects: () => connects,
    alive,
  };
}

const installScript = parseFakeScript([
  {
    expectPromptContains: "install hello",
    replies: [
      { toolCalls: [{ name: "pkg.install", input: { items: [{ source: "apt", id: "hello" }] } }] },
      { text: "Installed hello." },
    ],
  },
  { expectPromptContains: "thanks", replies: [{ text: "You're welcome." }] },
]);

describe("createOsAgent", () => {
  it("runs a prompt through a card to the installed answer, and audits it", async () => {
    const h = harness({ fakeScript: installScript });
    await h.agent.start();
    const { turnId } = h.agent.prompt("please install hello");
    await h.until(() => h.events().some((e) => e.type === "card"));
    const card = h.events().find((e) => e.type === "card");
    if (card?.type !== "card") throw new Error("no card");
    expect(card.card.turnId).toBe(turnId);
    h.agent.confirm({ cardId: card.card.cardId, approve: true, ticked: ["item-1"], secrets: {} });
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    expect(h.events().at(-1)).toEqual({ type: "turn-end", turnId, reason: "done" });
    expect(h.events()).toContainEqual({ type: "text", turnId, delta: "Installed hello." });
    expect(h.toolCalls.filter((t) => t === "pkg.install")).toEqual(["pkg.install"]);
    expect(h.audit[0]).toMatchObject({
      tool: "pkg.install",
      decision: "approved",
      result: "ok",
      via: "desktop",
    });
    // The fake provider works with no provider configured (contracts §6 #11).
    await expect(h.agent.providerList()).resolves.toMatchObject({ active: null });
  });

  it("lets the fake provider replace a configured one (contracts §6 #11)", async () => {
    const h = harness({
      fakeScript: parseFakeScript([{ replies: [{ text: "from the script" }] }]),
      makeProvider: () => {
        throw new Error("the configured provider must not be built");
      },
    });
    h.files.set(
      "/home/jarvis/.config/jarvis/jarvis.yaml",
      "provider:\n  kind: ollama\n  baseUrl: http://10.0.0.2:11434\n  model: qwen3:8b\n",
    );
    await h.agent.start();
    h.agent.prompt("hi");
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    expect(h.events()).toContainEqual(
      expect.objectContaining({ type: "text", delta: "from the script" }),
    );
  });

  it("pushes sys:snapshot from sys.health, net.status and svc.list_failed (contracts §6 #8)", async () => {
    const h = harness({ fakeScript: installScript });
    h.files.set(
      "/home/jarvis/.config/jarvis/jarvis.yaml",
      "provider:\n  kind: ollama\n  baseUrl: http://192.168.1.20:11434\n  model: qwen3:8b\n",
    );
    await h.agent.start();
    await h.until(() => h.pushes.some((p) => p.channel === "sys:snapshot"));
    expect(h.pushes.find((p) => p.channel === "sys:snapshot")?.payload).toEqual({
      online: true,
      network: { connectivity: "full", wifiSsid: null },
      memTotalBytes: 8_000_000_000,
      memUsedBytes: 500_000_000,
      disk: { mount: "/", sizeBytes: 64_000_000_000, usedBytes: 6_000_000_000 },
      failedUnits: ["cups.service"],
      model: {
        kind: "ollama",
        model: "qwen3:8b",
        local: true,
        supportsTools: true,
        download: null,
      },
      updates: { count: 0, security: 0, checkedAt: null },
    });
  });

  it("reads the key lazily at first use and retries a locked keyring (contracts §6 #12)", async () => {
    const keys: string[] = [];
    let reads = 0;
    const secrets = createMemorySecretStore({
      [providerAccount("anthropic", "https://api.anthropic.com")]: "sk-ant-1",
    });
    const lockedOnce = {
      ...secrets,
      get: async (account: string) => {
        reads++;
        if (reads === 1) throw new Error("Cannot get secret of a locked object");
        return secrets.get(account);
      },
    };
    const h = harness({
      secrets: lockedOnce,
      makeProvider: (_section, key) => {
        keys.push(key ?? "none");
        return {
          async *chat() {
            yield { type: "text", delta: "hi" };
            yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
          },
          probe: async () => ({ ok: true, supportsTools: true, models: [] }),
          listModels: async () => [],
          reachable: async () => ({ ok: true }),
        };
      },
    });
    h.files.set(
      "/home/jarvis/.config/jarvis/jarvis.yaml",
      "provider:\n  kind: anthropic\n  baseUrl: https://api.anthropic.com\n  model: claude-sonnet-4-5\n",
    );
    await h.agent.start();
    await h.until(() => keys.length > 0);
    expect(keys).toEqual(["sk-ant-1"]);
    expect(reads).toBe(2);
  });

  it("refuses a second prompt while one runs, and a confirm for no open card", async () => {
    const h = harness({ fakeScript: installScript });
    await h.agent.start();
    h.agent.prompt("please install hello");
    expect(() => h.agent.prompt("again")).toThrow(OsAgentError);
    expect(() =>
      h.agent.confirm({ cardId: "nope", approve: true, ticked: [], secrets: {} }),
    ).toThrow(OsAgentError);
  });

  it("stops a turn by id and ignores an unknown id", async () => {
    const h = harness({ fakeScript: installScript });
    await h.agent.start();
    const { turnId } = h.agent.prompt("please install hello");
    await h.until(() => h.events().some((e) => e.type === "card"));
    expect(h.agent.stop("other")).toBeNull();
    h.agent.stop(turnId);
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    expect(h.events().at(-1)).toEqual({ type: "turn-end", turnId, reason: "stopped" });
    expect(h.toolCalls.filter((t) => t === "pkg.install")).toEqual([]);
  });

  it("lists no provider, saves one after a good probe (key to the keyring, not the file), lists it", async () => {
    const probed: { key: string | undefined }[] = [];
    const provider: ModelProvider = {
      // biome-ignore lint/correctness/useYield: never called here.
      async *chat() {
        throw new Error("unused");
      },
      probe: async () => ({ ok: true, supportsTools: true, models: ["claude-sonnet-4-5"] }),
      listModels: async () => ["claude-sonnet-4-5"],
      reachable: async () => ({ ok: true }),
    };
    const h = harness({
      makeProvider: (_section, key) => {
        probed.push({ key });
        return provider;
      },
    });
    await h.agent.start();
    await expect(h.agent.providerList()).resolves.toEqual({
      active: null,
      kinds: ["anthropic", "openai-compatible", "ollama"],
    });
    const draft = {
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      apiKey: "sk-ant-123",
    } as const;
    await expect(h.agent.save(draft)).resolves.toEqual({
      ok: true,
      supportsTools: true,
      models: ["claude-sonnet-4-5"],
    });
    await expect(
      h.secrets.get(providerAccount("anthropic", "https://api.anthropic.com")),
    ).resolves.toBe("sk-ant-123");
    const yaml = h.files.get("/home/jarvis/.config/jarvis/jarvis.yaml") ?? "";
    expect(yaml).toContain("kind: anthropic");
    expect(yaml).not.toContain("sk-ant-123");
    await expect(h.agent.providerList()).resolves.toEqual({
      active: {
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-4-5",
        hasKey: true,
      },
      kinds: ["anthropic", "openai-compatible", "ollama"],
    });
    // A probe without a key in the draft uses the stored one.
    await h.agent.probe({
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
    });
    expect(probed.at(-1)?.key).toBe("sk-ant-123");
    // Saving again without apiKey keeps the stored key (contracts §6 #10).
    await h.agent.save({
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-haiku-4-5",
    });
    await expect(
      h.secrets.get(providerAccount("anthropic", "https://api.anthropic.com")),
    ).resolves.toBe("sk-ant-123");
    await expect(h.agent.providerList()).resolves.toMatchObject({
      active: { model: "claude-haiku-4-5", hasKey: true },
    });
  });

  it('probes with model "" by listing models only, and refuses to save it (contracts §6 #10)', async () => {
    let probes = 0;
    const provider: ModelProvider = {
      // biome-ignore lint/correctness/useYield: never called here.
      async *chat() {
        throw new Error("unused");
      },
      probe: async () => {
        probes++;
        return { ok: true, supportsTools: true, models: [] };
      },
      listModels: async () => ["qwen3:8b", "gemma3:4b"],
      reachable: async () => ({ ok: true }),
    };
    const h = harness({ makeProvider: () => provider });
    await h.agent.start();
    await expect(
      h.agent.probe({ kind: "ollama", baseUrl: "http://10.0.0.2:11434", model: "" }),
    ).resolves.toEqual({
      ok: true,
      supportsTools: false,
      models: ["qwen3:8b", "gemma3:4b"],
    });
    expect(probes).toBe(0);
    await expect(
      h.agent.save({ kind: "ollama", baseUrl: "http://10.0.0.2:11434", model: "" }),
    ).rejects.toBeInstanceOf(OsAgentError);
  });

  it("does not save when the probe fails", async () => {
    const failing: ModelProvider = {
      // biome-ignore lint/correctness/useYield: never called here.
      async *chat() {
        throw new Error("unused");
      },
      probe: async () => ({
        ok: false,
        supportsTools: false,
        models: [],
        error: "401 invalid x-api-key",
      }),
      listModels: async () => {
        throw new Error("401 invalid x-api-key");
      },
      reachable: async () => ({ ok: false, error: "401" }),
    };
    const h = harness({ makeProvider: () => failing });
    await h.agent.start();
    const result = await h.agent.save({
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "m",
      apiKey: "bad",
    });
    expect(result.ok).toBe(false);
    expect(h.files.size).toBe(0);
    await expect(
      h.secrets.get(providerAccount("anthropic", "https://api.anthropic.com")),
    ).resolves.toBeUndefined();
  });

  it("pushes provider:status unreachable when there is no provider and a turn fails", async () => {
    const h = harness();
    await h.agent.start();
    h.agent.prompt("hello");
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    expect(h.events().at(-1)).toMatchObject({ type: "turn-end", reason: "error" });
    expect(h.pushes.filter((p) => p.channel === "provider:status").at(-1)?.payload).toMatchObject({
      reachable: false,
    });
  });

  it("runs the doctor, refuses prompts meanwhile, then hands its summary to the next prompt", async () => {
    const script = parseFakeScript([
      { expectPromptContains: "network doctor ran", replies: [{ text: "Glad it works." }] },
    ]);
    const h = harness({ fakeScript: script });
    await h.agent.start();
    const state = h.agent.doctorStart();
    expect(state.active).toBe(true);
    expect(() => h.agent.prompt("hi")).toThrow(OsAgentError);
    await h.until(() => {
      const last = h.pushes.filter((p) => p.channel === "doctor:state").at(-1)?.payload as
        | DoctorState
        | undefined;
      return last?.done !== null && last?.done !== undefined;
    });
    await h.until(() => {
      try {
        h.agent.prompt("is it working now?");
        return true;
      } catch {
        return false;
      }
    });
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    expect(h.events()).toContainEqual(
      expect.objectContaining({ type: "text", delta: "Glad it works." }),
    );
    expect(h.events().find((e) => e.type === "turn-start")).toMatchObject({
      text: "is it working now?",
    });
  });

  it("resyncs a late shell with provider status, doctor state and open cards", async () => {
    const h = harness({ fakeScript: installScript });
    await h.agent.start();
    h.agent.prompt("please install hello");
    await h.until(() => h.events().some((e) => e.type === "card"));
    await h.until(() => h.pushes.some((p) => p.channel === "sys:snapshot"));
    h.pushes.length = 0;
    h.agent.resync();
    expect(h.pushes.map((p) => p.channel)).toEqual(
      expect.arrayContaining(["provider:status", "doctor:state", "sys:snapshot", "agent:events"]),
    );
    expect(h.events().filter((e) => e.type === "card")).toHaveLength(1);
  });

  it("reconnects the MCP servers after one dies", async () => {
    const h = harness({
      fakeScript: parseFakeScript([{ replies: [{ text: "a" }] }, { replies: [{ text: "b" }] }]),
    });
    await h.agent.start();
    h.agent.prompt("one");
    await h.until(() => h.events().filter((e) => e.type === "turn-end").length === 1);
    const before = h.connects();
    h.alive.value = false;
    await h.until(() => {
      try {
        h.agent.prompt("two");
        return true;
      } catch {
        return false;
      }
    });
    await h.until(() => h.events().filter((e) => e.type === "turn-end").length === 2);
    expect(h.connects()).toBe(before + 1);
  });
});
