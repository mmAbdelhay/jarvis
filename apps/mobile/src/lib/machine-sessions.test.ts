import { CLOSE, encodeMessage } from "@jarvis/wire";
import { describe, expect, it, vi } from "vitest";
import { bannerModel } from "./banner-model";
import { setClearFailedSignal, takeClearFailedSignal } from "./clear-failed-signal";
import {
  A_ID,
  ACCESS_TTL_MS,
  B_ID,
  C_ID,
  IDLE_MS,
  answer,
  deferred,
  flagsOf,
  machinesHarness,
  recordOf,
  refreshKeyOf,
  refreshTokenOf,
  requestsOn,
  settle,
  tokenReply,
  welcome,
} from "./fake-machines";
import { MACHINE_INDEX_KEY } from "./machine-index";
import {
  type ForgetOutcome,
  type MachineScope,
  applyForgetOutcome,
  prepareSwitchRoute,
  retryClear,
  unpairedHandlerFor,
} from "./machine-sessions";
import { createMachineStore } from "./machine-store";
import { machineLabel } from "./machine-switcher";
import { clearFailedEntry, entryPhaseKind, openHeldMachine, pairBackTarget } from "./pair-flow";
import { isClearingPairing, setClearingPairing } from "./pairing-guard";
import { PairingAlreadyExistsError } from "./pairing-record";
import { handleNotificationTap } from "./push-context-support";
import { takeRevokedSignal } from "./revoked-signal";
import { createNavigatorGate } from "./scope-routing";
import { createTopBarStore } from "./top-bar-store";
import { shouldShowUnlock } from "./unlock-screen";

const OFFLINE = { ok: false, error: { kind: "offline" } };
const SOME_CAPACITY = [
  {
    id: "Claude",
    vendor: "anthropic",
    capacity: { state: "known", primary: { usedPercent: 38, resetsAt: "2026-10-03T12:00:00Z" } },
  },
];

function pushFrame(channel: string, payload: unknown) {
  return {
    kind: "message" as const,
    text: encodeMessage({ t: "psh", ch: channel, p: payload, seq: 1 }),
  };
}

describe("switchTo: the order", () => {
  it("quiesce, prepareSwitch, old disconnect, setActive, publish, new connect", async () => {
    const h = machinesHarness();
    await h.start();

    expect(await h.sessions.switchTo(B_ID)).toBe("switched");

    expect(h.events).toEqual([
      `quiesce ${A_ID}`,
      "prepare",
      `disconnect ${A_ID}`,
      `setActive ${B_ID}`,
      `publish ${B_ID}`,
      `disconnect ${B_ID}`,
      `connect ${B_ID}`,
    ]);
    expect(h.sessions.current().id).toBe(B_ID);
    expect(h.store.activeId()).toBe(B_ID);
  });

  it('the active id answers "same" and does nothing', async () => {
    const h = machinesHarness();
    await h.start();
    expect(await h.sessions.switchTo(A_ID)).toBe("same");
    expect(h.events).toEqual([]);
  });

  it("the generation rises on every published scope", async () => {
    const h = machinesHarness();
    await h.start();
    await h.sessions.switchTo(B_ID);
    await h.sessions.switchTo(C_ID);
    await h.sessions.switchTo(A_ID);
    const generations = h.published.map((scope) => scope.generation);
    expect(generations).toHaveLength(4);
    expect(generations).toEqual([...generations].sort((a, b) => a - b));
    expect(new Set(generations).size).toBe(4);
    expect(h.sessions.current().generation).toBe(generations[3]);
  });

  it("a throwing prepareSwitch never stops the switch", async () => {
    const h = machinesHarness();
    await h.start();
    h.setPrepareSwitch(() => {
      throw new Error("no navigator mounted");
    });
    expect(await h.sessions.switchTo(B_ID)).toBe("switched");
    expect(h.socketOf(B_ID)).toBeDefined();
  });
});

describe("nothing of one machine reaches another", () => {
  it("a call in flight on A at the switch settles offline", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    const call = a.client.call("sessions:list", []);

    await h.sessions.switchTo(B_ID);

    expect(await call).toEqual(OFFLINE);
  });

  it("a call a stale screen queued on a closed client settles offline on return, and never replays", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    await h.sessions.switchTo(B_ID);
    const stale = a.client.call("sessions:list", []);

    await h.sessions.switchTo(A_ID);

    expect(await stale).toEqual(OFFLINE);
    expect(h.sessions.current().client).toBe(a.client);
    welcome(h.socketOf(A_ID));
    await settle();
    expect(requestsOn(h.socketOf(A_ID), "sessions:list")).toEqual([]);
  });

  it("a call queued on a kept client settles offline when a reconnect brings that client back", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.sessions.switchTo(B_ID);
    const stale = a.client.call("sessions:list", []);
    await h.sessions.forget(B_ID, "unpair");

    expect(await h.sessions.reconnect()).toBe("connected");

    expect(h.sessions.current().client).toBe(a.client);
    expect(await stale).toEqual(OFFLINE);
    welcome(h.socketOf(A_ID));
    await settle();
    expect(requestsOn(h.socketOf(A_ID), "sessions:list")).toEqual([]);
  });

  it("a reconnect on the client on screen keeps that screen's queued calls", async () => {
    const h = machinesHarness();
    const a = await h.start();
    const queued = a.client.call("sessions:list", []);

    expect(await h.sessions.reconnect()).toBe("connected");

    expect(h.events).not.toContain(`disconnect ${A_ID}`);
    a.client.disconnect();
    expect(await queued).toEqual(OFFLINE);
  });

  it("a late frame from A's socket reaches no handler on A or B", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    const socketA = h.socketOf(A_ID);
    const seen: string[] = [];
    a.client.onPush("metrics:update", () => seen.push("A"));
    socketA.emit(pushFrame("metrics:update", { cpu: 1 }));
    expect(seen).toEqual(["A"]);
    seen.length = 0;

    await h.sessions.switchTo(B_ID);
    const b = h.sessions.current();
    b.client.onPush("metrics:update", () => seen.push("B"));
    socketA.emit(pushFrame("metrics:update", { cpu: 1 }));

    expect(seen).toEqual([]);
  });

  it("a push on B's socket reaches a store built on B and not one built on A", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    const storeA = createTopBarStore({ client: a.client });
    storeA.subscribe(() => {});

    await h.sessions.switchTo(B_ID);
    const b = await h.unlockCurrent("2");
    const storeB = createTopBarStore({ client: b.client });
    storeB.subscribe(() => {});
    h.socketOf(B_ID).emit(pushFrame("providers:update", SOME_CAPACITY));

    expect(storeB.get().capacity).toHaveLength(1);
    expect(storeA.get().capacity).toEqual([]);
  });

  it("a store built on A and awaiting a reply gets offline, and its update reaches nothing on B", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    const socketA = h.socketOf(A_ID);
    const storeA = createTopBarStore({ client: a.client });
    const updates: number[] = [];
    storeA.subscribe((view) => updates.push(view.waitingCount));
    const pending = a.client.call("sessions:list", []);

    await h.sessions.switchTo(B_ID);
    const b = await h.unlockCurrent("2");
    const storeB = createTopBarStore({ client: b.client });
    storeB.subscribe(() => {});
    answer(socketA, "sessions:list", [{ id: "s1", waiting: true }]);
    await settle();

    expect(await pending).toEqual(OFFLINE);
    expect(updates).toEqual([]);
    expect(storeB.get().waitingCount).toBe(0);
  });

  it("a refresh in flight on A completes during quiesce, and the rotated token lands under A's key", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    const socketA = h.socketOf(A_ID);
    h.events.length = 0;
    void a.authSession.storagePolicyChanged();
    await settle();
    expect(requestsOn(socketA, "auth:refresh")).toHaveLength(1);

    const switching = h.sessions.switchTo(B_ID);
    await settle();
    expect(h.events).toEqual([`quiesce ${A_ID}`]);

    const rotated = tokenReply("3", h.clock.now() + ACCESS_TTL_MS);
    answer(socketA, "auth:refresh", rotated);
    expect(await switching).toBe("switched");

    expect(h.refresh.values.get(refreshKeyOf(A_ID))).toBe(rotated.refreshToken);
    expect(h.refresh.values.get(refreshKeyOf(B_ID))).toBe(refreshTokenOf(B_ID));
  });

  it("quiesce gives up at 3 s and the switch continues", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    h.events.length = 0;
    void a.authSession.storagePolicyChanged();
    await settle();

    const switching = h.sessions.switchTo(B_ID);
    await settle();
    h.clock.advance(2_999);
    await settle();
    expect(h.events).toEqual([`quiesce ${A_ID}`]);

    h.clock.advance(1);
    expect(await switching).toBe("switched");
    expect(h.sessions.current().id).toBe(B_ID);
  });

  it("a biometric pass after the switch sends no auth:refresh and leaves A's stored token unchanged", async () => {
    const h = machinesHarness();
    const a = await h.start();
    const socketA = h.socketOf(A_ID);
    welcome(socketA);
    const owner = deferred<boolean>();
    h.device.answer = owner.promise;
    const unlocking = a.authSession.unlockWithStoredRefresh();
    await settle();
    expect(h.device.prompts).toBe(1);

    await h.sessions.switchTo(B_ID);
    owner.resolve(true);

    expect(await unlocking).toBe("offline");
    expect(requestsOn(socketA, "auth:refresh")).toEqual([]);
    expect(h.refresh.values.get(refreshKeyOf(A_ID))).toBe(refreshTokenOf(A_ID));
    expect(requestsOn(h.socketOf(B_ID), "auth:refresh")).toEqual([]);
  });
});

