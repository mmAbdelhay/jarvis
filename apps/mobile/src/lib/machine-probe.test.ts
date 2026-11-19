import { CLOSE } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import { createFakeTransport } from "./fake-transport";
import type { MachineId } from "./machine-index";
import {
  PROBE_CONCURRENCY,
  PROBE_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  createOnlineStore,
  probeMachine,
} from "./machine-probe";
import type { MachineEntry } from "./machine-store";
import type { PairingRecord } from "./pairing-record";

const FINGERPRINT = "f".repeat(64);

function pinnedRecord(): PairingRecord {
  return {
    deviceId: "a".repeat(32),
    host: "192.168.1.5",
    port: 4317,
    fingerprint: FINGERPRINT,
    pairedAt: 1,
  };
}

function namedRecord(): PairingRecord {
  return {
    deviceId: "b".repeat(32),
    host: "0.0.0.0",
    port: 7717,
    fingerprint: "0".repeat(64),
    name: "mac.tail.ts.net",
    pairedAt: 1,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function probing(record: PairingRecord = pinnedRecord()) {
  const transport = createFakeTransport();
  const clock = createFakeClock();
  const answer = probeMachine({ transport, clock }, record);
  return { transport, clock, answer, socket: transport.sockets[0] };
}

describe("probeMachine", () => {
  it("the values", () => {
    expect(PROBE_TIMEOUT_MS).toBe(2_000);
    expect(PROBE_INTERVAL_MS).toBe(30_000);
    expect(PROBE_CONCURRENCY).toBe(4);
  });

  it("answers online on open and closes with no frame sent", async () => {
    const { answer, socket } = probing();
    socket?.emit({ kind: "open" });
    expect(await answer).toBe("online");
    expect(socket?.closedWith?.code).toBe(CLOSE.normal);
    expect(socket?.frames).toEqual([]);
  });

  it("a pinned record dials its host on /rpc with pin trust and its fingerprint", () => {
    const { socket } = probing(pinnedRecord());
    expect(socket?.url).toBe("wss://192.168.1.5:4317/rpc");
    expect(socket?.trust).toEqual({ kind: "pin", fingerprint: FINGERPRINT });
  });

  it("a named record dials its name on /rpc with system trust", () => {
    const { socket } = probing(namedRecord());
    expect(socket?.url).toBe("wss://mac.tail.ts.net:7717/rpc");
    expect(socket?.trust).toEqual({ kind: "system" });
  });

  it("a fingerprint close answers offline and closes", async () => {
    const { answer, socket } = probing();
    socket?.emit({ kind: "error", message: "pin" });
    socket?.emit({ kind: "close", code: 1006, reason: "fingerprint" });
    expect(await answer).toBe("offline");
    expect(socket?.closedWith?.code).toBe(CLOSE.normal);
  });

  it("no event within 2 s answers offline and closes the socket", async () => {
    const { answer, socket, clock } = probing();
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    clock.advance(PROBE_TIMEOUT_MS - 1);
    await settle();
    expect(settled).toBe(false);
    expect(socket?.closedWith).toBeUndefined();

    clock.advance(1);
    expect(await answer).toBe("offline");
    expect(socket?.closedWith?.code).toBe(CLOSE.normal);
    expect(socket?.frames).toEqual([]);
  });

  it("an open after the timeout changes nothing", async () => {
    const { answer, socket, clock } = probing();
    clock.advance(PROBE_TIMEOUT_MS);
    socket?.emit({ kind: "open" });
    expect(await answer).toBe("offline");
  });

  it("a late open closes the socket, when the close during connecting did nothing", async () => {
    const clock = createFakeClock();
    const inner = createFakeTransport();
    // React Native's Android WebSocket: a close before the upgrade finishes is
    // dropped, and the socket then opens all the same.
    let connecting = true;
    const answer = probeMachine(
      {
        transport: {
          open(url, trust, onEvent) {
            const socket = inner.open(url, trust, onEvent);
            const { close } = socket;
            socket.close = (code, reason) => {
              if (!connecting) close(code, reason);
            };
            return socket;
          },
        },
        clock,
      },
      namedRecord(),
    );
    const socket = inner.sockets[0];
    clock.advance(PROBE_TIMEOUT_MS);
    expect(await answer).toBe("offline");
    expect(socket?.closedWith).toBeUndefined();

    connecting = false;
    socket?.emit({ kind: "open" });

    expect(socket?.closedWith?.code).toBe(CLOSE.normal);
    expect(socket?.frames).toEqual([]);
  });

  it("the timer goes with the answer: a later tick closes nothing again", async () => {
    const { answer, socket, clock } = probing();
    socket?.emit({ kind: "open" });
    await answer;
    const closes = socket?.closedWith;
    if (socket !== undefined) socket.closedWith = undefined;
    clock.advance(PROBE_TIMEOUT_MS);
    expect(closes?.code).toBe(CLOSE.normal);
    expect(socket?.closedWith).toBeUndefined();
  });

  it("a throwing transport.open answers offline", async () => {
    const clock = createFakeClock();
    const answer = probeMachine(
      {
        transport: {
          open() {
            throw new Error("no native module");
          },
        },
        clock,
      },
      pinnedRecord(),
    );
    expect(await answer).toBe("offline");
  });

  it("a throwing close still answers", async () => {
    const clock = createFakeClock();
    const transport = createFakeTransport();
    const answer = probeMachine(
      {
        transport: {
          open(url, trust, onEvent) {
            const socket = transport.open(url, trust, onEvent);
            socket.close = () => {
              throw new Error("already gone");
            };
            return socket;
          },
        },
        clock,
      },
      pinnedRecord(),
    );
    transport.sockets[0]?.emit({ kind: "open" });
    expect(await answer).toBe("online");
  });

  it("an open during transport.open itself still closes the socket", async () => {
    const clock = createFakeClock();
    const transport = createFakeTransport();
    const answer = probeMachine(
      {
        transport: {
          open(url, trust, onEvent) {
            onEvent({ kind: "open" });
            return transport.open(url, trust, onEvent);
          },
        },
        clock,
      },
      pinnedRecord(),
    );
    expect(await answer).toBe("online");
    expect(transport.sockets[0]?.closedWith?.code).toBe(CLOSE.normal);
  });
});

function entriesOf(count: number): MachineEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}_1`,
    record: { ...pinnedRecord(), host: `10.0.0.${i}` },
  }));
}

function onlineHarness(options: { entries?: MachineEntry[]; activeId?: MachineId } = {}) {
  const clock = createFakeClock();
  const state = { entries: options.entries ?? entriesOf(3), activeId: options.activeId };
  /** Every probe asked for, by host, still waiting unless a test answers it. */
  const asked: Array<{ host: string; answer(value: "online" | "offline"): void }> = [];
  let lists = 0;
  let running = 0;
  let mostRunning = 0;
  const store = createOnlineStore({
    list: async () => {
      lists += 1;
      return state.entries;
    },
    activeId: () => state.activeId,
    probe: (record) => {
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      return new Promise((resolve) => {
        asked.push({
          host: record.host,
          answer(value) {
            running -= 1;
            resolve(value);
          },
        });
      });
    },
    clock,
  });
  return {
    clock,
    state,
    asked,
    store,
    lists: () => lists,
    mostRunning: () => mostRunning,
    /** Answers every probe waiting, and those the answers start. */
    async answerAll(value: "online" | "offline") {
      let index = 0;
      await settle();
      while (index < asked.length) {
        asked[index]?.answer(value);
        index += 1;
        await settle();
      }
    },
  };
}

describe("createOnlineStore", () => {
  it("starts nothing with no listener", async () => {
    const h = onlineHarness();
    h.clock.advance(PROBE_INTERVAL_MS * 3);
    await settle();
    expect(h.lists()).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.store.get().size).toBe(0);
  });

  it("with a listener each machine is checking, then answers", async () => {
    const h = onlineHarness();
    const seen: Array<string | undefined> = [];
    h.store.subscribe(() => seen.push(h.store.get().get("m0_1")));
    await settle();
    expect(h.store.get().get("m0_1")).toBe("checking");
    expect(h.store.get().get("m2_1")).toBe("checking");

    h.asked[0]?.answer("online");
    h.asked[1]?.answer("offline");
    await settle();

    expect(h.store.get().get("m0_1")).toBe("online");
    expect(h.store.get().get("m1_1")).toBe("offline");
    expect(h.store.get().get("m2_1")).toBe("checking");
    expect(seen).toContain("online");
  });

  it("each change is a new map, so a screen sees it", async () => {
    const h = onlineHarness();
    h.store.subscribe(() => {});
    await settle();
    const before = h.store.get();
    h.asked[0]?.answer("online");
    await settle();
    expect(h.store.get()).not.toBe(before);
    expect(before.get("m0_1")).toBe("checking");
  });

  it("repeats 30 s after a round began, and not before", async () => {
    const h = onlineHarness();
    h.store.subscribe(() => {});
    await h.answerAll("online");
    expect(h.asked).toHaveLength(3);

    h.clock.advance(PROBE_INTERVAL_MS - 1);
    await settle();
    expect(h.asked).toHaveLength(3);

    h.clock.advance(1);
    await settle();
    expect(h.asked).toHaveLength(6);
  });

  it("a second round keeps the last answer on screen while it asks again", async () => {
    const h = onlineHarness();
    h.store.subscribe(() => {});
    await h.answerAll("online");
    h.clock.advance(PROBE_INTERVAL_MS);
    await settle();
    expect(h.asked).toHaveLength(6);
    expect(h.store.get().get("m0_1")).toBe("online");
  });

  it("stops when the last listener leaves", async () => {
    const h = onlineHarness();
    const leave = h.store.subscribe(() => {});
    const leaveToo = h.store.subscribe(() => {});
    await h.answerAll("online");
    leave();
    h.clock.advance(PROBE_INTERVAL_MS);
    await settle();
    expect(h.asked).toHaveLength(6);
    await h.answerAll("online");

    leaveToo();
    h.clock.advance(PROBE_INTERVAL_MS * 3);
    await settle();
    expect(h.asked).toHaveLength(6);
  });

  it("a second listener does not start a second round", async () => {
    const h = onlineHarness();
    h.store.subscribe(() => {});
    h.store.subscribe(() => {});
    await settle();
    expect(h.lists()).toBe(1);
    expect(h.asked).toHaveLength(3);
  });

  it("the active id is never probed", async () => {
    const h = onlineHarness({ activeId: "m1_1" });
    h.store.subscribe(() => {});
    await h.answerAll("online");
    expect(h.asked.map((probe) => probe.host)).toEqual(["10.0.0.0", "10.0.0.2"]);
    expect(h.store.get().has("m1_1")).toBe(false);
  });

  it("a machine that becomes active during the round is not probed either", async () => {
    const h = onlineHarness({ entries: entriesOf(6) });
    h.store.subscribe(() => {});
    await settle();
    expect(h.asked).toHaveLength(4);
    h.state.activeId = "m5_1";
    await h.answerAll("online");
    expect(h.asked.map((probe) => probe.host)).not.toContain("10.0.0.5");
    expect(h.asked).toHaveLength(5);
  });

  it("never more than 4 probes at once with 8 machines", async () => {
    const h = onlineHarness({ entries: entriesOf(8) });
    h.store.subscribe(() => {});
    await settle();
    expect(h.asked).toHaveLength(PROBE_CONCURRENCY);

    await h.answerAll("offline");

    expect(h.asked).toHaveLength(8);
    expect(h.mostRunning()).toBe(PROBE_CONCURRENCY);
  });

  it("a result arriving after the last listener left changes nothing", async () => {
    const h = onlineHarness();
    let calls = 0;
    const leave = h.store.subscribe(() => {
      calls += 1;
    });
    await settle();
    leave();
    const before = h.store.get();
    const callsBefore = calls;

    h.asked[0]?.answer("online");
    await settle();

    expect(h.store.get()).toBe(before);
    expect(h.store.get().get("m0_1")).not.toBe("online");
    expect(calls).toBe(callsBefore);
  });

  it("no probe starts after the last listener left, however many were queued", async () => {
    const h = onlineHarness({ entries: entriesOf(8) });
    const leave = h.store.subscribe(() => {});
    await settle();
    leave();
    await h.answerAll("online");
    expect(h.asked).toHaveLength(PROBE_CONCURRENCY);
  });

  it("a list answering after the last listener left starts nothing", async () => {
    const clock = createFakeClock();
    let answerList: (entries: MachineEntry[]) => void = () => {};
    const probes: string[] = [];
    const store = createOnlineStore({
      list: () =>
        new Promise((resolve) => {
          answerList = resolve;
        }),
      activeId: () => undefined,
      probe: async (record) => {
        probes.push(record.host);
        return "online";
      },
      clock,
    });
    const leave = store.subscribe(() => {});
    leave();
    answerList(entriesOf(2));
    await settle();
    expect(probes).toEqual([]);
    expect(store.get().size).toBe(0);
  });

  it("leaving and coming back starts over, with the old round's answers ignored", async () => {
    const h = onlineHarness({ entries: entriesOf(1) });
    const leave = h.store.subscribe(() => {});
    await settle();
    leave();
    h.store.subscribe(() => {});
    await settle();
    expect(h.asked).toHaveLength(2);

    h.asked[0]?.answer("online");
    await settle();
    expect(h.store.get().get("m0_1")).toBe("checking");

    h.asked[1]?.answer("offline");
    await settle();
    expect(h.store.get().get("m0_1")).toBe("offline");
  });

  it("a probe that rejects counts as offline, and the rest go on", async () => {
    const clock = createFakeClock();
    const store = createOnlineStore({
      list: async () => entriesOf(2),
      activeId: () => undefined,
      probe: async (record) => {
        if (record.host === "10.0.0.0") throw new Error("boom");
        return "online";
      },
      clock,
    });
    store.subscribe(() => {});
    await settle();
    expect(store.get().get("m0_1")).toBe("offline");
    expect(store.get().get("m1_1")).toBe("online");
  });

  it("a list that rejects shows nothing new, and the next round asks again", async () => {
    const clock = createFakeClock();
    let lists = 0;
    const store = createOnlineStore({
      list: async () => {
        lists += 1;
        if (lists === 1) throw new Error("machines: store is not open");
        return entriesOf(1);
      },
      activeId: () => undefined,
      probe: async () => "online",
      clock,
    });
    store.subscribe(() => {});
    await settle();
    expect(store.get().size).toBe(0);

    clock.advance(PROBE_INTERVAL_MS);
    await settle();
    expect(store.get().get("m0_1")).toBe("online");
  });

  it("a machine gone by the next round leaves the map", async () => {
    const h = onlineHarness({ entries: entriesOf(2) });
    h.store.subscribe(() => {});
    await h.answerAll("online");
    h.state.entries = entriesOf(1);
    h.clock.advance(PROBE_INTERVAL_MS);
    await settle();
    expect(h.store.get().has("m1_1")).toBe(false);
    expect(h.store.get().get("m0_1")).toBe("online");
  });
});
