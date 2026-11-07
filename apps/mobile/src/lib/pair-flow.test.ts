import { CLOSE, PROTOCOL_VERSION, encodeMessage, formatPairingUri } from "@jarvis/wire";
import type { PairingLink } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import {
  A_ID,
  B_ID,
  type MachinesHarness,
  machinesHarness,
  refreshKeyOf,
  refreshTokenOf,
  settle,
  welcome,
} from "./fake-machines";
import type { FakeSocket } from "./fake-transport";
import type { SwitchOutcome } from "./machine-sessions";
import {
  afterClearRetry,
  afterForgetRoute,
  type AlreadyPairedCheck,
  canStartIntake,
  clearFailedEntry,
  entryPhaseKind,
  fingerprintTail,
  heldAfterHost,
  hostStep,
  intakeLink,
  intakeStep,
  joinFailureKey,
  openHeldMachine,
  pairBackTarget,
  pairStepKey,
  type PairFlowPhaseKind,
  phaseAfterCheck,
  phaseAfterRead,
  readHeldMachines,
  savePairing,
  shouldDrainPairingLink,
  submitJoin,
  type SubmitJoinDeps,
} from "./pair-flow";
import { joinMachine } from "./pairing";

const LINK: PairingLink = {
  host: "192.168.1.5",
  port: 4317,
  secret: "s".repeat(43),
  fingerprint: `${"a".repeat(60)}beef`,
};

const BUSY_PHASES: PairFlowPhaseKind[] = [
  "checking",
  "alreadyPaired",
  "clearFailed",
  "sameMachine",
  "join",
  "needsHost",
  "confirm",
  "waiting",
  "error",
  "success",
];

describe("canStartIntake", () => {
  it("allows a new intake only from the scan step, when nothing refuses for a held machine", () => {
    expect(canStartIntake({ held: false, phaseKind: "scan" })).toBe(true);
  });

  for (const phaseKind of BUSY_PHASES) {
    it(`refuses while busy (phase "${phaseKind}"), even when nothing is held`, () => {
      expect(canStartIntake({ held: false, phaseKind })).toBe(false);
    });
  }

  it(
    "refuses from the scan step for the browser, which holds one machine " +
      "[bite-proof: drop the held check and this test fails]",
    () => {
      expect(canStartIntake({ held: true, phaseKind: "scan" })).toBe(false);
    },
  );

  it("refuses when held and busy at once", () => {
    expect(canStartIntake({ held: true, phaseKind: "waiting" })).toBe(false);
  });
});

const NEW_NAME = "new.tail1234.ts.net";
const NEW_ID = `${NEW_NAME}_7717`;
const JOIN_DEVICE_ID = "e".repeat(32);
const PASSWORD = "correct horse battery staple";
const TOKENS = {
  accessToken: "a".repeat(64),
  refreshToken: "b".repeat(64),
  accessExpiresAt: 900_000_000,
};

function linkUri(link: Partial<PairingLink>): string {
  return formatPairingUri({ ...LINK, ...link });
}

/** The real store, sessions and `joinMachine`, over a fake socket: only the
 *  screen's own state is missing. */
function joinDeps(h: MachinesHarness, overrides: Partial<SubmitJoinDeps> = {}) {
  const waiting: string[] = [];
  const deps: SubmitJoinDeps = {
    isHeld: (id) => h.store.has(id),
    atLimit: () => false,
    waiting: () => waiting.push("waiting"),
    join: (address, password) =>
      joinMachine(
        { transport: h.transport, clock: h.clock, client: "jarvis/1", platform: "native" },
        address,
        password,
        "A phone",
      ),
    stillWanted: () => true,
    addAndSwitch: h.sessions.addAndSwitch,
    ...overrides,
  };
  return { deps, waiting };
}

function newestSocket(h: MachinesHarness): FakeSocket {
  return h.transport.sockets[h.transport.sockets.length - 1] as FakeSocket;
}

/** The target's side of a join that succeeds. */
function answerJoined(socket: FakeSocket): void {
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({
      t: "joined",
      v: PROTOCOL_VERSION,
      deviceId: JOIN_DEVICE_ID,
      token: "T".repeat(43),
      tokens: TOKENS,
    }),
  });
}