describe("switching more than once", () => {
  it('two quick switches: only the last connects and the first answers "superseded"', async () => {
    const h = machinesHarness();
    await h.start();
    const first = h.sessions.switchTo(B_ID);
    const second = h.sessions.switchTo(C_ID);

    expect(await first).toBe("superseded");
    expect(await second).toBe("switched");
    expect(h.sessions.current().id).toBe(C_ID);
    expect(h.socketsOf(B_ID)).toEqual([]);
    expect(h.socketsOf(C_ID)).toHaveLength(1);
    expect(h.store.activeId()).toBe(C_ID);
  });

  it("a switch past the disconnect, then a switch back: the old machine connects again and the middle one never does", async () => {
    const h = machinesHarness();
    await h.start();
    const write = deferred<void>();
    const original = h.secure.set.bind(h.secure);
    let held = false;
    h.secure.set = async (key, value) => {
      if (key === MACHINE_INDEX_KEY && !held) {
        held = true;
        await write.promise;
      }
      return original(key, value);
    };

    const toB = h.sessions.switchTo(B_ID);
    await settle();
    expect(h.events).toContain(`disconnect ${A_ID}`);
    const backToA = h.sessions.switchTo(A_ID);
    await settle();
    write.resolve();

    expect(await toB).toBe("superseded");
    expect(await backToA).toBe("switched");
    expect(h.sessions.current().id).toBe(A_ID);
    expect(h.socketsOf(A_ID)).toHaveLength(2);
    expect(h.socketsOf(B_ID)).toEqual([]);
    expect(h.store.activeId()).toBe(A_ID);
  });

  it("A to B to A reuses A's scope with its tokens and needs no device-owner prompt", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    const stored = h.refresh.values.get(refreshKeyOf(A_ID));
    const builds = h.built.length;

    await h.sessions.switchTo(B_ID);
    await h.sessions.switchTo(A_ID);

    const back = h.sessions.current();
    expect(back.client).toBe(a.client);
    expect(back.authSession).toBe(a.authSession);
    expect(back.connectionStore).toBe(a.connectionStore);
    expect(h.built.filter((id) => id === A_ID)).toHaveLength(1);
    expect(h.built.length).toBe(builds + 1);

    const socket = h.socketOf(A_ID);
    welcome(socket);
    await settle();
    expect(requestsOn(socket, "auth:resume")).toHaveLength(1);
    answer(socket, "auth:resume", { locked: false, hasPasskeys: false });
    await settle();
    expect(back.client.state()).toBe("open");
    expect(h.device.prompts).toBe(0);
    expect(h.refresh.values.get(refreshKeyOf(A_ID))).toBe(stored);
  });

  it("an inactive machine's idle lock still fires", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    await h.sessions.switchTo(B_ID);

    h.clock.advance(IDLE_MS);
    await settle();

    expect(a.authSession.get().lockedLocally).toBe(true);
    expect(a.authSession.get().lockCause).toBe("idle");
    expect(h.sessions.current().authSession.get().lockedLocally).toBe(false);
  });
});

describe("the idle preference", () => {
  it("a shortened window reaches a machine that is not on screen", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    await h.sessions.switchTo(B_ID);

    h.sessions.setIdleMs(IDLE_MS / 3);
    h.clock.advance(IDLE_MS / 3);
    await settle();

    expect(a.authSession.get().lockedLocally).toBe(true);
    expect(a.authSession.get().lockCause).toBe("idle");
  });

  it("reaches the machine on screen", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();

    h.sessions.setIdleMs(IDLE_MS / 3);
    h.clock.advance(IDLE_MS / 3);
    await settle();

    expect(a.authSession.get().lockCause).toBe("idle");
  });

  it("a scope built later takes the window last set", async () => {
    const h = machinesHarness();
    await h.start();
    h.sessions.setIdleMs(IDLE_MS / 3);
    await h.sessions.switchTo(B_ID);
    const b = await h.unlockCurrent();

    h.clock.advance(IDLE_MS / 3);
    await settle();

    expect(b.authSession.get().lockCause).toBe("idle");
  });
});

describe("a switch that cannot happen", () => {
  it('a scope that cannot be built: "unknown", logged, and the switching mark cleared', async () => {
    const h = machinesHarness();
    const a = await h.start();
    const { refreshKey } = h.store;
    h.store.refreshKey = () => {
      throw new Error("machines: store is not open");
    };

    expect(await h.sessions.switchTo(B_ID)).toBe("unknown");

    expect(h.events).toContain("abandoned");
    expect(h.logs).toContain("machines: publishing the next machine failed");
    expect(h.sessions.current().client).toBe(a.client);

    // The banner's retry brings back the machine on screen.
    h.store.refreshKey = refreshKey;
    expect(a.client.state()).toBe("closed");
    expect(await h.sessions.reconnect()).toBe("connected");
    expect(h.sessions.current().client).toBe(a.client);
    expect(a.client.state()).not.toBe("closed");
  });

  it('a machine removed during the wait: "unknown", abandoned, and neither built nor connected', async () => {
    const h = machinesHarness();
    const a = await h.start();
    const holding = deferred<void>();
    a.authSession.quiesce = () => holding.promise;

    // The switch's read lands before the removal, the rest of it after.
    const switching = h.sessions.switchTo(B_ID);
    const forgetting = h.sessions.forget(B_ID, "unpair");
    await settle();
    expect(h.store.has(B_ID)).toBe(false);
    holding.resolve();

    expect(await switching).toBe("unknown");

    expect(h.events).toContain("abandoned");
    expect(h.built).not.toContain(B_ID);
    expect(h.socketsOf(B_ID)).toHaveLength(0);
    expect(h.sessions.current().id).toBe(A_ID);
    expect(await forgetting).toEqual({ kind: "next", id: A_ID });
    expect(h.logs).toContain("machines: the next machine went during the switch");
    // The banner's retry brings back the machine on screen.
    expect(await h.sessions.reconnect()).toBe("connected");
    expect(h.sessions.current().client).toBe(a.client);
  });

  it("a switch that goes through never reports abandoned", async () => {
    const h = machinesHarness();
    await h.start();
    await h.sessions.switchTo(B_ID);
    expect(h.events).not.toContain("abandoned");
  });

  it('an unknown id: "unknown", the old machine stays connected', async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();

    expect(await h.sessions.switchTo("nobody_1")).toBe("unknown");

    expect(h.events).toEqual([]);
    expect(h.sessions.current().client).toBe(a.client);
    expect(a.client.state()).toBe("open");
  });

  it("an unknown id does not supersede a switch in flight", async () => {
    const h = machinesHarness();
    await h.start();
    const switching = h.sessions.switchTo(B_ID);
    expect(await h.sessions.switchTo("nobody_1")).toBe("unknown");
    expect(await switching).toBe("switched");
  });

  it('a record gone at the switch: "unknown", the old machine stays connected, the index healed', async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    h.secure.values.delete(`jarvis.m.${B_ID}.pairing`);

    expect(await h.sessions.switchTo(B_ID)).toBe("unknown");

    expect(a.client.state()).toBe("open");
    expect(h.sessions.current().id).toBe(A_ID);
    expect(h.events).toEqual([]);
    expect((await h.store.list()).map((entry) => entry.id)).toEqual([A_ID, C_ID]);
  });

  it('a keychain read failing at the switch: "unknown", the old machine stays connected', async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    h.secure.failGet = (key) => key === `jarvis.m.${B_ID}.pairing`;

    expect(await h.sessions.switchTo(B_ID)).toBe("unknown");

    expect(a.client.state()).toBe("open");
  });

  it("a failed setActive still switches, and later connects stay on the new machine", async () => {
    const h = machinesHarness();
    await h.start();
    h.secure.failSet = (key) => key === MACHINE_INDEX_KEY;

    expect(await h.sessions.switchTo(B_ID)).toBe("switched");

    expect(h.sessions.current().id).toBe(B_ID);
    expect(h.socketsOf(B_ID)).toHaveLength(1);
    const sockets = h.socketsOf(A_ID).length;
    expect(await h.sessions.reconnect()).toBe("connected");
    expect(h.socketsOf(A_ID)).toHaveLength(sockets);
    expect(h.sessions.current().id).toBe(B_ID);
  });
});

describe("the clearing guard", () => {
  it("clearing A does not refuse connecting B", async () => {
    const h = machinesHarness();
    await h.start();
    setClearingPairing(A_ID, true);
    try {
      expect(await h.sessions.switchTo(B_ID)).toBe("switched");
      expect(h.socketsOf(B_ID)).toHaveLength(1);
    } finally {
      setClearingPairing(A_ID, false);
    }
  });

  it("clearing B refuses connecting B", async () => {
    const h = machinesHarness();
    await h.start();
    setClearingPairing(B_ID, true);
    try {
      expect(await h.sessions.switchTo(B_ID)).toBe("switched");
      expect(h.socketsOf(B_ID)).toEqual([]);
      expect(await h.sessions.reconnect()).toBe("unpaired");
      expect(h.socketsOf(B_ID)).toEqual([]);
    } finally {
      setClearingPairing(B_ID, false);
    }
  });
});

describe("start", () => {
  it("refused by the route it landed on: nothing connects, and a later reconnect does", async () => {
    const h = machinesHarness();

    expect(await h.sessions.start(undefined, () => false)).toBe("unpaired");

    expect(h.transport.sockets).toHaveLength(0);
    expect(h.sessions.current().id).toBeNull();
    expect(await h.sessions.reconnect()).toBe("connected");
    expect(h.sessions.current().id).toBe(A_ID);
  });

  it("connects the last active machine", async () => {
    const h = machinesHarness({ active: C_ID });
    expect(await h.sessions.start()).toBe("connected");
    expect(h.sessions.current().id).toBe(C_ID);
    expect(h.socketsOf(C_ID)).toHaveLength(1);
    expect(h.socketsOf(A_ID)).toEqual([]);
  });

  it("start(preferred) connects that one and never the other", async () => {
    const h = machinesHarness({ active: C_ID });
    expect(await h.sessions.start(B_ID)).toBe("connected");
    expect(h.sessions.current().id).toBe(B_ID);
    expect(h.socketsOf(B_ID)).toHaveLength(1);
    expect(h.socketsOf(C_ID)).toEqual([]);
    expect(h.built).not.toContain(C_ID);
    expect(h.store.activeId()).toBe(B_ID);
  });

  it("start(preferred) with a machine no longer held connects the last active one", async () => {
    const h = machinesHarness({ active: C_ID });
    expect(await h.sessions.start("nobody_1")).toBe("connected");
    expect(h.sessions.current().id).toBe(C_ID);
  });

  it('no machines: "unpaired", with a scope whose id is null, and nothing connects', async () => {
    const h = machinesHarness({ ids: [] });
    expect(await h.sessions.start()).toBe("unpaired");
    expect(h.sessions.current().id).toBeNull();
    expect(h.transport.sockets).toEqual([]);
  });

  it('a store that cannot open: "failed", with a scope whose id is null', async () => {
    const h = machinesHarness();
    h.secure.failGet = (key) => key === MACHINE_INDEX_KEY;
    expect(await h.sessions.start()).toBe("failed");
    expect(h.sessions.current().id).toBeNull();
    expect(h.transport.sockets).toEqual([]);
  });
});

