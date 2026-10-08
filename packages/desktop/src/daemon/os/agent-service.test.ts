import {
  AGENT_TEXT,
  type AgentEvent,
  type AuditEntry,
  type DoctorState,
  type McpSession,
  type McpTool,
  type MemoryBackend,
  type MemoryRecord,
  type ModelEvent,
  type ModelProvider,
  parseFakeScript,
  ProviderError,
  SAFETY_RULES,
  type SysSnapshot,
  type TextEmbedder,
} from "@jarvis/core";
import { readFileSync } from "node:fs";
import { createMemorySecretStore, providerAccount } from "@jarvis/platform/model";
import { describe, expect, it } from "vitest";
import { createOsAgent, OsAgentError, type OsAgentDeps } from "./agent-service.js";
import type { ConfigIo } from "./provider-config.js";
import type { MemoryOpener } from "./memory-backend.js";
import { EMPTY_REGISTRY, type LoadedRegistry } from "./registry-servers.js";

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

const updatesTools: McpTool[] = [
  {
    name: "updates.list",
    description: "List updates",
    inputSchema: { type: "object", properties: {} },
    meta: { jarvis: { risk: "safe" } },
  },
  {
    name: "updates.apply",
    description: "Apply updates",
    inputSchema: {
      type: "object",
      properties: { items: { type: "array", maxItems: 200 } },
    },
    meta: { jarvis: { risk: "confirm", batch: "items" } },
  },
];
const UPDATES_LIST = {
  items: [
    {
      source: "apt",
      id: "jarvis-shell",
      from: "0.1.0",
      to: "0.2.0",
      security: false,
    },
    {
      source: "apt",
      id: "openssl",
      from: "3.5.1-1",
      to: "3.5.1-1+deb13u1",
      security: true,
    },
  ],
  checkedAt: "2026-10-08T09:00:00Z",
};

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
      if (tool === "updates.list") {
        return { isError: false, structuredContent: UPDATES_LIST, text: "{}" };
      }
      if (tool === "net.status") {
        return {
          isError: false,
          structuredContent: {
            nmRunning: true,
            connectivity: "full",
            devices: [
              {
                name: "eth0",
                type: "ethernet",
                state: "connected",
                connection: "Wired",
              },
            ],
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
            disks: [
              {
                mount: "/",
                sizeBytes: 64_000_000_000,
                usedBytes: 6_000_000_000,
              },
            ],
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
      return {
        isError: false,
        structuredContent: { ok: true },
        text: '{"ok":true}',
      };
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
  const providerKeys = createMemorySecretStore();
  const agent = createOsAgent({
    push: (channel, payload) => pushes.push({ channel, payload }),
    configPath: "/home/jarvis/.config/jarvis/jarvis.yaml",
    configIo,
    secrets,
    providerKeys,
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
    readModelState: async () => null,
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
    providerKeys,
    connects: () => connects,
    alive,
  };
}

const installScript = parseFakeScript([
  {
    expectPromptContains: "install hello",
    replies: [
      {
        toolCalls: [
          {
            name: "pkg.install",
            input: { items: [{ source: "apt", id: "hello" }] },
          },
        ],
      },
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
    h.agent.confirm({
      cardId: card.card.cardId,
      approve: true,
      ticked: ["item-1"],
      secrets: {},
    });
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    expect(h.events().at(-1)).toEqual({
      type: "turn-end",
      turnId,
      reason: "done",
    });
    expect(h.events()).toContainEqual({
      type: "text",
      turnId,
      delta: "Installed hello.",
    });
    expect(h.toolCalls.filter((t) => t === "pkg.install")).toEqual(["pkg.install"]);
    expect(h.audit[0]).toMatchObject({
      tool: "pkg.install",
      decision: "approved",
      result: "ok",
      via: "desktop",
    });
    // The fake provider works with no provider configured (contracts §6 #11).
    await expect(h.agent.providerList()).resolves.toMatchObject({
      providers: [],
      activeId: null,
    });
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
      disk: {
        mount: "/",
        sizeBytes: 64_000_000_000,
        usedBytes: 6_000_000_000,
      },
      failedUnits: ["cups.service"],
      model: {
        kind: "ollama",
        model: "qwen3:8b",
        local: true,
        supportsTools: true,
        download: null,
      },
      updates: { count: 0, security: 0, checkedAt: null },
      locked: false,
      voice: { available: false, stt: null, tts: null, speak: false },
      undo: { available: false, title: null },
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
      h.agent.confirm({
        cardId: "nope",
        approve: true,
        ticked: [],
        secrets: {},
      }),
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
    expect(h.events().at(-1)).toEqual({
      type: "turn-end",
      turnId,
      reason: "stopped",
    });
    expect(h.toolCalls.filter((t) => t === "pkg.install")).toEqual([]);
  });

  it("pushes provider:status unreachable when there is no provider and a turn fails", async () => {
    const h = harness();
    await h.agent.start();
    h.agent.prompt("hello");
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    expect(h.events().at(-1)).toMatchObject({
      type: "turn-end",
      reason: "error",
    });
    expect(h.pushes.filter((p) => p.channel === "provider:status").at(-1)?.payload).toMatchObject({
      reachable: false,
    });
  });

  it("runs the doctor, refuses prompts meanwhile, then hands its summary to the next prompt", async () => {
    const script = parseFakeScript([
      {
        expectPromptContains: "network doctor ran",
        replies: [{ text: "Glad it works." }],
      },
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

describe("updates and model download (M2 contracts §2, §5)", () => {
  const withUpdates = (calls: string[]) => async () => [
    session("jarvis-pkg", [...pkgTools, ...updatesTools], calls),
    session("jarvis-diag", diagTools, calls),
  ];
  const snapshots = (pushes: { channel: string; payload: unknown }[]) =>
    pushes.filter((p) => p.channel === "sys:snapshot").map((p) => p.payload as SysSnapshot);

  it("answers updates:check from updates.list and pushes the counts in sys:snapshot", async () => {
    const calls: string[] = [];
    const h = harness({ connectMcp: withUpdates(calls) });
    await h.agent.start();
    await h.until(() => snapshots(h.pushes).length > 0);
    await expect(h.agent.checkUpdates()).resolves.toEqual({
      count: 2,
      security: 1,
    });
    await h.until(() => snapshots(h.pushes).some((s) => s.updates.count === 2));
    expect(snapshots(h.pushes).at(-1)?.updates).toEqual({
      count: 2,
      security: 1,
      checkedAt: Date.parse("2026-10-08T09:00:00Z"),
    });
  });

  it("says unsupported when jarvis-pkg has no updates.list (an M1 system)", async () => {
    const h = harness();
    await h.agent.start();
    await expect(h.agent.checkUpdates()).rejects.toMatchObject({
      name: "OsAgentError",
      code: "unsupported",
      message: AGENT_TEXT.updatesUnavailable,
    });
  });

  it("passes apt's refusal on as internal with its message", async () => {
    const failing: McpSession = {
      ...session("jarvis-pkg", [...pkgTools, ...updatesTools], []),
      callTool: async () => ({
        isError: true,
        structuredContent: {
          code: "failed",
          message: "The repository is not signed.",
        },
        text: "failed",
      }),
    };
    const h = harness({ connectMcp: async () => [failing] });
    await h.agent.start();
    await expect(h.agent.checkUpdates()).rejects.toMatchObject({
      code: "internal",
      message: AGENT_TEXT.updatesCheckFailed("The repository is not signed."),
    });
  });

  it("re-checks updates after updates.apply ran from a card", async () => {
    const calls: string[] = [];
    const script = parseFakeScript([
      {
        expectPromptContains: "update my computer",
        replies: [
          {
            toolCalls: [
              {
                name: "updates.apply",
                input: { items: [{ source: "apt", id: "openssl" }] },
              },
            ],
          },
          { text: "Updated." },
        ],
      },
    ]);
    const h = harness({ fakeScript: script, connectMcp: withUpdates(calls) });
    await h.agent.start();
    h.agent.prompt("update my computer");
    await h.until(() => h.events().some((e) => e.type === "card"));
    const card = h.events().find((e) => e.type === "card");
    if (card?.type !== "card") throw new Error("no card");
    h.agent.confirm({
      cardId: card.card.cardId,
      approve: true,
      ticked: card.card.items.map((item) => item.itemId),
      secrets: {},
    });
    await h.until(
      () =>
        calls.includes("updates.apply") &&
        calls.lastIndexOf("updates.list") > calls.indexOf("updates.apply"),
    );
  });

  it("reports the local model download in sys:snapshot.model", async () => {
    const h = harness({
      fakeScript: installScript,
      readModelState: async () => ({
        modelId: "qwen3-8b",
        ollamaTag: "qwen3:8b",
        state: "downloading",
        percent: 42,
        message: "",
        updatedAt: "2026-10-08T09:00:00Z",
      }),
    });
    h.files.set(
      "/home/jarvis/.config/jarvis/jarvis.yaml",
      "provider:\n  kind: ollama\n  baseUrl: http://127.0.0.1:11434\n  model: qwen3:8b\n",
    );
    await h.agent.start();
    await h.until(() => snapshots(h.pushes).length > 0);
    expect(snapshots(h.pushes)[0]?.model).toEqual({
      kind: "ollama",
      model: "qwen3:8b",
      local: true,
      supportsTools: true,
      download: { state: "downloading", percent: 42 },
    });
  });
});

const KINDS = ["anthropic", "openai-compatible", "ollama", "gemini"];
const YAML = "/home/jarvis/.config/jarvis/jarvis.yaml";

function okProvider(models: string[] = ["m"]): ModelProvider {
  return {
    async *chat() {
      yield { type: "text", delta: "hi" };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    },
    probe: async () => ({ ok: true, supportsTools: true, models }),
    listModels: async () => models,
    reachable: async () => ({ ok: true }),
  };
}

describe("provider list and failover (M2.5 contracts §1-§2, design §3.5)", () => {
  it("lists nothing, saves an ordered list with keys by id, lists it", async () => {
    const built: { baseUrl: string; key: string | undefined }[] = [];
    const h = harness({
      makeProvider: (section, key) => {
        built.push({ baseUrl: section.baseUrl, key });
        return okProvider();
      },
    });
    await h.agent.start();
    await expect(h.agent.providerList()).resolves.toEqual({
      providers: [],
      activeId: null,
      allowCloudFallback: false,
      kinds: KINDS,
    });
    const result = await h.agent.save({
      providers: [
        {
          id: "local",
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "qwen3:8b",
        },
        {
          id: "work",
          kind: "anthropic",
          baseUrl: "https://api.anthropic.com",
          model: "claude-sonnet-5-5",
          apiKey: "sk-ant-123",
        },
      ],
      allowCloudFallback: true,
    });
    expect(result).toEqual({
      ok: true,
      results: {
        local: { ok: true, supportsTools: true, models: ["m"] },
        work: { ok: true, supportsTools: true, models: ["m"] },
      },
    });
    await expect(h.providerKeys.get("work")).resolves.toBe("sk-ant-123");
    const yaml = h.files.get(YAML) ?? "";
    expect(yaml).toContain("providers:");
    expect(yaml).not.toContain("sk-ant-123");
    await expect(h.agent.providerList()).resolves.toEqual({
      providers: [
        {
          id: "local",
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "qwen3:8b",
          hasKey: false,
        },
        {
          id: "work",
          kind: "anthropic",
          baseUrl: "https://api.anthropic.com",
          model: "claude-sonnet-5-5",
          hasKey: true,
        },
      ],
      activeId: "local",
      allowCloudFallback: true,
      kinds: KINDS,
    });
  });

  it("keeps an M2 machine working: legacy provider + key show up as `default`", async () => {
    const h = harness({
      secrets: createMemorySecretStore({
        [providerAccount("anthropic", "https://api.anthropic.com")]: "sk-old",
      }),
      makeProvider: () => okProvider(),
    });
    h.files.set(
      YAML,
      "provider:\n  kind: anthropic\n  baseUrl: https://api.anthropic.com\n  model: claude-sonnet-5-5\n",
    );
    await h.agent.start();
    await expect(h.agent.providerList()).resolves.toMatchObject({
      providers: [{ id: "default", kind: "anthropic", hasKey: true }],
      activeId: "default",
    });
    await expect(h.providerKeys.get("default")).resolves.toBe("sk-old");
    // Saving the same entry without a key keeps it and writes the new layout.
    const saved = await h.agent.save({
      providers: [
        {
          id: "default",
          kind: "anthropic",
          baseUrl: "https://api.anthropic.com",
          model: "claude-haiku-5",
        },
      ],
      allowCloudFallback: false,
    });
    expect(saved.ok).toBe(true);
    expect(h.files.get(YAML)).not.toMatch(/^provider:/m);
    await expect(h.providerKeys.get("default")).resolves.toBe("sk-old");
  });

  it("saves nothing when one probe fails, and says which", async () => {
    const h = harness({
      makeProvider: (section) =>
        section.baseUrl.includes("10.0.0.9")
          ? {
              ...okProvider(),
              probe: async () => ({
                ok: false,
                supportsTools: false,
                models: [],
                error: "Cannot reach 10.0.0.9",
              }),
            }
          : okProvider(),
    });
    await h.agent.start();
    const result = await h.agent.save({
      providers: [
        {
          id: "local",
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "m",
        },
        {
          id: "lan",
          kind: "ollama",
          baseUrl: "http://10.0.0.9:11434",
          model: "m",
        },
      ],
      allowCloudFallback: false,
    });
    expect(result.ok).toBe(false);
    expect(result.results["lan"]?.error).toBe("Cannot reach 10.0.0.9");
    expect(h.files.size).toBe(0);
  });

  it("removes the keys of providers dropped from the list", async () => {
    const h = harness({ makeProvider: () => okProvider() });
    await h.agent.start();
    const work = {
      id: "work",
      kind: "anthropic" as const,
      baseUrl: "https://api.anthropic.com",
      model: "m",
      apiKey: "sk-1",
    };
    await h.agent.save({ providers: [work], allowCloudFallback: false });
    await h.agent.save({
      providers: [
        {
          id: "local",
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "m",
        },
      ],
      allowCloudFallback: false,
    });
    await expect(h.providerKeys.get("work")).resolves.toBeUndefined();
  });

  it("drops the stored key when a keyless save changes kind or base URL", async () => {
    const h = harness({ makeProvider: () => okProvider() });
    await h.agent.start();
    await h.agent.save({
      providers: [
        {
          id: "work",
          kind: "anthropic",
          baseUrl: "https://api.anthropic.com",
          model: "m",
          apiKey: "sk-1",
        },
      ],
      allowCloudFallback: false,
    });
    const saved = await h.agent.save({
      providers: [
        {
          id: "work",
          kind: "openai-compatible",
          baseUrl: "http://10.0.0.5:8000",
          model: "m",
        },
      ],
      allowCloudFallback: false,
    });
    expect(saved.ok).toBe(true);
    await expect(h.providerKeys.get("work")).resolves.toBeUndefined();
  });

  it("probes only new or changed providers on save", async () => {
    const probed: string[] = [];
    const h = harness({
      makeProvider: (section) => ({
        ...okProvider(),
        probe: async () => {
          probed.push(section.baseUrl);
          return { ok: true, supportsTools: true, models: ["m"] };
        },
      }),
    });
    await h.agent.start();
    const local = {
      id: "local",
      kind: "ollama" as const,
      baseUrl: "http://127.0.0.1:11434",
      model: "m",
    };
    const lan = {
      id: "lan",
      kind: "ollama" as const,
      baseUrl: "http://10.0.0.9:11434",
      model: "m",
    };
    await h.agent.save({ providers: [local, lan], allowCloudFallback: false });
    probed.length = 0;
    const result = await h.agent.save({
      providers: [lan, local],
      allowCloudFallback: true,
    });
    expect(result.ok).toBe(true);
    expect(probed).toEqual([]);
    await h.agent.save({
      providers: [lan, { ...local, model: "m2" }],
      allowCloudFallback: true,
    });
    expect(probed).toEqual(["http://127.0.0.1:11434"]);
  });

  it("reuses a stored key only for the same kind and base URL", async () => {
    // Only probes use model "p", so the failover provider's own builds are not recorded.
    const keys: (string | undefined)[] = [];
    const h = harness({
      makeProvider: (section, key) => {
        if (section.model === "p") keys.push(key);
        return okProvider();
      },
    });
    await h.agent.start();
    await h.agent.save({
      providers: [
        {
          id: "work",
          kind: "anthropic",
          baseUrl: "https://api.anthropic.com",
          model: "m",
          apiKey: "sk-1",
        },
      ],
      allowCloudFallback: false,
    });
    await h.agent.probe({
      id: "work",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "p",
    });
    await h.agent.probe({
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "p",
    });
    await h.agent.probe({
      id: "work",
      kind: "anthropic",
      baseUrl: "https://evil.example",
      model: "p",
    });
    await h.agent.probe({
      id: "other",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "p",
    });
    expect(keys).toEqual(["sk-1", "sk-1", undefined, undefined]);
  });

  it("completes a turn on the LAN provider when the cloud returns 503, and pushes why", async () => {
    const h = harness({
      makeProvider: (section) =>
        section.baseUrl.startsWith("https://")
          ? {
              ...okProvider(),
              // biome-ignore lint/correctness/useYield: it fails before it yields anything.
              async *chat() {
                throw new ProviderError("http", "503 unavailable", 503);
              },
            }
          : okProvider(),
    });
    h.files.set(
      YAML,
      [
        "os:",
        "  providers:",
        "    - { id: cloud, kind: openai-compatible, baseUrl: https://api.example.com, model: m }",
        "    - { id: lan, kind: ollama, baseUrl: http://10.0.0.2:11434, model: m }",
        "",
      ].join("\n"),
    );
    await h.agent.start();
    const { turnId } = h.agent.prompt("hello");
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    expect(h.events()).toContainEqual({ type: "text", turnId, delta: "hi" });
    const statuses = h.pushes.filter((p) => p.channel === "provider:status").map((p) => p.payload);
    expect(statuses).toContainEqual({
      reachable: true,
      activeId: "lan",
      fallbackReason: "cloud returned an error (503)",
    });
  });

  it("keeps a local user's turn off the cloud without the opt-in", async () => {
    let cloudCalls = 0;
    const h = harness({
      makeProvider: (section) =>
        section.kind === "anthropic"
          ? {
              ...okProvider(),
              async *chat() {
                cloudCalls++;
                yield {
                  type: "done",
                  usage: { inputTokens: 0, outputTokens: 0 },
                } as ModelEvent;
              },
            }
          : {
              ...okProvider(),
              // biome-ignore lint/correctness/useYield: it fails before it yields anything.
              async *chat() {
                throw new ProviderError("network", "Cannot reach 127.0.0.1");
              },
            },
    });
    await h.providerKeys.set("work", "sk-1");
    h.files.set(
      YAML,
      [
        "os:",
        "  providers:",
        "    - { id: local, kind: ollama, baseUrl: http://127.0.0.1:11434, model: m }",
        "    - { id: work, kind: anthropic, baseUrl: https://api.anthropic.com, model: m }",
        "",
      ].join("\n"),
    );
    await h.agent.start();
    h.agent.prompt("hello");
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    expect(h.events().at(-1)).toMatchObject({
      type: "turn-end",
      reason: "error",
    });
    expect(cloudCalls).toBe(0);
  });

  it("refuses an empty model on save", async () => {
    const h = harness({ makeProvider: () => okProvider() });
    await h.agent.start();
    await expect(
      h.agent.save({
        providers: [
          {
            id: "lan",
            kind: "ollama",
            baseUrl: "http://10.0.0.2:11434",
            model: "",
          },
        ],
        allowCloudFallback: false,
      }),
    ).rejects.toBeInstanceOf(OsAgentError);
  });
});

describe("registry servers in jarvisd (contracts §3, §7)", () => {
  const addOnTools = {
    "jarvis-files": [
      {
        name: "files.search",
        description: "Search files",
        inputSchema: { type: "object", properties: {} },
        meta: { jarvis: { risk: "safe" } },
      },
    ],
    weather: [
      {
        name: "weather.now",
        description: "Weather now",
        inputSchema: { type: "object", properties: {} },
        meta: { jarvis: { risk: "safe" } },
      },
    ],
  } satisfies Record<string, McpTool[]>;

  function loaded(calls: string[]): LoadedRegistry {
    return {
      sessions: [
        session("jarvis-files", addOnTools["jarvis-files"], calls),
        session("weather", addOnTools.weather, calls),
      ],
      tiers: new Map([
        ["jarvis-files", "official"],
        ["weather", "community"],
      ]),
      installed: [],
      sandbox: "ok",
    };
  }

  it("runs an official add-on's safe tool directly and puts a community 'safe' tool on a card", async () => {
    const calls: string[] = [];
    const script = parseFakeScript([
      {
        expectPromptContains: "find",
        replies: [
          {
            toolCalls: [
              { name: "files.search", input: {} },
              { name: "weather.now", input: {} },
            ],
          },
          { text: "done" },
        ],
      },
    ]);
    const h = harness({
      fakeScript: script,
      registryServers: { load: async () => loaded(calls) },
    });
    await h.agent.start();
    h.agent.prompt("find my notes");
    await h.until(() => h.events().some((e) => e.type === "card"));
    expect(calls).toContain("files.search");
    expect(calls).not.toContain("weather.now");
    const card = h.events().find((e) => e.type === "card");
    expect(card?.type === "card" && card.card.items.map((i) => i.tool)).toEqual(["weather.now"]);
  });

  it("reloads add-ons before the next turn after mcp.d changes", async () => {
    let loads = 0;
    let changed: () => void = () => {};
    const h = harness({
      fakeScript: parseFakeScript([{ replies: [{ text: "a" }] }, { replies: [{ text: "b" }] }]),
      registryServers: {
        load: async () => {
          loads++;
          return loaded([]);
        },
      },
      watchRegistry: (onChange) => {
        changed = onChange;
        return () => {};
      },
    });
    await h.agent.start();
    h.agent.prompt("one");
    await h.until(() => h.events().filter((e) => e.type === "turn-end").length === 1);
    const before = loads;
    changed();
    h.agent.prompt("two");
    await h.until(() => h.events().filter((e) => e.type === "turn-end").length === 2);
    expect(loads).toBe(before + 1);
  });

  it("lists installed add-ons joined with the registry index (registry.list)", async () => {
    const entry = {
      id: "jarvis-files",
      name: "Files",
      description: "Search and preview files",
      tier: "official",
      version: "1.0.0",
      artifact: {
        url: "https://x/f.tar.gz",
        sha256: "a".repeat(64),
        runtime: "go-static",
      },
      permissions: { network: false, paths: [] },
      tools: [{ name: "files.search", risk: "safe" }],
    };
    const pkgWithRegistry = session(
      "jarvis-pkg",
      [
        ...pkgTools,
        {
          name: "registry.list",
          description: "List the registry",
          inputSchema: { type: "object", properties: {} },
          meta: { jarvis: { risk: "safe", hidden: true } },
        },
      ],
      [],
    );
    pkgWithRegistry.callTool = async (tool) =>
      tool === "registry.list"
        ? {
            isError: false,
            structuredContent: { installed: [], available: [entry] },
            text: "{}",
          }
        : { isError: false, structuredContent: {}, text: "{}" };
    const h = harness({
      connectMcp: async () => [pkgWithRegistry],
      registryServers: {
        load: async () => ({
          ...EMPTY_REGISTRY,
          installed: [
            {
              id: "jarvis-files",
              version: "1.0.0",
              tier: "official",
              runtime: "go-static",
              command: ["/home/jarvis/.local/share/jarvis/mcp/jarvis-files/1.0.0/server"],
              permissions: { network: false, paths: [] },
              writablePaths: [],
              tools: [],
            },
            {
              id: "old",
              version: "0.1",
              tier: "community",
              runtime: "node",
              command: [],
              permissions: { network: true, paths: ["~/Old"] },
              writablePaths: [],
              tools: [],
            },
          ],
        }),
      },
    });
    await h.agent.start();
    const listed = await h.agent.registryList();
    expect(listed.available).toEqual([entry]);
    expect(listed.installed[0]).toEqual(entry);
    expect(listed.installed[1]).toMatchObject({
      id: "old",
      name: "old",
      tier: "community",
      artifact: { runtime: "node" },
      permissions: { network: true, paths: ["~/Old"] },
      tools: [],
    });
  });
});

describe("registry:list against jarvis-pkg's real output (contracts §7 #8)", () => {
  it("fills available and installed from the Go registry.list golden", async () => {
    const golden: unknown = JSON.parse(
      readFileSync(
        new URL(
          "../../../../../os/go/internal/pkgtools/testdata/registry-list.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const pkg = session(
      "jarvis-pkg",
      [
        {
          name: "registry.list",
          description: "List the registry",
          inputSchema: { type: "object", properties: {} },
          meta: { jarvis: { risk: "safe", hidden: true } },
        },
      ],
      [],
    );
    pkg.callTool = async () => ({ isError: false, structuredContent: golden, text: "{}" });
    const h = harness({
      connectMcp: async () => [pkg],
      registryServers: {
        load: async () => ({
          ...EMPTY_REGISTRY,
          installed: [
            {
              id: "old-py",
              version: "0.1",
              tier: "community",
              runtime: "python",
              command: [],
              permissions: { network: true, paths: ["~/Old"] },
              writablePaths: [],
              tools: [],
            },
          ],
        }),
      },
    });
    await h.agent.start();
    const listed = await h.agent.registryList();
    expect(listed.available.map((e) => e.id)).toEqual(["weather", "jarvis-clock"]);
    expect(listed.installed.map((e) => [e.id, e.name])).toEqual([
      ["old-py", "old-py"],
      ["notes", "Notes"],
    ]);
  });
});

describe("read-only tool profile (contracts §7 #14)", () => {
  it("offers and runs only safe tools: no card, no confirm tool reaches the model", async () => {
    const requests: string[][] = [];
    const provider: ModelProvider = {
      async *chat(request) {
        requests.push(request.tools.map((t) => t.name));
        yield { type: "text", delta: "ok" };
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      },
      probe: async () => ({ ok: true, supportsTools: true, models: [] }),
      listModels: async () => [],
      reachable: async () => ({ ok: true }),
    };
    const h = harness({ toolProfile: "readonly", makeProvider: () => provider });
    h.files.set(
      YAML,
      "os:\n  providers:\n    - { id: local, kind: ollama, baseUrl: http://127.0.0.1:11434, model: m }\n",
    );
    await h.agent.start();
    h.agent.prompt("install hello");
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    expect(requests[0]).toContain("net_status");
    expect(requests[0]).not.toContain("pkg_install");

    const fake = harness({ toolProfile: "readonly", fakeScript: installScript });
    await fake.agent.start();
    fake.agent.prompt("please install hello");
    await fake.until(() => fake.events().some((e) => e.type === "turn-end"));
    expect(fake.events().some((e) => e.type === "card")).toBe(false);
    expect(fake.toolCalls).not.toContain("pkg.install");
  });
});

function memoryOpener(): MemoryOpener & { rows: MemoryRecord[] } {
  const rows: MemoryRecord[] = [];
  let next = 0;
  const backend: MemoryBackend = {
    add: async (memory) => {
      const id = `mem${++next}`;
      rows.push({ id, ...memory });
      return id;
    },
    list: async (limit) => [...rows].reverse().slice(0, limit),
    all: async () => [...rows],
    delete: async (id) => {
      const index = rows.findIndex((r) => r.id === id);
      if (index >= 0) rows.splice(index, 1);
      return index >= 0;
    },
    clear: async () => {
      rows.length = 0;
    },
  };
  return { rows, open: async () => backend, reset: async () => {}, close: () => {} };
}

describe("memory and tool search in jarvisd (design §3.8, §3.9)", () => {
  function recording(requests: { system: string; tools: string[] }[]): ModelProvider {
    return {
      async *chat(request) {
        requests.push({ system: request.system, tools: request.tools.map((t) => t.name) });
        yield { type: "text", delta: '{"summary": "talked", "facts": []}' };
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      },
      probe: async () => ({ ok: true, supportsTools: true, models: [] }),
      listModels: async () => [],
      reachable: async () => ({ ok: true }),
    };
  }
  const LOCAL_YAML =
    "os:\n  providers:\n    - { id: local, kind: ollama, baseUrl: http://127.0.0.1:11434, model: m }\n";

  it("recalls a remembered action into the next request, before the rules", async () => {
    const requests: { system: string; tools: string[] }[] = [];
    const memory = memoryOpener();
    memory.rows.push({
      id: "f1",
      kind: "fact",
      text: "Install Firefox (pkg.install), approved on 2026-10-06.",
      createdAt: Date.now() - 86_400_000,
      embedding: null,
      embeddingModel: null,
    });
    const h = harness({ makeProvider: () => recording(requests), memory, now: Date.now });
    h.files.set(YAML, LOCAL_YAML);
    await h.agent.start();
    h.agent.prompt("what did I install last week?");
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    const system = requests[0]?.system ?? "";
    expect(system).toContain("Install Firefox");
    expect(system.indexOf("<memory-notes>")).toBeLessThan(system.indexOf(SAFETY_RULES));
    expect(system.endsWith(SAFETY_RULES)).toBe(true);
  });

  it("lists, deletes and forgets memories through the agent", async () => {
    const memory = memoryOpener();
    const h = harness({ memory, makeProvider: () => recording([]) });
    h.files.set(YAML, LOCAL_YAML);
    await h.agent.start();
    memory.rows.push(
      { id: "a", kind: "fact", text: "one", createdAt: 1, embedding: null, embeddingModel: null },
      {
        id: "b",
        kind: "summary",
        text: "two",
        createdAt: 2,
        embedding: null,
        embeddingModel: null,
      },
    );
    await expect(h.agent.memoryList(10)).resolves.toEqual([
      { id: "b", kind: "summary", text: "two", createdAt: 2 },
      { id: "a", kind: "fact", text: "one", createdAt: 1 },
    ]);
    await expect(h.agent.memoryDelete("a")).resolves.toBeNull();
    await expect(h.agent.memoryClear()).resolves.toBeNull();
    expect(memory.rows).toEqual([]);
  });

  it("turns memory off and on (contracts §7 #9): off persists, lists as unsupported", async () => {
    const memory = memoryOpener();
    const h = harness({ memory, makeProvider: () => recording([]) });
    h.files.set(YAML, LOCAL_YAML);
    await h.agent.start();
    await expect(h.agent.memorySetEnabled(false)).resolves.toBeNull();
    expect(h.files.get(YAML)).toContain("enabled: false");
    await expect(h.agent.memoryList(10)).rejects.toMatchObject({
      code: "unsupported",
      message: "Memory is off",
    });
    await expect(h.agent.memorySetEnabled(true)).resolves.toBeNull();
    await expect(h.agent.memoryList(10)).resolves.toEqual([]);
  });

  it("never opens the store for delete/clear while memory is off, and lists unsupported without a keyring", async () => {
    const memory = memoryOpener();
    let opens = 0;
    let resets = 0;
    const counted = {
      ...memory,
      open: async () => {
        opens++;
        return memory.open();
      },
      reset: async () => {
        resets++;
      },
    };
    const h = harness({ memory: counted, makeProvider: () => recording([]) });
    h.files.set(YAML, LOCAL_YAML);
    await h.agent.start();
    await h.agent.memorySetEnabled(false);
    await expect(h.agent.memoryDelete("x")).resolves.toBeNull();
    await expect(h.agent.memoryClear()).resolves.toBeNull();
    expect(opens).toBe(0);
    expect(resets).toBe(1);

    const noKey = harness({
      memory: { ...memory, open: async () => null },
      makeProvider: () => recording([]),
    });
    noKey.files.set(YAML, LOCAL_YAML);
    await noKey.agent.start();
    await expect(noKey.agent.memoryList(10)).rejects.toMatchObject({
      code: "unsupported",
      message: "Memory is off",
    });
  });

  it("writes a summary at shutdown with a request that also ends with the rules", async () => {
    const requests: { system: string; tools: string[] }[] = [];
    const memory = memoryOpener();
    const h = harness({ makeProvider: () => recording(requests), memory });
    h.files.set(YAML, LOCAL_YAML);
    await h.agent.start();
    h.agent.prompt("hello");
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    await h.agent.shutdown();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.system.endsWith(SAFETY_RULES)).toBe(true);
    expect(memory.rows.map((r) => r.text)).toEqual(["talked"]);
  });

  it("never gives memory text to the cached tool-search embedder (design §3.9)", async () => {
    const toolTexts: string[] = [];
    const memoryTexts: string[] = [];
    const recorder = (into: string[]): TextEmbedder => ({
      model: "m",
      embed: async (texts) => {
        into.push(...texts);
        return texts.map(() => new Float32Array([1, 0]));
      },
    });
    const memory = memoryOpener();
    const h = harness({
      makeProvider: () => recording([]),
      memory,
      embedder: recorder(toolTexts),
      memoryEmbedder: recorder(memoryTexts),
    });
    h.files.set(YAML, LOCAL_YAML);
    await h.agent.start();
    h.agent.prompt("remember my bank pin hint");
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    await h.agent.shutdown();
    expect(memory.rows.map((r) => r.text)).toEqual(["talked"]);
    expect(memoryTexts).toContain("talked");
    expect(toolTexts).not.toContain("talked");

    // Without a memory embedder, memory never borrows the tool one.
    const shared: string[] = [];
    const noMemoryEmbedder = harness({
      makeProvider: () => recording([]),
      memory: memoryOpener(),
      embedder: recorder(shared),
    });
    noMemoryEmbedder.files.set(YAML, LOCAL_YAML);
    await noMemoryEmbedder.agent.start();
    noMemoryEmbedder.agent.prompt("hello");
    await noMemoryEmbedder.until(() =>
      noMemoryEmbedder.events().some((e) => e.type === "turn-end"),
    );
    await noMemoryEmbedder.agent.shutdown();
    expect(shared).not.toContain("talked");
  });

  it("keeps memory off under the fake provider", async () => {
    const memory = memoryOpener();
    const fake = harness({ fakeScript: installScript, memory });
    await fake.agent.start();
    fake.agent.prompt("please install hello");
    await fake.until(() => fake.events().some((e) => e.type === "card"));
    await fake.agent.shutdown();
    expect(memory.rows).toEqual([]);
  });

  it("offers at most 24 tools a turn once more than 40 are registered", async () => {
    const requests: { system: string; tools: string[] }[] = [];
    const many: McpTool[] = Array.from({ length: 45 }, (_, i) => ({
      name: `extra.tool_${i}`,
      description: `extra thing ${i}`,
      inputSchema: { type: "object", properties: {} },
      meta: { jarvis: { risk: "safe" } },
    }));
    const h = harness({
      makeProvider: () => recording(requests),
      registryServers: {
        load: async () => ({
          sessions: [session("extras", many, [])],
          tiers: new Map([["extras", "reviewed"]]),
          installed: [],
          sandbox: "ok",
        }),
      },
    });
    h.files.set(YAML, LOCAL_YAML);
    await h.agent.start();
    h.agent.prompt("extra thing 7");
    await h.until(() => h.events().some((e) => e.type === "turn-end"));
    expect(requests[0]?.tools.length).toBeLessThanOrEqual(24);
    expect(requests[0]?.tools).toContain("net_status");
    expect(requests[0]?.tools).toContain("extra_tool_7");
  });
});

describe("apps.open_path with a URL goes through a card (M3 §1)", () => {
  const appsTools: McpTool[] = [
    {
      name: "apps.open_path",
      description: "Open a file or URL",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      meta: { jarvis: { risk: "safe" } },
    },
  ];
  it("opens a home file at once but asks before opening a URL", async () => {
    const calls: string[] = [];
    const h = harness({
      fakeScript: parseFakeScript([
        {
          replies: [
            { toolCalls: [{ name: "apps.open_path", input: { path: "/home/jarvis/a.pdf" } }] },
            { toolCalls: [{ name: "apps.open_path", input: { path: "https://example.com" } }] },
            { text: "done" },
          ],
        },
      ]),
      connectMcp: async () => [session("jarvis-apps", appsTools, calls)],
    });
    await h.agent.start();
    h.agent.prompt("open things");
    await h.until(() => h.events().some((e) => e.type === "card"));
    expect(calls).toEqual(["apps.open_path"]);
    const card = h.events().find((e) => e.type === "card");
    expect(card?.type === "card" ? card.card.items[0]?.tool : undefined).toBe("apps.open_path");
  });
});