function snapshot(h: MachinesHarness) {
  return {
    secure: [...h.secure.values],
    refresh: [...h.refresh.values],
    prefs: h.prefs.text,
    sockets: h.transport.sockets.length,
    scope: h.sessions.current(),
    auth: h.sessions.current().authSession.get(),
    state: h.sessions.current().client.state(),
  };
}

describe("intakeLink", () => {
  const isNotHeld = () => false;

  it("a link for a new machine stops at confirm with another machine active", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    const before = snapshot(h);

    const step = intakeLink({
      phaseKind: "scan",
      uri: linkUri({ host: "0.0.0.0", port: 7717, name: NEW_NAME }),
      isHeld: (id) => h.store.has(id),
      atLimit: () => false,
    });

    expect(step).toMatchObject({ kind: "step", step: { kind: "confirm", name: NEW_NAME } });
    expect(JSON.stringify((step as { step: unknown }).step)).not.toContain(LINK.secret);
    expect(snapshot(h)).toEqual(before);
    expect(h.sessions.current().id).toBe(A_ID);
  });

  it("a link for a held machine answers sameMachine and sends nothing", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();
    const sockets = h.transport.sockets.length;

    const step = intakeLink({
      phaseKind: "scan",
      uri: linkUri({ host: "0.0.0.0", port: 7717, name: "mac.tail.ts.net" }),
      isHeld: (id) => h.store.has(id),
      atLimit: () => false,
    });

    expect(step).toEqual({ kind: "sameMachine", id: B_ID });
    expect(h.transport.sockets).toHaveLength(sockets);
  });

  it("a link for a held machine arriving during /unlock leaves its record, tokens and session untouched", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();
    // A is on /unlock: connected, locked, and a stored token waits behind Face ID.
    welcome(h.socketOf(A_ID));
    await settle();
    expect(h.sessions.current().client.state()).toBe("locked");
    const before = snapshot(h);
    h.secure.sets.length = 0;
    h.refresh.sets.length = 0;

    const step = intakeLink({
      phaseKind: "scan",
      uri: linkUri({}),
      isHeld: (id) => h.store.has(id),
      atLimit: () => false,
    });
    await settle();

    expect(step).toEqual({ kind: "sameMachine", id: A_ID });
    expect(snapshot(h)).toEqual(before);
    expect(h.secure.sets).toEqual([]);
    expect(h.refresh.sets).toEqual([]);
    expect(h.device.prompts).toBe(0);
    expect(h.sessions.current().id).toBe(A_ID);
  });

  it("a link arriving during waiting is dropped", () => {
    let asked = false;
    expect(
      intakeLink({
        phaseKind: "waiting",
        uri: linkUri({}),
        isHeld: () => {
          asked = true;
          return false;
        },
        atLimit: () => false,
      }),
    ).toEqual({ kind: "dropped" });
    expect(asked).toBe(false);
  });

  it("a link arriving while the name and password are being typed is dropped", () => {
    expect(
      intakeLink({ phaseKind: "join", uri: linkUri({}), isHeld: isNotHeld, atLimit: () => false }),
    ).toEqual({ kind: "dropped" });
  });

  it("a link with no host waits for one, before the id can be known", () => {
    const step = intakeLink({
      phaseKind: "scan",
      uri: linkUri({ host: "0.0.0.0" }),
      isHeld: () => {
        throw new Error("not asked: no address yet");
      },
      atLimit: () => false,
    });
    expect(step).toMatchObject({ kind: "step", step: { kind: "needsHost" } });
  });

  it("a garbled link answers invalid", () => {
    expect(
      intakeLink({ phaseKind: "scan", uri: "nope", isHeld: isNotHeld, atLimit: () => false }),
    ).toEqual({ kind: "invalid" });
  });

  it("limit reached answers limit for a new machine", () => {
    expect(
      intakeLink({ phaseKind: "scan", uri: linkUri({}), isHeld: isNotHeld, atLimit: () => true }),
    ).toEqual({ kind: "limit" });
  });

  it("a held check that throws fails closed", () => {
    expect(
      intakeLink({
        phaseKind: "scan",
        uri: linkUri({}),
        isHeld: () => {
          throw new Error("machines: store is not open");
        },
        atLimit: () => false,
      }),
    ).toEqual({ kind: "checkFailed" });
  });
});