describe("reconnect", () => {
  it("connects a machine added since, in a scope of its own", async () => {
    const h = machinesHarness({ ids: [] });
    await h.sessions.start();
    const none = h.sessions.current();

    await h.store.add(recordOf(B_ID), { deviceId: recordOf(B_ID).deviceId, token: "T".repeat(43) });
    expect(await h.sessions.reconnect()).toBe("connected");

    const b = h.sessions.current();
    expect(b.id).toBe(B_ID);
    expect(b.generation).toBeGreaterThan(none.generation);
    expect(b.client).not.toBe(none.client);
    expect(h.socketsOf(B_ID)).toHaveLength(1);
  });

  it("recovers after a failed open", async () => {
    const h = machinesHarness();
    h.secure.failGet = () => true;
    expect(await h.sessions.start()).toBe("failed");

    h.secure.failGet = undefined;
    expect(await h.sessions.reconnect()).toBe("connected");
    expect(h.sessions.current().id).toBe(A_ID);
  });

  it("a read in flight when a switch starts connects the old client never, and answers for the new machine", async () => {
    const h = machinesHarness();
    await h.start();
    const a = h.sessions.current();
    a.client.disconnect();
    h.events.length = 0;
    const read = deferred<void>();
    const original = h.secure.get.bind(h.secure);
    h.secure.get = async (key) => {
      if (key === "jarvis.pairing") await read.promise;
      return original(key);
    };

    const reconnecting = h.sessions.reconnect();
    await settle();
    h.secure.get = original;
    const switching = h.sessions.switchTo(B_ID);
    await settle();
    read.resolve();

    expect(await switching).toBe("switched");
    expect(await reconnecting).toBe("connected");
    expect(h.events).not.toContain(`connect ${A_ID}`);
    expect(h.socketsOf(A_ID)).toHaveLength(1);
    expect(h.sessions.current().id).toBe(B_ID);
  });

  it("a reconnect arriving during a switch waits for it, so the old client never comes back", async () => {
    const h = machinesHarness();
    await h.start();
    const write = deferred<void>();
    const original = h.secure.set.bind(h.secure);
    h.secure.set = async (key, value) => {
      if (key === MACHINE_INDEX_KEY) await write.promise;
      return original(key, value);
    };

    const switching = h.sessions.switchTo(B_ID);
    await settle();
    expect(h.events).toContain(`disconnect ${A_ID}`);
    const reconnecting = h.sessions.reconnect();
    await settle();
    expect(h.socketsOf(A_ID)).toHaveLength(1);

    write.resolve();
    expect(await switching).toBe("switched");
    expect(await reconnecting).toBe("connected");
    expect(h.socketsOf(A_ID)).toHaveLength(1);
    expect(h.socketsOf(B_ID)).toHaveLength(1);
  });

  it("the caller's own refusal stops the connect", async () => {
    const h = machinesHarness();
    await h.start();
    const a = h.sessions.current();
    a.client.disconnect();
    expect(await h.sessions.reconnect(() => false)).toBe("unpaired");
    expect(h.socketsOf(A_ID)).toHaveLength(1);
  });
});

describe("setAppActive", () => {
  it("reaches only the active scope, and is applied on activating another", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    const b = await (async () => {
      await h.sessions.switchTo(B_ID);
      return h.sessions.current();
    })();
    const onA = vi.spyOn(a.client, "setAppActive");
    const onASession = vi.spyOn(a.authSession, "setAppActive");
    const onB = vi.spyOn(b.client, "setAppActive");
    const onBSession = vi.spyOn(b.authSession, "setAppActive");

    h.sessions.setAppActive(false);
    expect(onB).toHaveBeenCalledExactlyOnceWith(false);
    expect(onBSession).toHaveBeenCalledExactlyOnceWith(false);
    expect(onA).not.toHaveBeenCalled();
    expect(onASession).not.toHaveBeenCalled();

    await h.sessions.switchTo(A_ID);
    expect(onA).toHaveBeenCalledExactlyOnceWith(false);
    expect(onASession).toHaveBeenCalledExactlyOnceWith(false);

    h.sessions.setAppActive(true);
    expect(onA).toHaveBeenLastCalledWith(true);
    expect(onB).toHaveBeenCalledTimes(1);
  });

  it("answers whether the app is active, and tells a listener only of a change", () => {
    const h = machinesHarness();
    const heard: boolean[] = [];
    const leave = h.sessions.subscribeAppActive((active) => heard.push(active));
    expect(h.sessions.isAppActive()).toBe(true);

    h.sessions.setAppActive(true);
    expect(heard).toEqual([]);

    h.sessions.setAppActive(false);
    h.sessions.setAppActive(false);
    expect(h.sessions.isAppActive()).toBe(false);
    expect(heard).toEqual([false]);

    leave();
    h.sessions.setAppActive(true);
    expect(h.sessions.isAppActive()).toBe(true);
    expect(heard).toEqual([false]);
  });

  it("the session hears of a return before the client, and of a suspend after it", async () => {
    const h = machinesHarness();
    const a = await h.start();
    const order: string[] = [];
    vi.spyOn(a.client, "setAppActive").mockImplementation(() => void order.push("client"));
    vi.spyOn(a.authSession, "setAppActive").mockImplementation(() => void order.push("session"));

    h.sessions.setAppActive(true);
    expect(order).toEqual(["session", "client"]);
    order.length = 0;
    h.sessions.setAppActive(false);
    expect(order).toEqual(["client", "session"]);
  });

  it("is applied to a scope activated by start", async () => {
    const h = machinesHarness();
    h.sessions.setAppActive(false);
    await h.sessions.start();
    const scope = h.sessions.current();
    const socket = h.socketOf(A_ID);
    welcome(socket);
    scope.client.subscribe("metrics:update");
    scope.client.unlock();
    expect(socket.sent.join("")).not.toContain('"sub"');
  });
});

describe("each scope's key and flag are fixed when it is built", () => {
  it("logins and rotations land under that machine's key and flag", async () => {
    const h = machinesHarness();
    await h.start();
    await h.sessions.switchTo(B_ID);
    await h.unlockCurrent("2");

    const reply = tokenReply("2", 0);
    expect(h.refresh.values.get(refreshKeyOf(B_ID))).toBe(reply.refreshToken);
    expect(h.refresh.values.get(refreshKeyOf(A_ID))).toBe(refreshTokenOf(A_ID));
    expect(h.refresh.values.get(refreshKeyOf(C_ID))).toBe(refreshTokenOf(C_ID));
  });

  it("a late write lands under its own machine after a switch", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();
    await h.sessions.switchTo(B_ID);
    const b = h.sessions.current();
    await a.authSession.logout();

    expect(h.refresh.values.has(refreshKeyOf(A_ID))).toBe(false);
    expect(h.refresh.values.get(refreshKeyOf(B_ID))).toBe(refreshTokenOf(B_ID));
    expect((await flagsOf(h.prefs)).refreshTokenStored).toBe(false);
    expect((await flagsOf(h.prefs)).machineFlags?.[B_ID]?.refreshTokenStored).toBe(true);
    expect(b.authSession.get().lockedLocally).toBe(false);
  });
});

