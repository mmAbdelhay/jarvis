// Keep awake (Task 18): awake:status and awake:set — routing to the
// controller, and awake:set's argument check, the same from any origin.
import { describe, expect, it, vi } from "vitest";
import { createDispatchTable, DESKTOP_ORIGIN, type Origin } from "./dispatch.js";
import { fakeDeps } from "./dispatch.test.js";

const REMOTE_ORIGIN: Origin = { kind: "remote", deviceId: "d1", deviceName: "Phone" };

const callAs = (
  table: ReturnType<typeof createDispatchTable>,
  origin: Origin,
  channel: string,
  ...args: unknown[]
) =>
  (table as Record<string, (a: readonly unknown[], o: Origin) => unknown>)[channel]!(args, origin);

const ON = {
  mode: "on" as const,
  active: true,
  reason: "on" as const,
  simulateInput: false,
  inputState: "idle" as const,
};

function withAwake() {
  const awake = { status: vi.fn(() => ON), set: vi.fn(async () => ON) };
  return { awake, table: createDispatchTable(fakeDeps({ awake })) };
}

describe("awake:* dispatch", () => {
  it("awake:status answers the controller's status", async () => {
    const { table } = withAwake();
    expect(await callAs(table, REMOTE_ORIGIN, "awake:status")).toBe(ON);
  });

  it("awake:set passes only mode and simulateInput through", async () => {
    const { awake, table } = withAwake();
    expect(await callAs(table, REMOTE_ORIGIN, "awake:set", { mode: "agents" })).toBe(ON);
    expect(awake.set).toHaveBeenLastCalledWith({ mode: "agents" });
    await callAs(table, DESKTOP_ORIGIN, "awake:set", { simulateInput: true, mode: "off" });
    expect(awake.set).toHaveBeenLastCalledWith({ mode: "off", simulateInput: true });
  });

  it.each([
    undefined,
    null,
    "on",
    [],
    {},
    { mode: "always" },
    { simulateInput: "yes" },
    { mode: "on", idleSeconds: 60 },
    { mode: "on", extra: 1 },
  ])("refuses %j", async (patch) => {
    const { awake, table } = withAwake();
    await expect(
      Promise.resolve().then(() => callAs(table, REMOTE_ORIGIN, "awake:set", patch)),
    ).rejects.toThrow("awake:set: invalid patch");
    expect(awake.set).not.toHaveBeenCalled();
  });
});