describe("heldAfterHost", () => {
  it("a typed host that lands on a held machine answers its id, a new one nothing", () => {
    const isHeld = (id: string) => id === A_ID;
    expect(heldAfterHost({ ...LINK, host: "192.168.1.5" }, isHeld)).toBe(A_ID);
    expect(heldAfterHost({ ...LINK, host: "192.168.1.6" }, isHeld)).toBeUndefined();
  });
});

describe("submitJoin", () => {
  it("a short name answers on the form, and no socket opens", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    const sockets = h.transport.sockets.length;
    const { deps } = joinDeps(h);

    expect(await submitJoin(deps, "mac", PASSWORD)).toEqual({
      kind: "join",
      failure: "short-name",
    });
    expect(await submitJoin(deps, "10.0.0.1", PASSWORD)).toEqual({
      kind: "join",
      failure: "invalid",
    });
    expect(h.transport.sockets).toHaveLength(sockets);
  });

  it("adding a held id answers sameMachine, and no frame is sent", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();
    const before = snapshot(h);
    const { deps, waiting } = joinDeps(h);

    // Spelled as a person might: normalised only by parseMachineAddress.
    expect(await submitJoin(deps, " MAC.tail.TS.net:7717 ", PASSWORD)).toEqual({
      kind: "sameMachine",
      id: B_ID,
    });

    expect(waiting).toEqual([]);
    expect(snapshot(h)).toEqual(before);
    for (const socket of h.transport.sockets) {
      expect(socket.sent.join()).not.toContain(PASSWORD);
    }
  });

  it("the same name on another port is another machine", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();
    const { deps, waiting } = joinDeps(h);

    void submitJoin(deps, "mac.tail.ts.net:9000", PASSWORD);

    expect(waiting).toEqual(["waiting"]);
    expect(newestSocket(h).url).toBe("wss://mac.tail.ts.net:9000/pair");
  });

  it("a held check that throws fails closed, with no frame sent", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    const sockets = h.transport.sockets.length;
    const { deps } = joinDeps(h, {
      isHeld: () => {
        throw new Error("machines: store is not open");
      },
    });

    expect(await submitJoin(deps, NEW_NAME, PASSWORD)).toEqual({ kind: "checkFailed" });
    expect(h.transport.sockets).toHaveLength(sockets);
  });

  it("at the limit nothing is sent: the target's device list stays clean", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    const sockets = h.transport.sockets.length;
    const { deps } = joinDeps(h, { atLimit: () => true });

    expect(await submitJoin(deps, NEW_NAME, PASSWORD)).toEqual({ kind: "limit" });
    expect(h.transport.sockets).toHaveLength(sockets);
  });

  it("a join that works adds the machine and switches to it, with the old one left closed", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    const { deps, waiting } = joinDeps(h);

    const running = submitJoin(deps, NEW_NAME, PASSWORD);
    expect(waiting).toEqual(["waiting"]);
    const joinSocket = newestSocket(h);
    expect(joinSocket.url).toBe(`wss://${NEW_NAME}:7717/pair`);
    expect(joinSocket.sent).toEqual([]);
    answerJoined(joinSocket);

    const step = await running;
    await settle();

    expect(step).toEqual({ kind: "success", id: NEW_ID });
    expect(h.sessions.current().id).toBe(NEW_ID);
    expect(h.store.activeId()).toBe(NEW_ID);
    expect(h.store.has(A_ID)).toBe(true);
    expect(JSON.stringify([...h.secure.values])).not.toContain(PASSWORD);
    expect(JSON.stringify([...h.refresh.values])).not.toContain(PASSWORD);
    expect(h.logs.join("\n")).not.toContain(PASSWORD);
    expect(JSON.stringify(step)).not.toContain(PASSWORD);
  });

  it.each([
    [CLOSE.unauthorized, "refused"],
    [CLOSE.tooManyRequests, "rate-limited"],
  ])("close %i answers on the form as %s, and A stays", async (code, failure) => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    const { deps } = joinDeps(h);

    const running = submitJoin(deps, NEW_NAME, PASSWORD);
    const socket = newestSocket(h);
    socket.emit({ kind: "open" });
    socket.emit({ kind: "close", code, reason: "" });
    const step = await running;

    expect(step).toEqual({ kind: "join", failure });
    expect(JSON.stringify(step)).not.toContain(PASSWORD);
    expect(h.sessions.current().id).toBe(A_ID);
    expect(h.store.has(NEW_ID)).toBe(false);
  });

  it("a join that rejects all the same answers on the form, with nothing of the error", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    const { deps } = joinDeps(h, {
      join: () => Promise.reject(new Error(`failed with ${PASSWORD}`)),
    });

    const step = await submitJoin(deps, NEW_NAME, PASSWORD);

    expect(step).toEqual({ kind: "join", failure: "unreachable" });
  });

  it("limit reached shows pair.limit and the machine is not added", async () => {
    const ids = Array.from({ length: 16 }, (_, i) => `m${i}.tail.ts.net_7717`);
    const h = machinesHarness({ ids, active: ids[0] });
    await h.store.open();
    const before = snapshot(h);
    const { deps } = joinDeps(h);

    const running = submitJoin(deps, NEW_NAME, PASSWORD);
    answerJoined(newestSocket(h));
    const step = await running;

    expect(step).toEqual({ kind: "limit" });
    expect(pairStepKey("limit")).toBe("pair.limit");
    expect(h.store.has(NEW_ID)).toBe(false);
    expect(h.secure.values.has(`jarvis.m.${NEW_ID}.token`)).toBe(false);
    expect(h.sessions.current().id).toBe(before.scope.id);
  });

  it("a save failure after a join shows pair.saveFailed and the old machine stays active", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    h.secure.failSet = (key) => key.includes(NEW_ID);
    const { deps } = joinDeps(h);
    const aSocket = h.socketOf(A_ID);

    const running = submitJoin(deps, NEW_NAME, PASSWORD);
    answerJoined(newestSocket(h));
    const step = await running;

    expect(step).toEqual({ kind: "saveFailed" });
    expect(pairStepKey("saveFailed")).toBe("pair.saveFailed");
    expect(h.sessions.current().id).toBe(A_ID);
    expect(h.store.activeId()).toBe(A_ID);
    expect(h.socketOf(A_ID)).toBe(aSocket);
    expect(aSocket.closedWith).toBeUndefined();
    expect(h.store.has(NEW_ID)).toBe(false);
    expect(h.refresh.values.has(`jarvis.m.${NEW_ID}.refresh`)).toBe(false);
    expect(JSON.stringify(step)).not.toContain(PASSWORD);
  });

  it("the machine held by the time the save runs: sameMachine, never an overwrite", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.start();
    const before = snapshot(h);
    // The check found nothing, and the store's own refusal stands behind it.
    const { deps } = joinDeps(h, { isHeld: () => false });

    const running = submitJoin(deps, "mac.tail.ts.net", PASSWORD);
    answerJoined(newestSocket(h));
    const step = await running;

    expect(step).toEqual({ kind: "sameMachine", id: B_ID });
    expect(h.secure.values.get(`jarvis.m.${B_ID}.token`)).toBe(
      before.secure.find(([key]) => key === `jarvis.m.${B_ID}.token`)?.[1],
    );
    expect(h.refresh.values.get(refreshKeyOf(B_ID))).toBe(refreshTokenOf(B_ID));
    expect(h.sessions.current().id).toBe(A_ID);
  });

  it("the screen went while it waited: nothing is added and nothing switches", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();
    const { deps } = joinDeps(h, { stillWanted: () => false });

    const running = submitJoin(deps, NEW_NAME, PASSWORD);
    answerJoined(newestSocket(h));
    const step = await running;

    expect(step).toEqual({ kind: "abandoned" });
    expect(h.store.has(NEW_ID)).toBe(false);
    expect(h.sessions.current().id).toBe(A_ID);
  });
});