describe("forget", () => {
  function expectOnlyAGone(
    h: ReturnType<typeof machinesHarness>,
    flags: Awaited<ReturnType<typeof flagsOf>>,
  ) {
    expect(h.refresh.values.has(refreshKeyOf(A_ID))).toBe(false);
    expect(h.secure.values.has("jarvis.token")).toBe(false);
    expect(h.refresh.values.get(refreshKeyOf(B_ID))).toBe(refreshTokenOf(B_ID));
    expect(h.secure.values.has(`jarvis.m.${B_ID}.token`)).toBe(true);
    expect(flags.refreshTokenStored).toBe(false);
    expect(flags.machineFlags?.[B_ID]?.refreshTokenStored).toBe(true);
    expect(flags.machineFlags?.[A_ID]).toBeUndefined();
  }

  function revoke(h: ReturnType<typeof machinesHarness>, id: string) {
    h.socketOf(id).emit({ kind: "close", code: CLOSE.revoked, reason: "" });
  }

  /** What a pair-again or an unpair does with its answer. */
  function apply(
    h: ReturnType<typeof machinesHarness>,
    id: string | null,
    cause: "revoked" | "unpair" | "pair-again",
    outcome: ForgetOutcome,
  ) {
    applyForgetOutcome({
      id,
      cause,
      outcome,
      sessions: h.sessions,
      gate: h.gate,
      navigateToPair: () => h.routes.push("/pair"),
      noticeRemoved: () => h.notices.push(String(id)),
    });
  }

  describe("revoked", () => {
    it("active with one other: its keys are gone, the other's stay, the other connects, the notice names it", async () => {
      const h = machinesHarness({ ids: [A_ID, B_ID] });
      await h.start();
      await h.unlockCurrent();
      revoke(h, A_ID);
      await settle();

      expectOnlyAGone(h, await flagsOf(h.prefs));
      expect(h.store.has(A_ID)).toBe(false);
      expect(h.sessions.current().id).toBe(B_ID);
      expect(h.store.activeId()).toBe(B_ID);
      expect(h.socketsOf(B_ID)).toHaveLength(1);
      expect(h.notices).toEqual(["192.168.1.5"]);
      expect(h.routes).toEqual([]);
    });

    it("active alone: /pair, the index empty, the null scope published", async () => {
      const h = machinesHarness({ ids: [A_ID] });
      const a = await h.start();
      await h.unlockCurrent();
      revoke(h, A_ID);
      await settle();

      expect(h.routes).toEqual(["/pair"]);
      expect(h.notices).toEqual([]);
      expect(await h.store.list()).toEqual([]);
      expect(h.sessions.current().id).toBeNull();
      expect(a.connectionStore.isDisposed()).toBe(true);
    });

    it("two in a row end on the third, each named", async () => {
      const h = machinesHarness();
      await h.start();
      welcome(h.socketOf(A_ID));
      revoke(h, A_ID);
      await settle();
      expect(h.sessions.current().id).toBe(B_ID);

      welcome(h.socketOf(B_ID));
      revoke(h, B_ID);
      await settle();

      expect(h.sessions.current().id).toBe(C_ID);
      expect(h.socketsOf(C_ID)).toHaveLength(1);
      expect(await h.store.list()).toHaveLength(1);
      expect(h.refresh.values.get(refreshKeyOf(C_ID))).toBe(refreshTokenOf(C_ID));
      expect(h.notices).toEqual(["192.168.1.5", "mac"]);
      expect(h.routes).toEqual([]);
    });

    it("while inactive: discovered on activating it, and takes the same path", async () => {
      const h = machinesHarness();
      await h.start();
      await h.sessions.switchTo(B_ID);
      expect(h.store.has(B_ID)).toBe(true);

      welcome(h.socketOf(B_ID));
      revoke(h, B_ID);
      await settle();

      expect(h.store.has(B_ID)).toBe(false);
      expect(h.sessions.current().id).toBe(A_ID);
      expect(h.notices).toEqual(["mac"]);
      expect(h.routes).toEqual([]);
    });
  });

  describe("the notice's label", () => {
    const base = recordOf(A_ID);

    it("is the laptop's name first", () => {
      expect(machineLabel({ ...base, laptopName: "Studio", name: "mac.tail.ts.net" })).toBe(
        "Studio",
      );
    });

    it("then the first DNS label of the name", () => {
      expect(machineLabel({ ...base, name: "mac.tail.ts.net" })).toBe("mac");
    });

    it("then the host", () => {
      expect(machineLabel(base)).toBe("192.168.1.5");
    });
  });

  it("unpair with one other: stays on the other with no notice", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();

    const outcome = await h.sessions.forget(A_ID, "unpair");
    apply(h, A_ID, "unpair", outcome);

    expect(outcome).toEqual({ kind: "next", id: B_ID });
    expect(h.sessions.current().id).toBe(B_ID);
    expect(h.socketsOf(B_ID)).toHaveLength(1);
    expect(h.routes).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("pair-again with one other: only that machine cleared, route /pair, the other active", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();

    const outcome = await h.sessions.forget(A_ID, "pair-again");
    apply(h, A_ID, "pair-again", outcome);

    expectOnlyAGone(h, await flagsOf(h.prefs));
    expect(h.routes).toEqual(["/pair"]);
    expect(h.notices).toEqual([]);
    expect(h.sessions.current().id).toBe(B_ID);
    expect(h.store.activeId()).toBe(B_ID);
  });

  it("switches in the Task 3 order, with no disconnect of the removed client beyond its own", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();

    await h.sessions.forget(A_ID, "unpair");

    expect(h.events).toEqual([
      "disconnect 192.168.1.5_4317",
      "quiesce 192.168.1.5_4317",
      "prepare",
      `setActive ${B_ID}`,
      `publish ${B_ID}`,
      `disconnect ${B_ID}`,
      `connect ${B_ID}`,
    ]);
  });

  it("no machine left: no switch is prepared", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();

    expect(await h.sessions.forget(A_ID, "unpair")).toEqual({ kind: "none" });

    expect(h.events).toEqual(["disconnect 192.168.1.5_4317", "publish null"]);
  });

  it("the next machine's record has gone: it is healed away and the one after it taken", async () => {
    const h = machinesHarness();
    await h.start();
    h.secure.values.delete(`jarvis.m.${B_ID}.pairing`);

    expect(await h.sessions.forget(A_ID, "unpair")).toEqual({ kind: "next", id: C_ID });

    expect(h.sessions.current().id).toBe(C_ID);
    expect(h.store.has(B_ID)).toBe(false);
  });

  it("the clearing guard is up from the start to the removal, and down by the switch", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();
    const seen: boolean[] = [];
    h.setPrepareSwitch(() => seen.push(isClearingPairing(A_ID)));

    const forgetting = h.sessions.forget(A_ID, "unpair");
    expect(isClearingPairing(A_ID)).toBe(true);
    await forgetting;

    expect(seen).toEqual([false]);
    expect(isClearingPairing(A_ID)).toBe(false);
  });

  describe("a failed clear", () => {
    function failingEveryDelete(h: ReturnType<typeof machinesHarness>) {
      takeClearFailedSignal();
      h.secure.failDelete = () => true;
    }

    it("keeps the machine and routes to clearFailed with its id", async () => {
      const h = machinesHarness({ ids: [A_ID, B_ID] });
      await h.start();
      failingEveryDelete(h);
      revoke(h, A_ID);
      await settle();

      expect(takeClearFailedSignal()).toEqual({ id: A_ID });
      expect(h.store.has(A_ID)).toBe(true);
      expect(h.sessions.current().id).toBe(A_ID);
      expect(h.routes).toEqual(["/pair"]);
      expect(h.notices).toEqual([]);
      expect(isClearingPairing(A_ID)).toBe(false);
    });

    it("answers clearFailed for one key's delete only when both fail", async () => {
      const h = machinesHarness({ ids: [A_ID, B_ID] });
      await h.start();
      takeClearFailedSignal();
      h.secure.failDelete = (key) => key === "jarvis.token";

      expect(await h.sessions.forget(A_ID, "unpair")).toEqual({ kind: "next", id: B_ID });

      expect(takeClearFailedSignal()).toBeUndefined();
    });

    it("the retry on /pair removes that id only, and leaves no signal behind", async () => {
      const h = machinesHarness();
      await h.start();
      failingEveryDelete(h);
      revoke(h, A_ID);
      await settle();
      const signal = takeClearFailedSignal();
      expect(signal).toEqual({ id: A_ID });

      expect(await retryClear(h.sessions, signal?.id ?? null)).toBe("clearFailed");
      expect(takeClearFailedSignal()).toBeUndefined();
      expect(h.store.has(A_ID)).toBe(true);

      h.secure.failDelete = undefined;
      expect(await retryClear(h.sessions, signal?.id ?? null)).toEqual({ next: B_ID });

      expectOnlyAGone(h, await flagsOf(h.prefs));
      expect(h.store.has(C_ID)).toBe(true);
      expect(h.sessions.current().id).toBe(B_ID);
    });

    it("a retry that leaves no machine answers scan", async () => {
      const h = machinesHarness({ ids: [A_ID] });
      await h.start();
      takeClearFailedSignal();

      expect(await retryClear(h.sessions, A_ID)).toBe("scan");
      expect(h.sessions.current().id).toBeNull();
    });

    it("a retry that names the next machine when A's dead tree is still on screen: the screen can move it", async () => {
      const h = machinesHarness({ ids: [A_ID, B_ID] });
      await h.start();
      const bRecord = `jarvis.m.${B_ID}.pairing`;
      h.secure.failGet = (key) => key === bRecord;

      // The record went; the move onto B could not read B.
      expect(await retryClear(h.sessions, A_ID)).toEqual({ next: B_ID });
      expect(h.store.has(A_ID)).toBe(false);
      expect(h.sessions.current().id).toBe(A_ID);

      // What /pair does with that answer.
      h.secure.failGet = undefined;
      const left: string[] = [];
      await openHeldMachine(B_ID, {
        switchTo: h.sessions.switchTo,
        leave: () => left.push("leave"),
        failed: () => left.push("failed"),
        log: h.logs.push.bind(h.logs),
      });

      expect(left).toEqual(["leave"]);
      expect(h.sessions.current().id).toBe(B_ID);
      expect(h.socketsOf(B_ID)).toHaveLength(1);
    });

    it("a retry that succeeds takes a signal set behind /pair's back", async () => {
      const h = machinesHarness({ ids: [A_ID, B_ID] });
      await h.start();
      setClearFailedSignal(A_ID);

      expect(await retryClear(h.sessions, A_ID)).toEqual({ next: B_ID });

      expect(takeClearFailedSignal()).toBeUndefined();
    });

    it("a retry that succeeds leaves another machine's signal", async () => {
      const h = machinesHarness();
      await h.start();
      setClearFailedSignal(C_ID);

      expect(await retryClear(h.sessions, A_ID)).toEqual({ next: B_ID });

      expect(takeClearFailedSignal()).toEqual({ id: C_ID });
    });

    describe("the back button from a clear that keeps failing", () => {
      async function stuckOnA() {
        const h = machinesHarness({ ids: [A_ID, B_ID] });
        await h.start();
        takeClearFailedSignal();
        h.secure.failDelete = () => true;
        revoke(h, A_ID);
        await settle();
        const signal = clearFailedEntry(takeClearFailedSignal(), h.sessions.current().id);
        expect(signal).toEqual({ id: A_ID });
        const held = (await h.store.listReadable()).map((entry) => entry.id);
        const target = pairBackTarget({
          phaseKind: "clearFailed",
          onScreen: h.sessions.current().id,
          clearFailedId: signal?.id ?? null,
          held,
        });
        expect(target).toBe(B_ID);
        return h;
      }

      it("leaves A's reconnect loop for the other machine, and a relaunch lands there", async () => {
        const h = await stuckOnA();
        const aSockets = h.socketsOf(A_ID).length;
        const left: string[] = [];

        await openHeldMachine(B_ID, {
          switchTo: h.sessions.switchTo,
          leave: () => left.push("leave"),
          failed: () => left.push("failed"),
          log: h.logs.push.bind(h.logs),
        });
        h.clock.advance(10 * 60_000);
        await settle();

        expect(left).toEqual(["leave"]);
        expect(h.sessions.current().id).toBe(B_ID);
        expect(h.socketsOf(B_ID)).toHaveLength(1);
        expect(h.socketsOf(A_ID)).toHaveLength(aSockets);
        expect(h.store.has(A_ID)).toBe(true);

        const relaunched = createMachineStore({
          secure: h.secure,
          refresh: h.refresh,
          prefs: h.prefs,
          localeTag: "en-US",
          singleSlot: false,
          log: () => {},
        });
        await relaunched.open();
        expect(relaunched.activeId()).toBe(B_ID);
      });

      it("the next /pair visit shows no clear-failed phase for the machine moved past", async () => {
        const h = await stuckOnA();
        // A second failure, while /pair was up: its signal has nobody to take it.
        await h.sessions.forget(A_ID, "revoked");

        await h.sessions.switchTo(B_ID);

        expect(clearFailedEntry(takeClearFailedSignal(), h.sessions.current().id)).toBeUndefined();
        expect(entryPhaseKind(false)).toBe("checking");
      });
    });

    describe("the next /pair visit, after a revocation", () => {
      it("a machine added after the revocation shows no revoked text", async () => {
        takeRevokedSignal();
        const h = machinesHarness({ ids: [A_ID] });
        await h.start();
        const revokedOnTree: boolean[] = [];
        h.sessions.subscribe(() => revokedOnTree.push(takeRevokedSignal()));
        revoke(h, A_ID);
        await settle();
        expect(revokedOnTree).toEqual([true]);
        const nullView = h.sessions.current().connectionStore.get();
        expect(bannerModel(nullView, revokedOnTree[0])).toMatchObject({ key: "conn.unpaired" });

        await h.sessions.addAndSwitch(recordOf(B_ID), { deviceId: "b".repeat(32), token: "B" });

        expect(revokedOnTree).toEqual([true, false]);
        const scope = h.sessions.current();
        await h.unlockCurrent();
        expect(scope.id).toBe(B_ID);
        expect(bannerModel(scope.connectionStore.get(), revokedOnTree[1])).toBeUndefined();
      });

      it("a null scope that could not be built leaves no signal for the next machine's tree", async () => {
        takeRevokedSignal();
        const h = machinesHarness({ ids: [A_ID] });
        await h.start();
        h.failBuildingNullScope();
        revoke(h, A_ID);
        await settle();

        expect(takeRevokedSignal()).toBe(false);
      });
    });

    it("on a store that could not open: the machine stays, and it answers clearFailed", async () => {
      const h = machinesHarness();
      await h.start();
      takeClearFailedSignal();
      h.secure.failGet = (key) => key === MACHINE_INDEX_KEY;

      expect(await h.sessions.forget(A_ID, "unpair")).toEqual({ kind: "clearFailed" });

      expect(takeClearFailedSignal()).toEqual({ id: A_ID });
      expect(h.secure.values.has("jarvis.token")).toBe(true);
      expect(h.secure.values.has("jarvis.pairing")).toBe(true);
    });
  });

  describe("a second forget while one runs", () => {
    it("for the same id does nothing: one removal, one switch, one answer acted on", async () => {
      const h = machinesHarness({ ids: [A_ID, B_ID] });
      await h.start();
      const remove = h.store.remove;
      let removals = 0;
      h.store.remove = (id) => {
        removals += 1;
        return remove(id);
      };

      const first = h.sessions.forget(A_ID, "revoked");
      const second = h.sessions.forget(A_ID, "pair-again");
      const [one, two] = await Promise.all([first, second]);
      apply(h, A_ID, "revoked", one);
      apply(h, A_ID, "pair-again", two);

      expect(removals).toBe(1);
      expect(h.events.filter((event) => event === `publish ${B_ID}`)).toHaveLength(1);
      expect(h.routes).toEqual([]);
      expect(h.notices).toEqual([A_ID]);
    });

    it("for another id runs: the guard is per id", async () => {
      const h = machinesHarness();
      await h.start();

      const [one, two] = await Promise.all([
        h.sessions.forget(A_ID, "unpair"),
        h.sessions.forget(B_ID, "unpair"),
      ]);

      expect(h.store.has(A_ID)).toBe(false);
      expect(h.store.has(B_ID)).toBe(false);
      expect(h.sessions.current().id).toBe(C_ID);
      expect(one).toEqual({ kind: "next", id: C_ID });
      expect(two.kind).toBe("next");
    });

    it("once the first has ended, runs again", async () => {
      const h = machinesHarness({ ids: [A_ID] });
      await h.start();
      takeClearFailedSignal();
      h.secure.failDelete = () => true;
      expect((await h.sessions.forget(A_ID, "unpair")).kind).toBe("clearFailed");
      takeClearFailedSignal();

      h.secure.failDelete = undefined;
      expect((await h.sessions.forget(A_ID, "unpair")).kind).toBe("none");
    });
  });

  describe("a store that rejects where it never should", () => {
    it("forget still answers clearFailed, so nothing needs an inline error", async () => {
      const h = machinesHarness({ ids: [A_ID, B_ID] });
      await h.start();
      takeClearFailedSignal();
      h.store.open = () => Promise.reject(new Error("no"));

      expect(await h.sessions.forget(A_ID, "unpair")).toEqual({ kind: "clearFailed" });

      expect(takeClearFailedSignal()).toEqual({ id: A_ID });
      expect(isClearingPairing(A_ID)).toBe(false);
    });
  });

  describe("the reason on /pair", () => {
    /** The layout: each publish takes the signal, for the banner of the tree it
     *  brings. Returns what the banner on screen decides. */
    function watched(h: ReturnType<typeof machinesHarness>) {
      takeRevokedSignal();
      let revoked = false;
      h.sessions.subscribe(() => {
        revoked = takeRevokedSignal();
      });
      return () => bannerModel(h.sessions.current().connectionStore.get(), revoked);
    }

    it("revoked alone: the banner says why", async () => {
      const h = machinesHarness({ ids: [A_ID] });
      await h.start();
      const banner = watched(h);
      welcome(h.socketOf(A_ID));
      revoke(h, A_ID);
      await settle();

      expect(h.routes).toEqual(["/pair"]);
      expect(banner()?.key).toBe("conn.unpaired");
    });

    it.each(["unpair", "pair-again"] as const)("%s alone: nothing", async (cause) => {
      const h = machinesHarness({ ids: [A_ID] });
      await h.start();
      const banner = watched(h);

      expect(await h.sessions.forget(A_ID, cause)).toEqual({ kind: "none" });

      expect(h.sessions.current().id).toBeNull();
      expect(banner()).toBeUndefined();
    });

    it("revoked with another machine: that one's notice, no signal", async () => {
      const h = machinesHarness({ ids: [A_ID, B_ID] });
      await h.start();
      takeRevokedSignal();
      welcome(h.socketOf(A_ID));
      revoke(h, A_ID);
      await settle();

      expect(h.notices).toHaveLength(1);
      expect(takeRevokedSignal()).toBe(false);
    });

    it("a revoked clear that failed: its own phase, no signal", async () => {
      const h = machinesHarness({ ids: [A_ID] });
      await h.start();
      takeRevokedSignal();
      takeClearFailedSignal();
      h.secure.failDelete = () => true;
      welcome(h.socketOf(A_ID));
      revoke(h, A_ID);
      await settle();

      expect(takeRevokedSignal()).toBe(false);
      takeClearFailedSignal();
    });

    it("the last of two revoked says why, and pairing again ends it", async () => {
      const h = machinesHarness({ ids: [A_ID, B_ID] });
      await h.start();
      const banner = watched(h);
      welcome(h.socketOf(A_ID));
      revoke(h, A_ID);
      await settle();
      expect(banner()).not.toEqual({ key: "conn.unpaired", pairAgain: false });

      welcome(h.socketOf(B_ID));
      revoke(h, B_ID);
      await settle();
      expect(banner()?.key).toBe("conn.unpaired");

      await h.store.add(recordOf(B_ID), {
        deviceId: recordOf(B_ID).deviceId,
        token: "N".repeat(43),
      });
      expect(await h.sessions.reconnect()).toBe("connected");
      expect(banner()?.key).not.toBe("conn.unpaired");
    });
  });

  describe("a route from the outcome goes through the gate and rechecks", () => {
    it("pair-again: held with no navigator, and dropped if another machine is on screen by then", async () => {
      const h = machinesHarness();
      await h.start();
      h.navigator.ready = false;
      const outcome = await h.sessions.forget(A_ID, "pair-again");
      apply(h, A_ID, "pair-again", outcome);
      expect(h.routes).toEqual([]);

      await h.sessions.switchTo(C_ID);
      h.navigator.ready = true;
      h.gate.flush();

      expect(h.routes).toEqual([]);
    });

    it("clearFailed: dropped if its machine has left the screen by then", async () => {
      const h = machinesHarness();
      await h.start();
      takeClearFailedSignal();
      h.secure.failDelete = () => true;
      h.navigator.ready = false;
      const outcome = await h.sessions.forget(A_ID, "unpair");
      apply(h, A_ID, "unpair", outcome);

      await h.sessions.switchTo(B_ID);
      h.navigator.ready = true;
      h.gate.flush();

      expect(h.routes).toEqual([]);
      // The signal went with the route: a later /pair must not name a machine
      // the user moved past.
      expect(takeClearFailedSignal()).toBeUndefined();
    });

    it("clearFailed dropped: another machine's failure, signalled since, is left alone", async () => {
      const h = machinesHarness();
      await h.start();
      takeClearFailedSignal();
      h.secure.failDelete = () => true;
      h.navigator.ready = false;
      const outcome = await h.sessions.forget(A_ID, "unpair");
      apply(h, A_ID, "unpair", outcome);
      await h.sessions.switchTo(B_ID);
      setClearFailedSignal(C_ID);

      h.navigator.ready = true;
      h.gate.flush();

      expect(takeClearFailedSignal()).toEqual({ id: C_ID });
    });

    it("clearFailed: a route that runs leaves the signal for /pair", async () => {
      const h = machinesHarness();
      await h.start();
      takeClearFailedSignal();
      h.secure.failDelete = () => true;
      const outcome = await h.sessions.forget(A_ID, "unpair");
      apply(h, A_ID, "unpair", outcome);

      expect(h.routes).toEqual(["/pair"]);
      expect(takeClearFailedSignal()).toEqual({ id: A_ID });
    });

    it("none: goes once the navigator is up, with nothing on screen", async () => {
      const h = machinesHarness({ ids: [A_ID] });
      await h.start();
      h.navigator.ready = false;
      const outcome = await h.sessions.forget(A_ID, "unpair");
      apply(h, A_ID, "unpair", outcome);
      expect(h.routes).toEqual([]);

      h.navigator.ready = true;
      h.gate.flush();

      expect(h.routes).toEqual(["/pair"]);
    });
  });

  describe("the store closing under the move off", () => {
    function closingUnderTheMove(h: ReturnType<typeof machinesHarness>) {
      h.store.nextAfter = () => {
        throw new Error("machines: store is not open");
      };
    }

    it("publishes the null scope, so /pair's route is not dropped", async () => {
      const h = machinesHarness({ ids: [A_ID, B_ID] });
      const a = await h.start();
      closingUnderTheMove(h);

      const outcome = await h.sessions.forget(A_ID, "unpair");
      apply(h, A_ID, "unpair", outcome);

      expect(outcome).toEqual({ kind: "none" });
      expect(h.sessions.current().id).toBeNull();
      expect(a.connectionStore.isDisposed()).toBe(true);
      expect(h.routes).toEqual(["/pair"]);
      expect(h.logs).toContain("machines: moving off a forgotten machine failed");
    });

    it("a revocation says why on /pair", async () => {
      const h = machinesHarness({ ids: [A_ID, B_ID] });
      await h.start();
      takeRevokedSignal();
      closingUnderTheMove(h);

      await h.sessions.forget(A_ID, "revoked");

      expect(takeRevokedSignal()).toBe(true);
    });

    it("a machine that reached the screen before the throw stays", async () => {
      const h = machinesHarness({ ids: [A_ID, B_ID] });
      await h.start();
      await h.sessions.switchTo(B_ID);
      const b = h.sessions.current();
      await h.sessions.switchTo(A_ID);
      // B is published by the move off, then its connect throws.
      b.client.connect = () => {
        throw new Error("no native module");
      };

      expect(await h.sessions.forget(A_ID, "unpair")).toEqual({ kind: "next", id: B_ID });

      expect(h.sessions.current().id).toBe(B_ID);
      expect(h.logs).toContain("machines: moving off a forgotten machine failed");
    });
  });

  it("the machine forgotten is off screen: no switch, and the one on screen stays", async () => {
    const h = machinesHarness();
    await h.start();
    await h.sessions.switchTo(B_ID);
    h.events.length = 0;

    expect(await h.sessions.forget(A_ID, "unpair")).toEqual({ kind: "next", id: B_ID });

    // Only its own client, closed already. B's is untouched.
    expect(h.events).toEqual([`disconnect ${A_ID}`]);
    expect(h.sessions.current().id).toBe(B_ID);
  });

  it("the machine's scope was never built: its keys go all the same", async () => {
    const h = machinesHarness();
    await h.start();

    expect(await h.sessions.forget(C_ID, "unpair")).toEqual({ kind: "next", id: A_ID });

    expect(h.store.has(C_ID)).toBe(false);
    expect(h.refresh.values.has(refreshKeyOf(C_ID))).toBe(false);
    expect(h.built).not.toContain(C_ID);
  });

  it("a removal of B: C's and A's refresh tokens stay", async () => {
    const h = machinesHarness({ active: B_ID });
    const b = await h.start();

    await h.sessions.forget(B_ID, "unpair");

    expect(h.refresh.values.has(refreshKeyOf(B_ID))).toBe(false);
    expect(h.refresh.values.get(refreshKeyOf(C_ID))).toBe(refreshTokenOf(C_ID));
    expect(h.refresh.values.get(refreshKeyOf(A_ID))).toBe(refreshTokenOf(A_ID));
    const flags = await flagsOf(h.prefs);
    expect(flags.refreshTokenStored).toBe(true);
    expect(flags.machineFlags?.[C_ID]?.refreshTokenStored).toBe(true);
    expect(flags.machineFlags?.[B_ID]).toBeUndefined();
    expect(b.authSession.get().lockedLocally).toBe(false);
  });

  it("a removal drops the tokens in memory too", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.unlockCurrent();

    await h.sessions.forget(A_ID, "unpair");
    h.clock.advance(ACCESS_TTL_MS);
    await settle();

    expect(requestsOn(h.socketOf(A_ID), "auth:refresh")).toEqual([]);
    expect(a.authSession.get().lockedLocally).toBe(false);
  });

  it("the removed machine's scope is disposed, and never reused", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    const a = await h.start();

    await h.sessions.forget(A_ID, "unpair");

    expect(a.connectionStore.isDisposed()).toBe(true);
  });

  it("the null scope's machine: nothing removed, and clearFailed on a store that could not open", async () => {
    const h = machinesHarness();
    await h.store.open();
    expect(await h.sessions.forget(null, "unpair")).toEqual({ kind: "none" });
    expect(h.secure.values.has("jarvis.token")).toBe(true);
    expect(h.refresh.values.has(refreshKeyOf(A_ID))).toBe(true);
    expect(h.published).toEqual([]);

    takeClearFailedSignal();
    h.secure.failGet = () => true;
    expect(await h.sessions.forget(null, "unpair")).toEqual({ kind: "clearFailed" });
    expect(takeClearFailedSignal()).toEqual({ id: null });
  });

  it("a removed machine paired again gets a new scope under its new keys", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    const a = await h.start();
    await h.sessions.forget(A_ID, "unpair");
    expect(h.sessions.current().id).toBeNull();
    expect(a.connectionStore.isDisposed()).toBe(true);

    await h.store.add(recordOf(A_ID), { deviceId: recordOf(A_ID).deviceId, token: "T".repeat(43) });
    await h.store.setActive(A_ID);
    expect(await h.sessions.reconnect()).toBe("connected");

    const again = h.sessions.current();
    expect(again.client).not.toBe(a.client);
    await h.unlockCurrent("4");
    expect(h.refresh.values.get(`jarvis.m.${A_ID}.refresh`)).toBe(tokenReply("4", 0).refreshToken);
    expect(h.refresh.values.has("jarvis.refresh")).toBe(false);
  });

  it("a machine healed away and paired again under other keys gets a new scope", async () => {
    const h = machinesHarness();
    const a = await h.start();
    h.secure.values.delete("jarvis.pairing");
    expect(await h.store.load(A_ID)).toBeUndefined();

    await h.store.add(recordOf(A_ID), { deviceId: recordOf(A_ID).deviceId, token: "T".repeat(43) });
    await h.store.setActive(A_ID);
    expect(await h.sessions.reconnect()).toBe("connected");

    expect(h.sessions.current().client).not.toBe(a.client);
    expect(a.client.state()).toBe("closed");
    await h.unlockCurrent("6");
    expect(h.refresh.values.get(`jarvis.m.${A_ID}.refresh`)).toBe(tokenReply("6", 0).refreshToken);
    expect(h.refresh.values.has("jarvis.refresh")).toBe(false);
  });

  describe("paired again at the same address, under the same key", () => {
    const newCredential = { deviceId: recordOf(B_ID).deviceId, token: "N".repeat(43) };

    /** B's scope, signed in, with B's record then found unusable. */
    async function bHealedAway() {
      const h = machinesHarness({ active: B_ID });
      const old = await h.start();
      await h.unlockCurrent("7");
      h.secure.values.delete(`jarvis.m.${B_ID}.pairing`);
      return { h, old };
    }

    function signedInSession(scope: MachineScope) {
      return scope.authSession.get().lockedLocally === false && scope.client.state() === "open";
    }

    it("a connect that finds the record gone drops the scope, so the next is new", async () => {
      const { h, old } = await bHealedAway();

      expect(await h.sessions.reconnect()).toBe("unpaired");
      await h.store.add(recordOf(B_ID), newCredential);

      expect(await h.sessions.switchTo(B_ID)).toBe("switched");

      expect(h.sessions.current().client).not.toBe(old.client);
      expect(h.sessions.current().authSession).not.toBe(old.authSession);
      expect(signedInSession(h.sessions.current())).toBe(false);
      expect(old.client.state()).toBe("closed");
    });

    it("a switch that finds the record gone drops the kept scope", async () => {
      const { h, old } = await bHealedAway();
      await h.sessions.switchTo(A_ID);
      h.secure.values.set(`jarvis.m.${B_ID}.pairing`, "");
      expect(await h.sessions.switchTo(B_ID)).toBe("unknown");

      await h.store.add(recordOf(B_ID), newCredential);
      expect(await h.sessions.switchTo(B_ID)).toBe("switched");

      expect(h.sessions.current().client).not.toBe(old.client);
      expect(h.sessions.current().authSession).not.toBe(old.authSession);
    });

    it("healed by a screen's own read, and the sessions never told: the new credential drops the scope", async () => {
      const { h, old } = await bHealedAway();
      expect(await h.store.load(B_ID)).toBeUndefined();
      await h.store.add(recordOf(B_ID), newCredential);

      expect(await h.sessions.reconnect()).toBe("connected");

      const next = h.sessions.current();
      expect(next.id).toBe(B_ID);
      expect(next.client).not.toBe(old.client);
      expect(next.authSession).not.toBe(old.authSession);
      expect(old.client.state()).toBe("closed");
      const socket = h.socketOf(B_ID);
      expect(socket.url).toContain("mac.tail.ts.net");
      welcome(socket);
      await settle();
      const sent = JSON.stringify(socket.sent);
      expect(sent).not.toContain(tokenReply("7", 0).accessToken);
      expect(sent).not.toContain(tokenReply("7", 0).refreshToken);
    });

    it("the same pairing again keeps its scope and its tokens", async () => {
      const h = machinesHarness({ active: B_ID });
      const b = await h.start();
      await h.sessions.switchTo(A_ID);
      await h.sessions.switchTo(B_ID);
      expect(h.sessions.current().client).toBe(b.client);
    });
  });

  it("a refused connect keeps the scope: the record is still there", async () => {
    const h = machinesHarness();
    const a = await h.start();
    expect(await h.sessions.reconnect(() => false)).toBe("unpaired");
    expect(await h.sessions.reconnect()).toBe("connected");
    expect(h.sessions.current().client).toBe(a.client);
  });

  it("the remaining machine connects next, in its own scope", async () => {
    const h = machinesHarness();
    await h.start();
    await h.sessions.forget(A_ID, "unpair");

    expect(await h.sessions.reconnect()).toBe("connected");

    expect(h.sessions.current().id).toBe(B_ID);
    expect(h.socketsOf(B_ID)).toHaveLength(1);
  });

  it("a revocation whose clear ends after a switch stays off the new machine's screen", async () => {
    const h = machinesHarness();
    await h.start();
    const clearing = deferred<void>();
    const handler = unpairedHandlerFor({
      id: A_ID,
      cause: "revoked",
      sessions: {
        current: () => h.sessions.current(),
        forget: async (id, cause) => {
          await clearing.promise;
          return h.sessions.forget(id, cause);
        },
      },
      loadRecord: async () => undefined,
      gate: h.gate,
      navigateToPair: () => h.routes.push("/pair"),
      noticeRemoved: (name) => h.notices.push(name),
      log: () => {},
    });

    const handled = handler();
    await h.sessions.switchTo(B_ID);
    clearing.resolve();
    await handled;

    expect(h.routes).toEqual([]);
    expect(h.sessions.current().id).toBe(B_ID);
    expect(h.refresh.values.has(refreshKeyOf(A_ID))).toBe(false);
    expect(h.refresh.values.get(refreshKeyOf(B_ID))).toBe(refreshTokenOf(B_ID));
  });

  it("a record that cannot be read still names the machine, from its id", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();
    const handler = unpairedHandlerFor({
      id: A_ID,
      cause: "revoked",
      sessions: h.sessions,
      loadRecord: async () => {
        throw new Error("keychain read failed");
      },
      gate: h.gate,
      navigateToPair: () => h.routes.push("/pair"),
      noticeRemoved: (name) => h.notices.push(name),
      log: () => {},
    });

    expect(await handler()).toBe("cleared");

    expect(h.notices).toEqual(["192.168.1.5"]);
  });
});

