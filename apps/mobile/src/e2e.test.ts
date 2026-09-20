// One scripted scenario over `FakeTransport` + the fake clock + a fake
// secure store (task-9-brief.md): pair → save → connect → welcome →
// dashboard focus → pushes → socket drop → reconnect → re-sub → 4410 →
// unpaired → pairing cleared. Every step reuses the real module each
// screen actually wires together (pairing.ts, pairing-record.ts,
// rpc-client.ts, connection-store.ts, dashboard-store.ts,
// unpaired-handler.ts) — nothing here reimplements what those modules do.
//
// This is the one place that proves the pieces the other unit tests cover
// in isolation actually compose end to end, including the global
// constraint that the token and the pairing secret never appear in a log
// line anywhere across the whole run.

import { CLOSE, type PairingLink, PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./lib/clock";
import { createConnectionStore } from "./lib/connection-store";
import { createDashboardStore } from "./lib/dashboard-store";
import { createFakeTransport } from "./lib/fake-transport";
import type { FakeSocket } from "./lib/fake-transport";
import { pair } from "./lib/pairing";
import { clearPairing, loadPairing, savePairing } from "./lib/pairing-record";
import { createRpcClient } from "./lib/rpc-client";
import type { SecureStore } from "./lib/secure-store";
import { createUnpairedHandler } from "./lib/unpaired-handler";

class FakeSecureStore implements SecureStore {
  private values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  raw(key: string): string | undefined {
    return this.values.get(key);
  }

  /** Minor 2 (task-9-review.md): lets a test confirm the token lives under
   * *no other* key, not just that the expected key holds it. */
  entries(): [string, string][] {
    return [...this.values.entries()];
  }
}

const LINK: PairingLink = {
  host: "192.168.1.5",
  port: 4317,
  secret: "s".repeat(43),
  fingerprint: "a".repeat(64),
};
const DEVICE_NAME = "Aziz's iPhone";
const CLIENT_STRING = "jarvis-mobile/1.0.0/ios";

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function frame(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

/** Minor 1 (task-9-review.md): the number of `t:"sub"` frames a socket
 * actually sent — not just that one happens to sit at a given index, which
 * would still pass if a second, later `sub` frame slipped in. */
function subFrameCount(socket: FakeSocket): number {
  return socket.sent.filter((text) => frame(text).t === "sub").length;
}

/** Lets the microtasks connection-store's onUnpaired reaction queues (and
 * the async work inside it) settle before the next assertion runs. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the pairing-to-revocation scenario, end to end", () => {
  it("pairs, connects, subscribes, survives a reconnect, and unpairs on revocation — without ever logging the token or the secret", async () => {
    const transport = createFakeTransport();
    const clock = createFakeClock();
    const secureStore = new FakeSecureStore();
    const logs: string[] = [];
    const navigated: string[] = [];

    // --- 1. pair() over /pair; savePairing stores the token only under jarvis.token ---
    const pairPromise = pair({ transport, clock, client: CLIENT_STRING }, LINK, DEVICE_NAME);
    const pairSocket = latestSocket(transport);
    pairSocket.emit({ kind: "open" });
    expect(frame(pairSocket.sent[0] ?? "")).toMatchObject({ t: "pair", secret: LINK.secret });

    const deviceId = "d".repeat(32);
    const token = "T".repeat(43);
    pairSocket.emit({
      kind: "message",
      text: encodeMessage({ t: "paired", v: PROTOCOL_VERSION, deviceId, token }),
    });
    const pairOutcome = await pairPromise;
    expect(pairOutcome.ok).toBe(true);
    if (!pairOutcome.ok) throw new Error("unreachable");

    await savePairing(secureStore, pairOutcome.record, pairOutcome.credential);
    expect(secureStore.raw("jarvis.token")).toBe(token);
    const storedRecord = JSON.parse(secureStore.raw("jarvis.pairing") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(storedRecord).not.toHaveProperty("token");
    expect(JSON.stringify(storedRecord)).not.toContain(token);
    // Minor 2: not just that `jarvis.token` holds it — that no *other* key
    // does either.
    const keysHoldingToken = secureStore
      .entries()
      .filter(([, value]) => value === token)
      .map(([key]) => key);
    expect(keysHoldingToken).toEqual(["jarvis.token"]);

    // --- 2. createRpcClient + connect: the /rpc socket's first frame is hello, then welcome → open ---
    const client = createRpcClient({
      transport,
      clock,
      random: () => 0.5, // zero jitter (backoff.ts): exact 1000ms reconnect delays
      client: CLIENT_STRING,
      log: (line) => logs.push(line),
    });
    const dashboardStore = createDashboardStore({ client });
    const unpairedHandler = createUnpairedHandler({
      clearPairing: () => clearPairing(secureStore),
      navigateToPair: (outcome) => navigated.push(outcome),
      log: (line) => logs.push(line),
    });
    const connectionStore = createConnectionStore({
      client,
      clock,
      onUnpaired: unpairedHandler,
    });

    client.connect(
      {
        host: pairOutcome.record.host,
        port: pairOutcome.record.port,
        fingerprint: pairOutcome.record.fingerprint,
      },
      pairOutcome.credential,
    );

    // --- 3. Dashboard focus, before welcome: one batched sub and one queued req ---
    dashboardStore.focus();

    const rpcSocket1 = latestSocket(transport);
    rpcSocket1.emit({ kind: "open" });
    expect(frame(rpcSocket1.sent[0] ?? "")).toMatchObject({
      t: "hello",
      deviceId,
      token,
    });

    rpcSocket1.emit({
      kind: "message",
      text: encodeMessage({
        t: "welcome",
        v: PROTOCOL_VERSION,
        capabilities: ["metrics:update", "sessions:update"],
      }),
    });

    expect(frame(rpcSocket1.sent[1] ?? "")).toEqual({
      t: "sub",
      add: expect.arrayContaining(["metrics:update", "sessions:update"]),
    });
    // handleWelcome flushes the two requests focus() queued — projects:list
    // then sessions:list (sent[2], sent[3]) — *before* moving to "open" —
    // and dashboard-store's own onState("open") handler (registered by
    // focus() to re-fetch both lists after every reconnect) fires
    // synchronously off that same transition and sends a second pair
    // immediately (sent[4], sent[5]), superseding the first
    // (dashboard-store.ts's refreshGeneration). Only the later pair's `res`
    // is still honoured.
    expect(frame(rpcSocket1.sent[2] ?? "")).toMatchObject({ t: "req", ch: "projects:list" });
    expect(frame(rpcSocket1.sent[3] ?? "")).toMatchObject({ t: "req", ch: "sessions:list" });
    const projectsReq = frame(rpcSocket1.sent[4] ?? "");
    expect(projectsReq).toMatchObject({ t: "req", ch: "projects:list" });
    const sessionsReq = frame(rpcSocket1.sent[5] ?? "");
    expect(sessionsReq).toMatchObject({ t: "req", ch: "sessions:list" });
    expect(connectionStore.get().state).toBe("open");
    // Minor 1: exactly one `sub` frame on this socket, not just one at index 1.
    expect(subFrameCount(rpcSocket1)).toBe(1);

    // A metrics push reaches the dashboard view.
    rpcSocket1.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "metrics:update",
        seq: 1,
        p: {
          cpuPercent: 12,
          memoryUsedBytes: 1,
          memoryTotalBytes: 2,
          diskUsedBytes: 1,
          diskTotalBytes: 2,
          networkDownMbps: 1,
          networkUpMbps: 1,
          uptimeSeconds: 10,
        },
      }),
    });
    expect(dashboardStore.get().metrics?.cpuPercent).toBe(12);

    // Both `res`es for the queued pair (dashboard-store.ts's refresh() awaits
    // both before applying either) fill the project and session lists.
    rpcSocket1.emit({
      kind: "message",
      text: encodeMessage({ t: "res", id: projectsReq.id as number, v: ["proj-a", "proj-b"] }),
    });
    rpcSocket1.emit({
      kind: "message",
      text: encodeMessage({ t: "res", id: sessionsReq.id as number, v: [] }),
    });
    await flushMicrotasks();
    expect(dashboardStore.get().projects).toEqual([{ name: "proj-a" }, { name: "proj-b" }]);

    // --- 4. socket drop (1006) → reconnecting/stale; after 1000ms a fresh socket, hello, welcome, one sub, then the queued req survives ---
    rpcSocket1.emit({ kind: "close", code: 1006, reason: "transport" });
    expect(connectionStore.get().state).toBe("reconnecting");
    expect(connectionStore.get().stale).toBe(true);

    // A request made while disconnected queues rather than failing outright.
    const duringDisconnect = client.call("git:status", []);

    clock.advance(1000);
    const rpcSocket2 = latestSocket(transport);
    expect(rpcSocket2).not.toBe(rpcSocket1);
    rpcSocket2.emit({ kind: "open" });
    expect(frame(rpcSocket2.sent[0] ?? "")).toMatchObject({ t: "hello", deviceId, token });

    rpcSocket2.emit({
      kind: "message",
      text: encodeMessage({
        t: "welcome",
        v: PROTOCOL_VERSION,
        capabilities: ["metrics:update", "sessions:update"],
      }),
    });
    expect(frame(rpcSocket2.sent[1] ?? "")).toEqual({
      t: "sub",
      add: expect.arrayContaining(["metrics:update", "sessions:update"]),
    });
    const queuedReq = frame(rpcSocket2.sent[2] ?? "");
    expect(queuedReq).toMatchObject({ t: "req", ch: "git:status" });
    // Minor 1: exactly one `sub` frame on the reconnected socket too.
    expect(subFrameCount(rpcSocket2)).toBe(1);

    rpcSocket2.emit({
      kind: "message",
      text: encodeMessage({ t: "res", id: queuedReq.id as number, v: "ok" }),
    });
    await expect(duringDisconnect).resolves.toEqual({ ok: true, value: "ok" });

    // --- 5. close 4410 (revoked) → unpaired; onUnpaired clears both keys; a subsequent loadPairing is undefined ---
    rpcSocket2.emit({ kind: "close", code: CLOSE.revoked, reason: "" });
    expect(connectionStore.get().state).toBe("unpaired");

    await flushMicrotasks();

    expect(navigated).toEqual(["cleared"]);
    expect(secureStore.raw("jarvis.token")).toBeUndefined();
    expect(secureStore.raw("jarvis.pairing")).toBeUndefined();
    await expect(loadPairing(secureStore)).resolves.toBeUndefined();

    // --- 6. the token and the secret never appear anywhere in the log output ---
    const allLogs = logs.join("\n");
    expect(allLogs).not.toContain(token);
    // Minor 3: `pairing.ts` takes no `log` dependency at all (see its own
    // file header), so this half of the check cannot bite today — nothing
    // could log the secret even if this assertion were removed. It stands
    // as a guard for if `pair()` is ever given a `log` parameter later.
    expect(allLogs).not.toContain(LINK.secret);
  });
});
