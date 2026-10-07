import { describe, expect, it } from "vitest";
import { ControlRequestError } from "../control/messages.js";
import type { ControlConnection } from "../control/server.js";
import { type OsAgent, OsAgentError } from "./agent-service.js";
import { createOsBinding } from "./os-binding.js";

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
      Promise.resolve({ active: null, kinds: [] }),
    ) as OsAgent["providerList"],
    probe: record(
      "probe",
      Promise.resolve({ ok: true, supportsTools: true, models: [] }),
    ) as OsAgent["probe"],
    save: record(
      "save",
      Promise.resolve({ ok: true, supportsTools: true, models: [] }),
    ) as OsAgent["save"],
    doctorStart: record("doctorStart", idle) as OsAgent["doctorStart"],
    doctorSkip: record("doctorSkip", idle) as OsAgent["doctorSkip"],
    auditList: record("auditList", Promise.resolve([])) as OsAgent["auditList"],
    resync: () => {},
    shutdown: async () => {},
  };
  return { agent, calls };
}

describe("createOsBinding", () => {
  it("routes each contract channel with parsed arguments", async () => {
    const { agent, calls } = fakeAgent();
    const handlers = createOsBinding(agent, { requestStop: () => {}, defer: (cb) => cb() });
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
      [{ kind: "ollama", baseUrl: "http://localhost:11434", model: "qwen3:8b" }],
      connection,
    );
    await handlers.invoke("doctor:start", [], connection);
    await handlers.invoke("doctor:skip", [{ stepId: "wifi" }], connection);
    await handlers.invoke("audit:list", [{ limit: 20 }], connection);
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
    ]);
    expect(calls[0]?.args).toEqual(["install vlc"]);
  });

  it("answers bad arguments with bad-request and unknown channels with unknown-channel", async () => {
    const { agent, calls } = fakeAgent();
    const handlers = createOsBinding(agent, { requestStop: () => {}, defer: (cb) => cb() });
    await expect(handlers.invoke("agent:prompt", [{}], connection)).rejects.toMatchObject({
      code: "bad-request",
    });
    await expect(handlers.invoke("provider:list", ["x"], connection)).rejects.toMatchObject({
      code: "bad-request",
    });
    await expect(
      handlers.invoke(
        "provider:save",
        [{ kind: "ollama", baseUrl: "http://localhost:11434", model: "" }],
        connection,
      ),
    ).rejects.toMatchObject({ code: "bad-request" });
    await expect(handlers.invoke("daemon:snapshot", [], connection)).rejects.toMatchObject({
      code: "unknown-channel",
    });
    await expect(handlers.invoke("constructor", [], connection)).rejects.toMatchObject({
      code: "unknown-channel",
    });
    expect(calls).toEqual([]);
  });

  it("maps OsAgentError to its code and refuses uploads", async () => {
    const { agent } = fakeAgent();
    agent.prompt = () => {
      throw new OsAgentError("bad-request", "A request is already running. Stop it first.");
    };
    const handlers = createOsBinding(agent, { requestStop: () => {}, defer: (cb) => cb() });
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
    const handlers = createOsBinding(agent, { requestStop: () => stops++, defer: (cb) => cb() });
    handlers.stop();
    expect(stops).toBe(1);
  });
});