describe("the null scope", () => {
  async function unlockAnyway(h: ReturnType<typeof machinesHarness>, scope: MachineScope) {
    scope.client.connect(
      { host: "192.168.1.5", port: 4317, fingerprint: "f".repeat(64) },
      { deviceId: "d".repeat(32), token: "T".repeat(43) },
    );
    const socket = h.transport.sockets[h.transport.sockets.length - 1];
    if (socket === undefined) throw new Error("no socket");
    welcome(socket);
    const unlocking = scope.authSession.unlockWithPassword("pw");
    await settle();
    answer(socket, "auth:login", tokenReply("5", h.clock.now() + ACCESS_TTL_MS));
    await unlocking;
    await settle();
  }

  it("cannot write a refresh token anywhere, even handed a login", async () => {
    const h = machinesHarness({ ids: [] });
    await h.sessions.start();
    const before = h.prefs.text;

    await unlockAnyway(h, h.sessions.current());

    expect(h.refresh.sets).toEqual([]);
    expect([...h.refresh.values.keys()]).toEqual([]);
    expect(h.prefs.text).toBe(before);
  });

  it("cannot touch the legacy machine's token or flag before the store opens", async () => {
    const h = machinesHarness();
    const before = h.prefs.text;

    await unlockAnyway(h, h.sessions.current());

    expect(h.refresh.values.get(refreshKeyOf(A_ID))).toBe(refreshTokenOf(A_ID));
    expect(h.refresh.sets).toEqual([]);
    expect(h.prefs.text).toBe(before);
  });

  it("offers no stored token to unlock with, and raises no prompt", async () => {
    const h = machinesHarness();
    expect(await h.sessions.current().authSession.unlockWithStoredRefresh()).toBe(
      "no-stored-token",
    );
    expect(h.device.prompts).toBe(0);
  });

  it("is never connected by the sessions", async () => {
    const h = machinesHarness({ ids: [] });
    await h.sessions.start();
    await h.sessions.reconnect();
    expect(h.transport.sockets).toEqual([]);
  });
});

