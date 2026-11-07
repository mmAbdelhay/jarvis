import { CLOSE } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import type { AuthView } from "./auth-session";
import { A_ID, B_ID, machinesHarness, recordOf, settle, welcome } from "./fake-machines";
import { prepareSwitchRoute } from "./machine-sessions";
import { createNavigatorGate, createScopeRouting, reconnectOrPair } from "./scope-routing";

const UNLOCKED = { busy: false, lockedLocally: false } as AuthView;
const LOCKED = { busy: false, lockedLocally: true } as AuthView;

/** expo-router's own refusal (global-state/store.js, assertIsReady): a route
 *  asked for with no navigator mounted takes the whole app down. */
function fakeNavigator() {
  const navigator = {
    ready: false,
    routes: [] as string[],
    go(route: string): void {
      if (!navigator.ready) throw new Error("Attempted to navigate before mounting");
      navigator.routes.push(route);
    },
  };
  return navigator;
}

function gated() {
  const navigator = fakeNavigator();
  const gate = createNavigatorGate(() => navigator.ready);
  gate.setMounted(true);
  return { navigator, gate };
}

describe("no navigation before the navigator mounts", () => {
  it("a route asked for early waits for the mount, then runs once", () => {
    const { navigator, gate } = gated();

    gate.navigate(() => navigator.go("/pair"));
    expect(navigator.routes).toEqual([]);

    navigator.ready = true;
    gate.flush();
    gate.flush();
    expect(navigator.routes).toEqual(["/pair"]);
  });

  it("with the navigator up, a route runs at once", () => {
    const { navigator, gate } = gated();
    navigator.ready = true;
    gate.navigate(() => navigator.go("/unlock"));
    expect(navigator.routes).toEqual(["/unlock"]);
  });

  it("only the latest route waits", () => {
    const { navigator, gate } = gated();
    gate.navigate(() => navigator.go("/unlock"));
    gate.navigate(() => navigator.go("/pair"));
    navigator.ready = true;
    gate.flush();
    expect(navigator.routes).toEqual(["/pair"]);
  });

  it("a flush with no navigator yet keeps the route", () => {
    const { navigator, gate } = gated();
    gate.navigate(() => navigator.go("/pair"));
    gate.flush();
    navigator.ready = true;
    gate.flush();
    expect(navigator.routes).toEqual(["/pair"]);
  });

  it("the gap of a remount holds a route too, as the old navigator has gone", () => {
    const { navigator, gate } = gated();
    navigator.ready = true;
    gate.navigate(() => navigator.go("/unlock"));
    navigator.ready = false;
    gate.navigate(() => navigator.go("/pair"));
    expect(navigator.routes).toEqual(["/unlock"]);
    navigator.ready = true;
    gate.flush();
    expect(navigator.routes).toEqual(["/unlock", "/pair"]);
  });

  it("no machines at launch: the reconnect's /pair waits, though it answers in microtasks", async () => {
    const h = machinesHarness({ ids: [] });
    const { navigator, gate } = gated();
    await h.sessions.start();
    const { client } = h.sessions.current();

    await reconnectOrPair({
      sessions: h.sessions,
      client,
      gate,
      navigateToPair: () => navigator.go("/pair"),
    });
    expect(navigator.routes).toEqual([]);

    navigator.ready = true;
    gate.flush();
    expect(navigator.routes).toEqual(["/pair"]);
  });

  it("a machine locked locally at mount: its unlock push waits", () => {
    const { navigator, gate } = gated();
    const routing = createScopeRouting();

    const push = routing.shouldPushUnlock({
      state: "connecting",
      auth: LOCKED,
      pathname: "/dashboard",
      switching: false,
    });
    expect(push).toBe(true);
    gate.navigate(() => navigator.go("/unlock"));
    expect(navigator.routes).toEqual([]);

    navigator.ready = true;
    gate.flush();
    expect(navigator.routes).toEqual(["/unlock"]);
  });

  it("a revocation answered before any navigator mounts: its /pair waits", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    h.navigator.ready = false;
    await h.start();
    welcome(h.socketOf(A_ID));

    h.socketOf(A_ID).emit({ kind: "close", code: CLOSE.revoked, reason: "" });
    await settle();
    expect(h.routes).toEqual([]);

    h.navigator.ready = true;
    h.gate.flush();
    expect(h.routes).toEqual(["/pair"]);
  });

  it("a /pair that waited through a switch stays off the new machine's screen", async () => {
    const h = machinesHarness();
    h.navigator.ready = false;
    await h.start();
    welcome(h.socketOf(A_ID));
    h.secure.failDelete = () => true;
    h.socketOf(A_ID).emit({ kind: "close", code: CLOSE.revoked, reason: "" });
    await settle();

    await h.sessions.switchTo(B_ID);
    h.navigator.ready = true;
    h.gate.flush();

    expect(h.sessions.current().id).toBe(B_ID);
    expect(h.routes).toEqual([]);
  });

  describe("the tick after the commit that removed the old navigator", () => {
    // The commit that removes the old Stack is default-lane: its listener
    // cleanup waits for the passive flush, so `isReady` still answers true.
    // Only the layout effect's cleanup has run by then.
    function staleTick() {
      const { navigator, gate } = gated();
      navigator.ready = true;
      gate.setMounted(false);
      return { navigator, gate };
    }

    it("a route held there runs on the next mount, not on the stale answer", () => {
      const { navigator, gate } = staleTick();

      gate.navigate(() => navigator.go("/pair"));
      expect(navigator.routes).toEqual([]);

      gate.setMounted(true);
      gate.flush();
      expect(navigator.routes).toEqual(["/pair"]);
    });

    it("isReady needs both the router's answer and the mount", () => {
      const { navigator, gate } = staleTick();
      expect(gate.isReady()).toBe(false);
      gate.setMounted(true);
      expect(gate.isReady()).toBe(true);
      navigator.ready = false;
      expect(gate.isReady()).toBe(false);
    });

    it("nothing is mounted until a tree says so", () => {
      const gate = createNavigatorGate(() => true);
      expect(gate.isReady()).toBe(false);
    });

    it("a switch prepared there asks for no route", () => {
      const { navigator, gate } = staleTick();
      const router = {
        canDismiss: () => true,
        dismissAll: () => navigator.go("dismissAll"),
        replace: (route: string) => navigator.go(route),
      };
      prepareSwitchRoute(router, gate, () => {});
      expect(navigator.routes).toEqual([]);
    });

    it("a revocation landing there, the machine alone: /pair waits for the new tree", async () => {
      const h = machinesHarness({ ids: [A_ID] });
      await h.start();
      // What the layout does on each publish: the old tree is on its way out.
      h.sessions.subscribe(() => h.gate.setMounted(false));
      welcome(h.socketOf(A_ID));

      h.socketOf(A_ID).emit({ kind: "close", code: CLOSE.revoked, reason: "" });
      await settle();
      expect(h.routes).toEqual([]);

      h.gate.setMounted(true);
      h.gate.flush();
      expect(h.routes).toEqual(["/pair"]);
    });
  });

  it("a switch with no navigator up asks for no route", () => {
    const { navigator, gate } = gated();
    const logs: string[] = [];
    const router = {
      canDismiss: () => true,
      dismissAll: () => navigator.go("dismissAll"),
      replace: (route: string) => navigator.go(route),
    };

    expect(() => prepareSwitchRoute(router, gate, (line) => logs.push(line))).not.toThrow();

    expect(navigator.routes).toEqual([]);
    expect(logs).toEqual(["machines: no navigator to prepare for the switch"]);
  });
});

