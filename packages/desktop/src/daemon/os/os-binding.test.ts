import { describe, expect, it } from "vitest";
import { ControlRequestError } from "../control/messages.js";
import type { ControlConnection } from "../control/server.js";
import { type OsAgent, OsAgentError } from "./agent-service.js";
import {
  createOsBinding,
  createOsRouter,
  confirmFrom,
  phoneDeviceName,
  phoneVia,
  PHONE_REQUESTS,
  requireLocal,
} from "./os-binding.js";

const connection: ControlConnection = { id: 1, onClose: () => {} };

function fakeAgent() {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };
  const idle = { active: false, steps: [], networks: [], done: null };
  const agent: OsAgent = {
    start: async () => {},
    prompt: record("prompt", { turnId: "t1" }) as OsAgent["prompt"],
    stop: record("stop", null) as OsAgent["stop"],
    confirm: record("confirm", null) as OsAgent["confirm"],
    providerList: record(
      "providerList",
      Promise.resolve({ providers: [], activeId: null, allowCloudFallback: false, kinds: [] }),
    ) as OsAgent["providerList"],
    probe: record(
      "probe",
      Promise.resolve({ ok: true, supportsTools: true, models: [] }),
    ) as OsAgent["probe"],
    save: record("save", Promise.resolve({ ok: true, results: {} })) as OsAgent["save"],
    doctorStart: record("doctorStart", idle) as OsAgent["doctorStart"],
    doctorSkip: record("doctorSkip", idle) as OsAgent["doctorSkip"],
    auditList: record("auditList", Promise.resolve([])) as OsAgent["auditList"],
    registryList: record(
      "registryList",
      Promise.resolve({ installed: [], available: [] }),
    ) as OsAgent["registryList"],
    memoryList: record("memoryList", Promise.resolve([])) as OsAgent["memoryList"],
    memoryDelete: record("memoryDelete", Promise.resolve(null)) as OsAgent["memoryDelete"],
    memoryClear: record("memoryClear", Promise.resolve(null)) as OsAgent["memoryClear"],
    memorySetEnabled: record(
      "memorySetEnabled",
      Promise.resolve(null),
    ) as OsAgent["memorySetEnabled"],
    checkUpdates: record(
      "checkUpdates",
      Promise.resolve({ count: 2, security: 1 }),
    ) as OsAgent["checkUpdates"],
    resync: () => {},
    shutdown: async () => {},
  };
  return { agent, calls };
}