describe("logout or keep-signed-in off, with the store not open", () => {
  it("logout before any open takes the active machine's token off the disk", async () => {
    const h = machinesHarness({ active: B_ID });
    await h.sessions.current().authSession.logout();

    expect(h.refresh.values.has(refreshKeyOf(B_ID))).toBe(false);
    expect(h.refresh.values.get(refreshKeyOf(A_ID))).toBe(refreshTokenOf(A_ID));
  });

  it("logout after a failed open takes the legacy slot's token off the disk", async () => {
    const h = machinesHarness();
    h.secure.failGet = (key) => key === MACHINE_INDEX_KEY;
    expect(await h.sessions.start()).toBe("failed");

    await h.sessions.current().authSession.logout();

    expect(h.refresh.values.has(refreshKeyOf(A_ID))).toBe(false);
    expect(h.logs).not.toContain("auth: deleting the stored refresh token failed");
  });

  it("a logout after a failed open says it could not reach a machine's own token", async () => {
    const h = machinesHarness({ active: B_ID });
    h.secure.failGet = (key) => key === MACHINE_INDEX_KEY;
    expect(await h.sessions.start()).toBe("failed");

    await h.sessions.current().authSession.logout();

    expect(h.refresh.values.get(refreshKeyOf(B_ID))).toBe(refreshTokenOf(B_ID));
    expect(h.logs).toContain("machines: a logout with no open store reached the legacy token only");
    expect(JSON.stringify(h.logs)).not.toContain(refreshTokenOf(B_ID));
  });

  it("a logout with the store open says nothing of the kind", async () => {
    const h = machinesHarness({ active: B_ID });
    await h.sessions.current().authSession.logout();
    expect(h.logs).not.toContain(
      "machines: a logout with no open store reached the legacy token only",
    );
  });

  it("keep-signed-in off after a failed open takes the token off the disk", async () => {
    const h = machinesHarness();
    h.secure.failGet = (key) => key === MACHINE_INDEX_KEY;
    expect(await h.sessions.start()).toBe("failed");
    h.device.passcode = false;

    await h.sessions.current().authSession.storagePolicyChanged();

    expect(h.refresh.values.has(refreshKeyOf(A_ID))).toBe(false);
  });

  it.each([A_ID, B_ID])(
    "logout on %s after a later open failed still reaches its key",
    async (id) => {
      const h = machinesHarness({ active: id });
      const scope = await h.start();
      h.secure.failGet = (key) => key === MACHINE_INDEX_KEY;
      expect(await h.store.open()).toBe("failed");

      await scope.authSession.logout();

      expect(h.refresh.values.has(refreshKeyOf(id))).toBe(false);
      expect(h.logs).not.toContain("auth: deleting the stored refresh token failed");
    },
  );

  it.each([A_ID, B_ID])(
    "keep-signed-in off on %s after a later open failed still reaches its key",
    async (id) => {
      const h = machinesHarness({ active: id });
      const scope = await h.start();
      h.secure.failGet = (key) => key === MACHINE_INDEX_KEY;
      expect(await h.store.open()).toBe("failed");
      h.device.passcode = false;

      await scope.authSession.storagePolicyChanged();

      expect(h.refresh.values.has(refreshKeyOf(id))).toBe(false);
    },
  );

  it("an open store with no machine deletes nothing", async () => {
    const h = machinesHarness({ ids: [] });
    await h.sessions.start();
    h.refresh.values.set("something.else", "kept");

    await h.sessions.current().authSession.logout();

    expect(h.refresh.values.get("something.else")).toBe("kept");
  });
});

