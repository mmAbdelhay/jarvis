import { describe, expect, it } from "vitest";
import { createFakeTransport } from "./fake-transport";
import { createTrustRoutingTransport } from "./trust-routing-transport";

describe("createTrustRoutingTransport", () => {
  it("routes a pin-trust open to the pin transport, with the same url/trust/onEvent", () => {
    const pin = createFakeTransport();
    const system = createFakeTransport();
    const routing = createTrustRoutingTransport({ pin, system });
    const events: unknown[] = [];
    const trust = { kind: "pin", fingerprint: "a".repeat(64) } as const;

    routing.open("wss://192.168.1.5:4317/rpc", trust, (e) => events.push(e));

    expect(pin.sockets).toHaveLength(1);
    expect(system.sockets).toHaveLength(0);
    expect(pin.sockets[0]?.url).toBe("wss://192.168.1.5:4317/rpc");
    expect(pin.sockets[0]?.trust).toEqual(trust);

    pin.sockets[0]?.emit({ kind: "open" });
    expect(events).toEqual([{ kind: "open" }]);
  });

  it("routes a system-trust open to the system transport, never the pin one", () => {
    const pin = createFakeTransport();
    const system = createFakeTransport();
    const routing = createTrustRoutingTransport({ pin, system });

    routing.open("wss://mac.tail.ts.net:4317/rpc", { kind: "system" }, () => {});

    expect(system.sockets).toHaveLength(1);
    expect(pin.sockets).toHaveLength(0);
    expect(system.sockets[0]?.trust).toEqual({ kind: "system" });
  });

  it("returns the target transport's own socket (send/close forward through)", () => {
    const pin = createFakeTransport();
    const system = createFakeTransport();
    const routing = createTrustRoutingTransport({ pin, system });

    const socket = routing.open("wss://mac.tail.ts.net:4317/rpc", { kind: "system" }, () => {});
    socket.send("hi");
    socket.close(1000, "done");

    expect(system.sockets[0]?.sent).toEqual(["hi"]);
    expect(system.sockets[0]?.closedWith).toEqual({ code: 1000, reason: "done" });
  });
});