describe("createOsBinding", () => {
  it("routes each contract channel with parsed arguments", async () => {
    const { agent, calls } = fakeAgent();
    const handlers = createOsBinding(createOsRouter({ agent }), {
      requestStop: () => {},
      defer: (cb) => cb(),
    });
    await expect(
      handlers.invoke("agent:prompt", [{ text: "install vlc", extra: 1 }], connection),
    ).resolves.toEqual({ turnId: "t1" });
    await handlers.invoke("agent:stop", [{ turnId: "t1" }], connection);
    await handlers.invoke(
      "agent:confirm",
      [{ cardId: "c1", approve: false, ticked: [], secrets: {} }],
      connection,
    );
    await handlers.invoke("provider:list", [], connection);
    await handlers.invoke(
      "provider:probe",
      [{ kind: "ollama", baseUrl: "http://localhost:11434", model: "qwen3:8b" }],
      connection,
    );
    await handlers.invoke(
      "provider:save",
      [
        {
          providers: [
            { id: "local", kind: "ollama", baseUrl: "http://localhost:11434", model: "qwen3:8b" },
          ],
          allowCloudFallback: false,
        },
      ],
      connection,
    );
    await handlers.invoke("doctor:start", [], connection);
    await handlers.invoke("doctor:skip", [{ stepId: "wifi" }], connection);
    await handlers.invoke("audit:list", [{ limit: 20 }], connection);
    await handlers.invoke("registry:list", [], connection);
    await handlers.invoke("memory:list", [{ limit: 50 }], connection);
    await handlers.invoke("memory:delete", [{ id: "m1" }], connection);
    await handlers.invoke("memory:clear", [], connection);
    await handlers.invoke("memory:setEnabled", [{ enabled: false }], connection);
    await expect(handlers.invoke("updates:check", [], connection)).resolves.toEqual({
      count: 2,
      security: 1,
    });
    expect(calls.map((c) => c.method)).toEqual([
      "prompt",
      "stop",
      "confirm",
      "providerList",
      "probe",
      "save",
      "doctorStart",
      "doctorSkip",
      "auditList",
      "registryList",
      "memoryList",
      "memoryDelete",
      "memoryClear",
      "memorySetEnabled",
      "checkUpdates",
    ]);
    expect(calls[0]?.args).toEqual(["install vlc"]);
    expect(calls.find((c) => c.method === "memoryList")?.args).toEqual([50]);
    expect(calls.find((c) => c.method === "memoryDelete")?.args).toEqual(["m1"]);
    expect(calls.find((c) => c.method === "memorySetEnabled")?.args).toEqual([false]);
  });

  it("answers bad arguments with bad-request and unknown channels with unknown-channel", async () => {
    const { agent, calls } = fakeAgent();
    const handlers = createOsBinding(createOsRouter({ agent }), {
      requestStop: () => {},
      defer: (cb) => cb(),
    });
    await expect(handlers.invoke("agent:prompt", [{}], connection)).rejects.toMatchObject({
      code: "bad-request",
    });
    await expect(handlers.invoke("provider:list", ["x"], connection)).rejects.toMatchObject({
      code: "bad-request",
    });
    await expect(
      handlers.invoke(
        "provider:save",
        [{ kind: "ollama", baseUrl: "http://localhost:11434", model: "m" }],
        connection,
      ),
    ).rejects.toMatchObject({ code: "bad-request" });
    await expect(handlers.invoke("daemon:snapshot", [], connection)).rejects.toMatchObject({
      code: "unknown-channel",
    });
    await expect(handlers.invoke("constructor", [], connection)).rejects.toMatchObject({
      code: "unknown-channel",
    });
    await expect(handlers.invoke("updates:check", ["now"], connection)).rejects.toMatchObject({
      code: "bad-request",
    });
    await expect(handlers.invoke("registry:list", [1], connection)).rejects.toMatchObject({
      code: "bad-request",
    });
    await expect(handlers.invoke("memory:list", [{ limit: 0 }], connection)).rejects.toMatchObject({
      code: "bad-request",
    });
    await expect(handlers.invoke("memory:delete", [{}], connection)).rejects.toMatchObject({
      code: "bad-request",
    });
    await expect(handlers.invoke("memory:clear", [1], connection)).rejects.toMatchObject({
      code: "bad-request",
    });
    await expect(
      handlers.invoke("memory:setEnabled", [{ enabled: "yes" }], connection),
    ).rejects.toMatchObject({ code: "bad-request" });
    expect(calls).toEqual([]);
  });

  it("maps an internal OsAgentError (a failed update check) to internal with its text", async () => {
    const { agent } = fakeAgent();
    agent.checkUpdates = async () => {
      throw new OsAgentError(
        "internal",
        "Could not check for updates: The repository is not signed.",
      );
    };
    const handlers = createOsBinding(createOsRouter({ agent }), {
      requestStop: () => {},
      defer: (cb) => cb(),
    });
    await expect(handlers.invoke("updates:check", [], connection)).rejects.toMatchObject({
      code: "internal",
      message: "Could not check for updates: The repository is not signed.",
    });
  });

  it("maps OsAgentError to its code and refuses uploads", async () => {
    const { agent } = fakeAgent();
    agent.prompt = () => {
      throw new OsAgentError("bad-request", "A request is already running. Stop it first.");
    };
    const handlers = createOsBinding(createOsRouter({ agent }), {
      requestStop: () => {},
      defer: (cb) => cb(),
    });
    const failure = await handlers
      .invoke("agent:prompt", [{ text: "x" }], connection)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ControlRequestError);
    expect(failure).toMatchObject({
      code: "bad-request",
      message: "A request is already running. Stop it first.",
    });
    await expect(
      handlers.upload("agent:prompt", [], new Uint8Array(1), connection),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("stops the daemon after the hello's stop intent", () => {
    const { agent } = fakeAgent();
    let stops = 0;
    const handlers = createOsBinding(createOsRouter({ agent }), {
      requestStop: () => stops++,
      defer: (cb) => cb(),
    });
    handlers.stop();
    expect(stops).toBe(1);
  });
});

describe("createOsRouter origins (Rafiq M3 phone bridge)", () => {
  const phone = { kind: "phone" as const, device: { id: "d".repeat(32), name: "Pixel 8" } };

  it("serves a phone the allowlisted channels", async () => {
    const { agent, calls } = fakeAgent();
    const router = createOsRouter({ agent });
    await expect(router.invoke("agent:prompt", [{ text: "hi" }], phone)).resolves.toEqual({
      turnId: "t1",
    });
    expect(calls.map((c) => c.method)).toEqual(["prompt"]);
  });

  it("refuses a phone everything else, before parsing", async () => {
    const { agent, calls } = fakeAgent();
    const router = createOsRouter({ agent });
    for (const channel of ["provider:save", "provider:list", "doctor:start", "updates:check"]) {
      await expect(router.invoke(channel, ["junk"], phone)).rejects.toMatchObject({
        code: "forbidden",
      });
    }
    expect(calls).toEqual([]);
  });

  it("names the phone allowlist of the contract", () => {
    expect([...PHONE_REQUESTS].sort()).toEqual(
      [
        "agent:confirm",
        "agent:prompt",
        "agent:stop",
        "agent:undo",
        "audit:list",
        "memory:list",
      ].sort(),
    );
  });

  it("bounds and cleans a phone's name for the audit log", () => {
    expect(phoneDeviceName("Pixel\u0007 8\n")).toBe("Pixel 8");
    expect(phoneDeviceName("   ")).toBe("phone");
    expect(phoneDeviceName("x".repeat(300))).toHaveLength(64);
    expect(phoneVia("__proto__")).toBe("phone:__proto__");
    expect(confirmFrom(phone)).toEqual({ via: "phone:Pixel 8", allowPassword: false });
    expect(confirmFrom({ kind: "local", connection })).toEqual({
      via: "desktop",
      allowPassword: true,
    });
  });
});

describe("OS router adapters", () => {
  it("requires a local origin for computer-only operations", () => {
    expect(() => requireLocal({ kind: "local", connection })).not.toThrow();
    expect(() => requireLocal({ kind: "phone", device: { id: "d", name: "Pixel" } })).toThrowError(
      ControlRequestError,
    );
  });

  it("preserves the connection and bytes through the local binding", async () => {
    const calls: unknown[][] = [];
    const router = {
      async invoke(...args: Parameters<import("./os-binding.js").OsRouter["invoke"]>) {
        calls.push(args);
        return "invoked";
      },
      async upload(...args: Parameters<import("./os-binding.js").OsRouter["upload"]>) {
        calls.push(args);
        return "uploaded";
      },
    };
    const binding = createOsBinding(router, {
      requestStop() {},
      defer(cb) {
        cb();
      },
    });
    const bytes = new Uint8Array([1, 2]);
    await expect(binding.invoke("test", [1], connection)).resolves.toBe("invoked");
    await expect(binding.upload("blob", [2], bytes, connection)).resolves.toBe("uploaded");
    expect(calls).toEqual([
      ["test", [1], { kind: "local", connection }],
      ["blob", [2], bytes, { kind: "local", connection }],
    ]);
  });
});