describe("prepareSwitchRoute", () => {
  const up = createNavigatorGate(() => true);
  up.setMounted(true);

  function router(options: { canDismiss?: boolean } = {}) {
    const calls: string[] = [];
    return {
      calls,
      canDismiss: () => options.canDismiss ?? true,
      dismissAll: () => void calls.push("dismissAll"),
      replace: (route: string) => void calls.push(`replace ${route}`),
    };
  }

  it("dismisses the stack, then goes to /dashboard", () => {
    const r = router();
    prepareSwitchRoute(r, up, () => {});
    expect(r.calls).toEqual(["dismissAll", "replace /dashboard"]);
  });

  it("with nothing to dismiss, as on /pair, only goes to /dashboard", () => {
    const r = router({ canDismiss: false });
    prepareSwitchRoute(r, up, () => {});
    expect(r.calls).toEqual(["replace /dashboard"]);
  });

  it("a router that throws all the same: logged, and never out of here", () => {
    const logs: string[] = [];
    const notMounted = {
      canDismiss: () => {
        throw new Error("before mounting");
      },
      dismissAll: () => {
        throw new Error("before mounting");
      },
      replace: () => {
        throw new Error("before mounting");
      },
    };
    expect(() => prepareSwitchRoute(notMounted, up, (line) => logs.push(line))).not.toThrow();
    expect(logs).toEqual(["machines: no navigator to prepare for the switch"]);
  });

  it("a dismiss that throws, as on /unlock, still reaches /dashboard", () => {
    const r = router();
    r.dismissAll = () => {
      throw new Error("no stack");
    };
    prepareSwitchRoute(r, up, () => {});
    expect(r.calls).toEqual(["replace /dashboard"]);
  });
});

describe("tapped notifications", () => {
  it("handled tap ids survive a change of scope", async () => {
    const h = machinesHarness();
    const a = await h.start();
    await h.sessions.switchTo(B_ID);
    const b = h.sessions.current();
    const handledIds = new Set<string>();
    const response = { id: "tap-1", data: { kind: "session-done", sessionId: "s1" } };
    const routes: string[] = [];
    const tapDeps = (scope: MachineScope) => ({
      client: scope.client,
      router: { push: (route: string) => routes.push(route) },
      handledIds,
      waitForOpen: async () => false,
    });
    await handleNotificationTap(tapDeps(a), response);
    const waited = vi.fn(async () => true);

    await handleNotificationTap({ ...tapDeps(b), waitForOpen: waited }, response);

    expect(waited).not.toHaveBeenCalled();
  });
});