describe("savePairing", () => {
  const RECORD = {
    deviceId: JOIN_DEVICE_ID,
    host: "192.168.1.9",
    port: 4317,
    fingerprint: "c".repeat(64),
    pairedAt: 1,
  };
  const CREDENTIAL = { deviceId: JOIN_DEVICE_ID, token: "T".repeat(43) };

  it("a QR pairing adds and switches, and carries no tokens", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    await h.start();

    expect(await savePairing(h.sessions.addAndSwitch, RECORD, CREDENTIAL)).toEqual({
      kind: "success",
      id: "192.168.1.9_4317",
    });

    expect(h.sessions.current().id).toBe("192.168.1.9_4317");
    expect(h.refresh.values.has("jarvis.m.192.168.1.9_4317.refresh")).toBe(false);
  });
});

describe("joinFailureKey", () => {
  it.each([
    ["short-name", "pair.joinShortName"],
    ["invalid", "pair.joinInvalid"],
    ["refused", "pair.joinRefused"],
    ["rate-limited", "pair.joinRateLimited"],
    ["unreachable", "pair.unreachable"],
    // pair.timeout speaks of an approval and a new code: a join has neither.
    ["timeout", "pair.unreachable"],
    ["protocol", "pair.protocol"],
  ] as const)("%s reads as %s", (failure, key) => {
    expect(joinFailureKey(failure)).toBe(key);
  });
});

