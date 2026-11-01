import { describe, expect, it, vi } from "vitest";
import type { RpcResult } from "./rpc-client";
import { awakeHintKey, createAwakeStore, parseAwakeStatus } from "./awake-store";

function ok(value: unknown): RpcResult {
  return { ok: true, value };
}

function fakeClient(results: RpcResult[]) {
  const pushes = new Map<string, (payload: unknown) => void>();
  return {
    call: vi.fn(async (_channel: string, _args: unknown[]) => results.shift() ?? ok(undefined)),
    onPush: vi.fn((channel: string, handler: (payload: unknown) => void) => {
      pushes.set(channel, handler);
      return () => pushes.delete(channel);
    }),
    subscribe: vi.fn((): RpcResult<void> => ({ ok: true, value: undefined })),
    unsubscribe: vi.fn(),
    push(channel: string, payload: unknown) {
      pushes.get(channel)?.(payload);
    },
  };
}

const OFF = {
  mode: "off",
  active: false,
  reason: "off",
  simulateInput: false,
  inputState: "idle",
};
const AGENTS = { ...OFF, mode: "agents", reason: "no-agent" };
const ON = { ...OFF, mode: "on", active: true, reason: "on" };

describe("parseAwakeStatus", () => {
  it("rebuilds a status field by field, leaving extra keys behind", () => {
    expect(parseAwakeStatus({ ...ON, extra: "x" })).toEqual(ON);
  });

  it.each([
    ["not an object", "on"],
    ["null", null],
    ["a bad mode", { ...ON, mode: "always" }],
    ["a non-boolean active", { ...ON, active: "yes" }],
    ["a bad reason", { ...ON, reason: "because" }],
    ["a non-boolean simulateInput", { ...ON, simulateInput: 1 }],
    ["a bad inputState", { ...ON, inputState: "great" }],
  ])("refuses %s", (_label, value) => {
    expect(parseAwakeStatus(value)).toBeUndefined();
  });
});

describe("awakeHintKey", () => {
  it("names the line for each reason, and the permission problem first", () => {
    expect(awakeHintKey(parseAwakeStatus(OFF)!)).toBe("awake.hintOff");
    expect(awakeHintKey(parseAwakeStatus(ON)!)).toBe("awake.hintOn");
    expect(awakeHintKey(parseAwakeStatus(AGENTS)!)).toBe("awake.hintNoAgent");
    expect(awakeHintKey(parseAwakeStatus({ ...AGENTS, reason: "agent-running" })!)).toBe(
      "awake.hintAgent",
    );
    expect(
      awakeHintKey(
        parseAwakeStatus({ ...ON, simulateInput: true, inputState: "needs-permission" })!,
      ),
    ).toBe("awake.hintPermission");
  });
});

describe("createAwakeStore", () => {
  it("loads the laptop's status", async () => {
    const client = fakeClient([ok(ON)]);
    const store = createAwakeStore({ client });
    await store.load();
    expect(client.call).toHaveBeenCalledWith("awake:status", []);
    expect(store.state.status).toEqual(ON);
  });

  it("toggle turns it off, then back to the last mode that was on", async () => {
    const client = fakeClient([ok(AGENTS), ok(OFF), ok(AGENTS)]);
    const store = createAwakeStore({ client });
    await store.load();
    await store.toggle();
    expect(client.call).toHaveBeenLastCalledWith("awake:set", [{ mode: "off" }]);
    expect(store.state.status?.mode).toBe("off");
    await store.toggle();
    expect(client.call).toHaveBeenLastCalledWith("awake:set", [{ mode: "agents" }]);
  });

  it("toggle from off with no history turns it on", async () => {
    const client = fakeClient([ok(OFF), ok(ON)]);
    const store = createAwakeStore({ client });
    await store.load();
    await store.toggle();
    expect(client.call).toHaveBeenLastCalledWith("awake:set", [{ mode: "on" }]);
    expect(store.state.status).toEqual(ON);
  });

  it("keeps an error when a call fails", async () => {
    const client = fakeClient([
      { ok: false, error: { kind: "remote", text: "nope" } } as RpcResult,
    ]);
    const store = createAwakeStore({ client });
    await store.load();
    expect(store.state.error).toBe(true);
    expect(store.state.status).toBeUndefined();
  });

  it("subscribes to awake:changed and redraws from the payload, re-reading a bad one", async () => {
    const client = fakeClient([ok(OFF)]);
    const store = createAwakeStore({ client });
    const seen = vi.fn();
    const stop = store.subscribe(seen);
    expect(client.subscribe).toHaveBeenCalledWith("awake:changed");
    client.push("awake:changed", ON);
    expect(store.state.status).toEqual(ON);
    expect(seen).toHaveBeenCalled();
    client.push("awake:changed", { junk: true });
    await vi.waitFor(() => expect(client.call).toHaveBeenCalledWith("awake:status", []));
    stop();
    expect(client.unsubscribe).toHaveBeenCalledWith("awake:changed");
  });
});