describe("the clear-failed signal, through the sessions' handler", () => {
  it("carries the machine's id", async () => {
    takeClearFailedSignal();
    setClearFailedSignal(B_ID);
    expect(takeClearFailedSignal()).toEqual({ id: B_ID });
    expect(takeClearFailedSignal()).toBeUndefined();
  });

  it("a clearFailed route another route replaced in the gate drops its signal", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();
    takeClearFailedSignal();
    h.secure.failDelete = () => true;
    h.navigator.ready = false;
    h.socketOf(A_ID).emit({ kind: "close", code: CLOSE.revoked, reason: "" });
    await settle();
    expect(h.routes).toEqual([]);

    h.gate.navigate(() => h.routes.push("/unlock"));
    h.navigator.ready = true;
    h.gate.flush();

    expect(h.routes).toEqual(["/unlock"]);
    expect(takeClearFailedSignal()).toBeUndefined();
  });

  it("a clearFailed route that runs keeps its signal for /pair", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();
    takeClearFailedSignal();
    h.secure.failDelete = () => true;
    h.navigator.ready = false;
    h.socketOf(A_ID).emit({ kind: "close", code: CLOSE.revoked, reason: "" });
    await settle();

    h.navigator.ready = true;
    h.gate.flush();

    expect(h.routes).toEqual(["/pair"]);
    expect(takeClearFailedSignal()).toEqual({ id: A_ID });
  });
});

describe("addAndSwitch", () => {
  const CREDENTIAL = { deviceId: "b".repeat(32), token: "B".repeat(43) };

  function joinTokens(h: ReturnType<typeof machinesHarness>) {
    return tokenReply("7", h.clock.now() + ACCESS_TTL_MS);
  }

  it("the tokens are stored before anything connects", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    const seen: Array<string | undefined> = [];
    h.setPrepareSwitch(() => seen.push(h.refresh.values.get(refreshKeyOf(B_ID))));

    const id = await h.sessions.addAndSwitch(recordOf(B_ID), CREDENTIAL, joinTokens(h));

    expect(id).toBe(B_ID);
    expect(seen).toEqual([tokenReply("7", 0).refreshToken]);
    expect(h.sessions.current().id).toBe(B_ID);
    expect(h.store.activeId()).toBe(B_ID);
    expect(h.socketsOf(B_ID)).toHaveLength(1);
    expect(h.events).toContain("disconnect 192.168.1.5_4317");
  });

  it("after a join, the first locked welcome resumes with no unlock screen and no prompt", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    await h.sessions.addAndSwitch(recordOf(B_ID), CREDENTIAL, joinTokens(h));
    const scope = h.sessions.current();
    const socket = h.socketOf(B_ID);

    const shown: boolean[] = [];
    scope.authSession.subscribe((view) => {
      shown.push(shouldShowUnlock(scope.client.state(), view, "/dashboard"));
    });
    welcome(socket);
    await settle();

    expect(requestsOn(socket, "auth:resume")).toHaveLength(1);
    expect(requestsOn(socket, "auth:resume")[0]?.a).toEqual([
      { accessToken: tokenReply("7", 0).accessToken },
    ]);
    expect(shouldShowUnlock(scope.client.state(), scope.authSession.get(), "/dashboard")).toBe(
      false,
    );

    answer(socket, "auth:resume", { locked: false, hasPasskeys: false });
    await settle();

    expect(scope.client.state()).toBe("open");
    expect(shown).not.toContain(true);
    expect(shouldShowUnlock(scope.client.state(), scope.authSession.get(), "/dashboard")).toBe(
      false,
    );
    expect(h.device.prompts).toBe(0);
    expect(requestsOn(socket, "auth:login")).toEqual([]);
  });

  it("a phone with no passcode: the join still resumes, and nothing is on disk", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    h.device.passcode = false;

    await h.sessions.addAndSwitch(recordOf(B_ID), CREDENTIAL, joinTokens(h));
    const socket = h.socketOf(B_ID);
    welcome(socket);
    await settle();

    expect(h.refresh.values.has(refreshKeyOf(B_ID))).toBe(false);
    expect(requestsOn(socket, "auth:resume")).toHaveLength(1);
  });

  it("QR add: no tokens, so the unlock screen shows as today", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();

    await h.sessions.addAndSwitch(recordOf(B_ID), CREDENTIAL);
    const scope = h.sessions.current();
    const socket = h.socketOf(B_ID);
    welcome(socket);
    await settle();

    expect(scope.id).toBe(B_ID);
    expect(scope.client.state()).toBe("locked");
    expect(requestsOn(socket, "auth:resume")).toEqual([]);
    expect(h.refresh.values.has(refreshKeyOf(B_ID))).toBe(false);
    expect(shouldShowUnlock(scope.client.state(), scope.authSession.get(), "/dashboard")).toBe(
      true,
    );
  });

  it("the first machine on an empty phone: off the null scope and onto it", async () => {
    const h = machinesHarness({ ids: [] });
    await h.start();
    expect(h.sessions.current().id).toBeNull();

    await h.sessions.addAndSwitch(recordOf(B_ID), CREDENTIAL);

    expect(h.sessions.current().id).toBe(B_ID);
    expect(h.socketsOf(B_ID)).toHaveLength(1);
  });

  it("a held machine: the store refuses, and its record, tokens and session are untouched", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();
    await h.unlockCurrent();
    const scope = h.sessions.current();
    const secure = [...h.secure.values];
    const refresh = [...h.refresh.values];

    await expect(
      h.sessions.addAndSwitch(recordOf(A_ID), { deviceId: "a".repeat(32), token: "x" }),
    ).rejects.toBeInstanceOf(PairingAlreadyExistsError);

    expect([...h.secure.values]).toEqual(secure);
    expect([...h.refresh.values]).toEqual(refresh);
    expect(h.sessions.current()).toBe(scope);
    expect(scope.client.state()).toBe("open");
  });

  it("a keychain that refuses the save: nothing is seeded and nothing switches", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    h.secure.failSet = (key) => key.includes(B_ID);
    const built = h.built.length;

    await expect(
      h.sessions.addAndSwitch(recordOf(B_ID), CREDENTIAL, joinTokens(h)),
    ).rejects.toThrow();

    expect(h.built).toHaveLength(built);
    expect(h.refresh.values.has(refreshKeyOf(B_ID))).toBe(false);
    expect(h.sessions.current().id).toBe(A_ID);
    expect(h.store.activeId()).toBe(A_ID);
  });

  it("an old session at that address is not offered to the new pairing", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();
    await h.sessions.switchTo(B_ID);
    await h.unlockCurrent();
    const old = h.sessions.current();
    await h.sessions.switchTo(A_ID);
    // A store self-heal took B away with no word to the sessions.
    await h.realStore.remove(B_ID);

    await h.sessions.addAndSwitch(recordOf(B_ID), { deviceId: "9".repeat(32), token: "N" });

    const scope = h.sessions.current();
    expect(scope.id).toBe(B_ID);
    expect(scope.client).not.toBe(old.client);
    const socket = h.socketOf(B_ID);
    welcome(socket);
    await settle();
    expect(requestsOn(socket, "auth:resume")).toEqual([]);
    expect(requestsOn(socket, "auth:refresh")).toEqual([]);
  });

  it("no token reaches a log", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    const tokens = joinTokens(h);

    await h.sessions.addAndSwitch(recordOf(B_ID), CREDENTIAL, tokens);
    welcome(h.socketOf(B_ID));
    await settle();

    const logs = h.logs.join("\n");
    expect(logs).not.toContain(tokens.accessToken);
    expect(logs).not.toContain(tokens.refreshToken);
  });
});

describe("add", () => {
  const CREDENTIAL = { deviceId: "b".repeat(32), token: "B".repeat(43) };

  function joinTokens(h: ReturnType<typeof machinesHarness>) {
    return tokenReply("7", h.clock.now() + ACCESS_TTL_MS);
  }

  it("stores and seeds, and the machine on screen does not notice", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    await h.unlockCurrent();
    const scope = h.sessions.current();
    const published: unknown[] = [];
    h.sessions.subscribe((next) => published.push(next));
    const events = h.events.length;

    const id = await h.sessions.add(recordOf(B_ID), CREDENTIAL, joinTokens(h));

    expect(id).toBe(B_ID);
    expect(h.store.has(B_ID)).toBe(true);
    expect(h.refresh.values.get(refreshKeyOf(B_ID))).toBe(tokenReply("7", 0).refreshToken);
    expect(h.sessions.current()).toBe(scope);
    expect(scope.client.state()).toBe("open");
    expect(h.store.activeId()).toBe(A_ID);
    expect(h.socketsOf(B_ID)).toEqual([]);
    expect(published).toEqual([]);
    expect(h.events.slice(events)).toEqual([]);
  });

  it("a later switch resumes with the kept tokens, with no unlock screen", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    await h.sessions.add(recordOf(B_ID), CREDENTIAL, joinTokens(h));

    await h.sessions.switchTo(B_ID);
    const socket = h.socketOf(B_ID);
    welcome(socket);
    await settle();

    expect(requestsOn(socket, "auth:resume")).toHaveLength(1);
    expect(h.device.prompts).toBe(0);
  });

  it("a QR pairing: nothing to seed, and the machine waits for its unlock screen", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    const built = h.built.length;

    await h.sessions.add(recordOf(B_ID), CREDENTIAL);

    expect(h.store.has(B_ID)).toBe(true);
    expect(h.built).toHaveLength(built);
    expect(h.refresh.values.has(refreshKeyOf(B_ID))).toBe(false);
    expect(h.sessions.current().id).toBe(A_ID);
  });

  it("a store that refuses: it rejects, and nothing is seeded", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    h.secure.failSet = (key) => key.includes(B_ID);
    const built = h.built.length;

    await expect(h.sessions.add(recordOf(B_ID), CREDENTIAL, joinTokens(h))).rejects.toThrow();

    expect(h.built).toHaveLength(built);
    expect(h.refresh.values.has(refreshKeyOf(B_ID))).toBe(false);
  });

  it("no token reaches a log", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    const tokens = joinTokens(h);

    await h.sessions.add(recordOf(B_ID), CREDENTIAL, tokens);

    const logs = h.logs.join("\n");
    expect(logs).not.toContain(tokens.accessToken);
    expect(logs).not.toContain(tokens.refreshToken);
  });
});