describe("readHeldMachines", () => {
  it("a store that could not open fails closed", async () => {
    const h = machinesHarness({ ids: [A_ID] });
    h.secure.failGet = () => true;

    expect(await readHeldMachines(() => h.store.open().then(() => undefined), h.store)).toEqual({
      ok: false,
    });
    expect(phaseAfterRead({ ok: false })).toBe("checkFailed");
  });

  it("machines held no longer refuse: it goes to scan and answers them", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });

    const read = await readHeldMachines(() => h.store.open().then(() => undefined), h.store);

    expect(read).toEqual({ ok: true, ids: [A_ID, B_ID] });
    expect(phaseAfterRead(read)).toBe("scan");
  });

  it("one machine that cannot be read hides no healthy one", async () => {
    const h = machinesHarness({ ids: [A_ID, B_ID] });
    await h.store.open();
    h.secure.failGet = (key) => key === "jarvis.pairing";

    expect(await readHeldMachines(async () => undefined, h.store)).toEqual({
      ok: true,
      ids: [B_ID],
    });
  });
});

describe("clearFailedEntry", () => {
  it("a signal for the machine on screen shows the phase", () => {
    expect(clearFailedEntry({ id: A_ID }, A_ID)).toEqual({ id: A_ID });
    expect(clearFailedEntry({ id: null }, null)).toEqual({ id: null });
  });

  it("a signal for a machine the user has moved past shows nothing", () => {
    expect(clearFailedEntry({ id: A_ID }, B_ID)).toBeUndefined();
    expect(clearFailedEntry({ id: null }, B_ID)).toBeUndefined();
    expect(clearFailedEntry(undefined, B_ID)).toBeUndefined();
  });
});

describe("pairBackTarget", () => {
  const base = { onScreen: A_ID, clearFailedId: null, held: [A_ID, B_ID] };

  it("adding from a machine: back to that machine", () => {
    expect(pairBackTarget({ ...base, phaseKind: "scan" })).toBe(A_ID);
    expect(pairBackTarget({ ...base, phaseKind: "join" })).toBe(A_ID);
    expect(pairBackTarget({ ...base, phaseKind: "sameMachine" })).toBe(A_ID);
    expect(pairBackTarget({ ...base, phaseKind: "error" })).toBe(A_ID);
  });

  it("a machine alone is still somewhere to go back to", () => {
    expect(pairBackTarget({ ...base, phaseKind: "scan", held: [A_ID] })).toBe(A_ID);
  });

  it("no machine held: no back", () => {
    expect(pairBackTarget({ ...base, phaseKind: "scan", onScreen: null, held: [] })).toBe(
      undefined,
    );
  });

  it("the null scope with a machine held: to that machine", () => {
    expect(pairBackTarget({ ...base, phaseKind: "scan", onScreen: null })).toBe(A_ID);
  });

  it("a failed clear: to another held machine, never the one failing", () => {
    expect(pairBackTarget({ ...base, phaseKind: "clearFailed", clearFailedId: A_ID })).toBe(B_ID);
  });

  it("a failed clear with nothing else held leaves only the retry", () => {
    expect(
      pairBackTarget({ ...base, phaseKind: "clearFailed", clearFailedId: A_ID, held: [A_ID] }),
    ).toBe(undefined);
  });

  it.each(["checking", "waiting", "success"] as const)(
    "no back while %s: an answer on its way must find the screen",
    (phaseKind) => {
      expect(pairBackTarget({ ...base, phaseKind })).toBe(undefined);
    },
  );
});