describe("reconnectOrPair", () => {
  it("a connect goes nowhere", async () => {
    const h = machinesHarness();
    const { navigator, gate } = gated();
    navigator.ready = true;
    const { client } = await h.start();

    await reconnectOrPair({
      sessions: h.sessions,
      client,
      gate,
      navigateToPair: () => navigator.go("/pair"),
    });

    expect(navigator.routes).toEqual([]);
  });

  it("a store that cannot open goes to /pair", async () => {
    const h = machinesHarness({ ids: [] });
    const { navigator, gate } = gated();
    navigator.ready = true;
    h.secure.failGet = () => true;

    await reconnectOrPair({
      sessions: h.sessions,
      client: h.sessions.current().client,
      gate,
      navigateToPair: () => navigator.go("/pair"),
    });

    expect(navigator.routes).toEqual(["/pair"]);
  });

  it("a tree no longer on screen routes nowhere", async () => {
    const h = machinesHarness({ ids: [] });
    const { navigator, gate } = gated();
    navigator.ready = true;

    await reconnectOrPair({
      sessions: h.sessions,
      client: machinesHarness().sessions.current().client,
      gate,
      navigateToPair: () => navigator.go("/pair"),
    });

    expect(navigator.routes).toEqual([]);
  });

  it("a tree replaced while its /pair waited for a mount routes nowhere", async () => {
    const h = machinesHarness({ ids: [] });
    const { navigator, gate } = gated();
    await reconnectOrPair({
      sessions: h.sessions,
      client: h.sessions.current().client,
      gate,
      navigateToPair: () => navigator.go("/pair"),
    });

    await h.store.add(recordOf(B_ID), { deviceId: recordOf(B_ID).deviceId, token: "N".repeat(43) });
    await h.sessions.reconnect();
    navigator.ready = true;
    gate.flush();

    expect(navigator.routes).toEqual([]);
  });
});

describe("createScopeRouting", () => {
  const input = {
    state: "locked" as const,
    auth: UNLOCKED,
    pathname: "/dashboard",
    switching: false,
  };

  it("pushes the unlock screen once, until the route reaches it", () => {
    const routing = createScopeRouting();
    expect(routing.shouldPushUnlock(input)).toBe(true);
    expect(routing.shouldPushUnlock(input)).toBe(false);
    expect(routing.shouldPushUnlock({ ...input, pathname: "/unlock" })).toBe(false);
    expect(routing.shouldPushUnlock(input)).toBe(true);
  });

  it("a move out of locked lets a push that never landed be asked for again", () => {
    const routing = createScopeRouting();
    routing.shouldPushUnlock(input);
    routing.connectionChanged("locked");
    expect(routing.shouldPushUnlock(input)).toBe(false);
    routing.connectionChanged("open");
    expect(routing.shouldPushUnlock(input)).toBe(true);
  });

  it("the tree of a machine being left raises no unlock screen", () => {
    const routing = createScopeRouting();
    expect(routing.shouldPushUnlock({ ...input, switching: true })).toBe(false);
    expect(routing.shouldPushUnlock(input)).toBe(true);
  });

  it("connects once on whatever route loaded, then on reaching /dashboard, never from /pair", () => {
    const routing = createScopeRouting();
    expect(routing.shouldConnect("/settings")).toBe(true);
    expect(routing.shouldConnect("/settings")).toBe(false);
    expect(routing.shouldConnect("/pair")).toBe(false);
    expect(routing.shouldConnect("/dashboard")).toBe(true);
    expect(createScopeRouting().shouldConnect("/pair")).toBe(false);
  });
});
