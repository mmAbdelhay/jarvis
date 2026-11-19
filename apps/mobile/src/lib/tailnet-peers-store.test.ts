import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "./clock";
import type { DiscoveredMachine } from "./machine-switcher";
import type { RpcResult } from "./rpc-client";
import {
  DISCOVER_INTERVAL_MS,
  fetchDiscovered,
  parseDiscovered,
  startDiscoveredPoll,
} from "./tailnet-peers-store";

const MAC = { name: "mac.tail1234.ts.net", label: "Mac", v: 1, bridgePort: 7717, webPort: 7718 };
const MAC_FOUND: DiscoveredMachine = {
  name: "mac.tail1234.ts.net",
  label: "Mac",
  port: 7717,
  webPort: 7718,
};

function clientAnswering(answer: () => Promise<RpcResult>) {
  return { call: vi.fn(async (_channel: string, _args: unknown[]) => answer()) };
}

describe("parseDiscovered", () => {
  it("rebuilds each machine, leaving extra keys behind", () => {
    expect(parseDiscovered({ state: "ok", machines: [{ ...MAC, extra: "x" }] })).toEqual([
      MAC_FOUND,
    ]);
  });

  it.each([
    ["not an object", "ok"],
    ["null", null],
    ["a non-array list", { state: "ok", machines: "mac" }],
    ["no list", { state: "ok" }],
    ["a list in a state other than ok", { state: "not-running", machines: [MAC] }],
  ])("gives nothing for %s", (_label, value) => {
    expect(parseDiscovered(value)).toEqual([]);
  });

  it.each([
    ["a non-object", "mac"],
    ["a name off the tailnet", { ...MAC, name: "evil.example.com" }],
    ["a name with a path", { ...MAC, name: `${MAC.name}/x` }],
    ["a short name", { ...MAC, name: "mac" }],
    ["a bad bridge port", { ...MAC, bridgePort: 70000 }],
    ["a fractional web port", { ...MAC, webPort: 7718.5 }],
    ["a missing label", { ...MAC, label: undefined }],
  ])("drops %s", (_label, entry) => {
    expect(parseDiscovered({ state: "ok", machines: [entry] })).toEqual([]);
    expect(parseDiscovered({ state: "ok", machines: [entry, MAC] })).toEqual([MAC_FOUND]);
  });

  it("an empty label reads as the first part of the name", () => {
    expect(parseDiscovered({ state: "ok", machines: [{ ...MAC, label: " " }] })).toEqual([
      { ...MAC_FOUND, label: "mac" },
    ]);
  });
});

describe("fetchDiscovered", () => {
  it("asks tailnet:peers with no arguments", async () => {
    const client = clientAnswering(async () => ({
      ok: true,
      value: { state: "ok", machines: [MAC] },
    }));
    expect(await fetchDiscovered(client)).toEqual([MAC_FOUND]);
    expect(client.call).toHaveBeenCalledWith("tailnet:peers", []);
  });

  it("a failed reply gives nothing", async () => {
    const client = clientAnswering(async () => ({
      ok: false,
      error: { code: "denied", message: "no" } as never,
    }));
    expect(await fetchDiscovered(client)).toEqual([]);
  });

  it("a rejected call gives nothing", async () => {
    const client = clientAnswering(async () => {
      throw new Error("closed");
    });
    expect(await fetchDiscovered(client)).toEqual([]);
  });

  it("a bad reply gives nothing", async () => {
    const client = clientAnswering(async () => ({ ok: true, value: [MAC] }));
    expect(await fetchDiscovered(client)).toEqual([]);
  });
});

describe("startDiscoveredPoll", () => {
  async function settled(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("fetches at once and every 30 seconds", async () => {
    const clock = createFakeClock();
    const fetch = vi.fn(async () => [MAC_FOUND]);
    const seen: DiscoveredMachine[][] = [];
    const stop = startDiscoveredPoll({ fetch, clock, onFound: (list) => seen.push(list) });
    expect(DISCOVER_INTERVAL_MS).toBe(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await settled();
    expect(seen).toEqual([[MAC_FOUND]]);
    clock.advance(29_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.advance(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    clock.advance(30_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stops when stopped, and a reply arriving after says nothing", async () => {
    const clock = createFakeClock();
    let finish: (list: DiscoveredMachine[]) => void = () => {};
    const fetch = vi.fn(
      () =>
        new Promise<DiscoveredMachine[]>((resolve) => {
          finish = resolve;
        }),
    );
    const onFound = vi.fn();
    const stop = startDiscoveredPoll({ fetch, clock, onFound });
    stop();
    finish([MAC_FOUND]);
    await settled();
    clock.advance(90_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onFound).not.toHaveBeenCalled();
  });
});