describe("openHeldMachine", () => {
  function run(outcome: SwitchOutcome | Error) {
    const calls: string[] = [];
    const done = openHeldMachine(B_ID, {
      switchTo: (id) => {
        calls.push(`switch ${id}`);
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      },
      leave: () => calls.push("leave"),
      failed: () => calls.push("failed"),
      log: () => calls.push("log"),
    });
    return { calls, done };
  }

  it.each(["switched", "same", "superseded"] as const)("%s leaves /pair", async (outcome) => {
    const { calls, done } = run(outcome);
    await done;
    expect(calls).toEqual([`switch ${B_ID}`, "leave"]);
  });

  it("unknown stays, and says so", async () => {
    const { calls, done } = run("unknown");
    await done;
    expect(calls).toEqual([`switch ${B_ID}`, "failed"]);
  });

  it("a switch that rejects stays, and says so with a fixed line", async () => {
    const { calls, done } = run(new Error("boom"));
    await done;
    expect(calls).toEqual([`switch ${B_ID}`, "log", "failed"]);
  });
});

describe("fingerprintTail", () => {
  it("returns the last 4 hex characters", () => {
    expect(fingerprintTail(`${"a".repeat(60)}beef`)).toBe("beef");
  });

  it("never returns the whole fingerprint", () => {
    const fingerprint = "1".repeat(64);
    const tail = fingerprintTail(fingerprint);
    expect(tail.length).toBe(4);
    expect(tail).not.toBe(fingerprint);
  });
});

describe("intakeStep", () => {
  it("routes an unspecified-host link to needsHost, never to a step that starts pairing", () => {
    expect(intakeStep({ ...LINK, host: "0.0.0.0" })).toEqual({ kind: "needsHost" });
  });

  it(
    "routes an unspecified-host link with a `name` straight to confirm, never needsHost " +
      "(M11 rulings.md 1: the name is dialled, the bind address is irrelevant) " +
      "[bite-proof: drop the `link.name !== undefined` short-circuit in needsHost and this fails]",
    () => {
      const step = intakeStep({ ...LINK, host: "0.0.0.0", name: "mac.tail.ts.net" });
      expect(step).toEqual({
        kind: "confirm",
        host: "0.0.0.0",
        port: LINK.port,
        fingerprintTail: "beef",
        name: "mac.tail.ts.net",
      });
    },
  );

  it("intakeStep's confirm step carries `name` when the link has one", () => {
    const step = intakeStep({ ...LINK, name: "mac.tail.ts.net" });
    expect(step).toEqual({
      kind: "confirm",
      host: LINK.host,
      port: LINK.port,
      fingerprintTail: "beef",
      name: "mac.tail.ts.net",
    });
  });

  it(
    "routes a concrete link straight to confirm, never to a start/waiting step " +
      '[bite-proof: return {kind:"start"} instead and this fails]',
    () => {
      const step = intakeStep(LINK);
      expect(step).toEqual({
        kind: "confirm",
        host: LINK.host,
        port: LINK.port,
        fingerprintTail: "beef",
      });
    },
  );

  it("never includes the secret in its result", () => {
    const step = intakeStep(LINK);
    expect(JSON.stringify(step)).not.toContain(LINK.secret);
  });
});

describe("hostStep", () => {
  const unresolved: PairingLink = { ...LINK, host: "0.0.0.0" };

  it("reports invalid for a host withHost can't resolve, never a start/waiting step", () => {
    expect(hostStep(unresolved, "laptop.local")).toEqual({ kind: "invalid" });
  });

  it("reports invalid for an unspecified host, same as withHost", () => {
    expect(hostStep(unresolved, "0.0.0.0")).toEqual({ kind: "invalid" });
  });

  it("routes a valid host straight to confirm, never to a start/waiting step", () => {
    const step = hostStep(unresolved, "192.168.1.10");
    expect(step).toEqual({
      kind: "confirm",
      host: "192.168.1.10",
      port: LINK.port,
      fingerprintTail: "beef",
    });
  });

  it("never includes the secret in its result", () => {
    const step = hostStep(unresolved, "192.168.1.10");
    expect(JSON.stringify(step)).not.toContain(LINK.secret);
  });
});

describe("phaseAfterCheck", () => {
  it("routes to scan when the check succeeds and found nothing paired", () => {
    const check: AlreadyPairedCheck = { ok: true, paired: false };
    expect(phaseAfterCheck(check)).toBe("scan");
  });

  it("routes to alreadyPaired when the check succeeds and found a record", () => {
    const check: AlreadyPairedCheck = { ok: true, paired: true };
    expect(phaseAfterCheck(check)).toBe("alreadyPaired");
  });

  it(
    "fails closed: a failed check never routes to scan " +
      '[bite-proof: return "scan" on failure instead of "checkFailed" and this fails]',
    () => {
      const check: AlreadyPairedCheck = { ok: false };
      expect(phaseAfterCheck(check)).toBe("checkFailed");
    },
  );

  it("fails closed even when the previous known state was scan-eligible", () => {
    // The point of failing closed: no information about "paired" survives
    // a failed check, so the result can never be "scan" — only "checkFailed".
    const check: AlreadyPairedCheck = { ok: false };
    expect(phaseAfterCheck(check)).not.toBe("scan");
  });
});

describe("entryPhaseKind (fix round 2, I2 ruling)", () => {
  it("goes straight to clearFailed when the phone arrived with the clearFailed signal set", () => {
    // An unpaired episode whose clearPairing failed routes here (via a
    // route param or shared flag — _layout.tsx's choice) instead of
    // through the ordinary already-paired check, which would show the
    // contradictory "already paired" screen the ruling forbids.
    expect(entryPhaseKind(true)).toBe("clearFailed");
  });

  it(
    "otherwise starts the ordinary checking flow " +
      '[bite-proof: return "clearFailed" unconditionally and this fails]',
    () => {
      expect(entryPhaseKind(false)).toBe("checking");
    },
  );
});

describe("shouldDrainPairingLink (final review R-M1)", () => {
  it(
    "never drains for scan — the only outcome that still wants a held link " +
      "[bite-proof: return true unconditionally and this fails]",
    () => {
      expect(shouldDrainPairingLink("scan")).toBe(false);
    },
  );

  for (const nextKind of ["alreadyPaired", "checkFailed", "clearFailed"] as const) {
    it(
      `drains for "${nextKind}" — a link stashed for a phone refusing to pair ` +
        "right now must not linger or resurface later " +
        "[bite-proof: return false unconditionally and this fails]",
      () => {
        expect(shouldDrainPairingLink(nextKind)).toBe(true);
      },
    );
  }
});

describe("afterClearRetry (fix round 2, I2 ruling)", () => {
  it("moves to the normal scan phase once a retried clear succeeds", () => {
    expect(afterClearRetry(true)).toBe("scan");
  });

  it(
    "stays in clearFailed while the retry keeps failing " +
      '[bite-proof: return "scan" unconditionally and this fails]',
    () => {
      expect(afterClearRetry(false)).toBe("clearFailed");
    },
  );
});

describe("afterForgetRoute", () => {
  const NEXT = { kind: "next", id: "b_1" } as const;

  it.each(["revoked", "unpair", "pair-again"] as const)(
    "%s: a failed clear goes to /pair",
    (cause) => {
      expect(afterForgetRoute(cause, { kind: "clearFailed" })).toBe("pair");
    },
  );

  it.each(["revoked", "unpair", "pair-again"] as const)(
    "%s: no machine left goes to /pair",
    (cause) => {
      expect(afterForgetRoute(cause, { kind: "none" })).toBe("pair");
    },
  );

  it("another machine: revoked and unpair stay, pair-again goes to /pair", () => {
    expect(afterForgetRoute("revoked", NEXT)).toBe("stay");
    expect(afterForgetRoute("unpair", NEXT)).toBe("stay");
    expect(afterForgetRoute("pair-again", NEXT)).toBe("pair");
  });
});
