import { describe, expect, it, vi } from "vitest";
import { createAuditLog } from "./audit.js";
import { fakeClock } from "./clock-double.js";
import { createDeviceStore } from "./devices.js";
import { memoryFs } from "./fs-double.js";
import type { RandomBytes } from "./io.js";
import { createPairing, type Pairing, type PairingOutcome } from "./pairing.js";
import { type PairRefusal, createPairSession } from "./pair-session.js";
import { HANDSHAKE_TIMEOUT_MS, PROTOCOL_VERSION } from "./protocol.js";
import { FakeSocket } from "./socket-double.js";

/** A RandomBytes double that fills each call's buffer with an incrementing byte, so successive mints never collide. */
function countingRandom(): RandomBytes {
  let call = 0;
  return (size: number) => Buffer.alloc(size, ++call);
}

const SOURCE = "127.0.0.1:5555";

// Syntactically valid (43 chars, SECRET_PATTERN) but never the secret an
// open window actually minted — for the "wrong guess" tests.
const WRONG_SECRET = "A".repeat(43);

/** Waits for every already-queued microtask (fs-double's chained awaits included) to drain, via a real macrotask tick. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeHarness(overrides: { random?: RandomBytes } = {}) {
  const clock = fakeClock(0);
  const random = overrides.random ?? countingRandom();
  const fs = memoryFs();
  const devices = createDeviceStore({
    fs,
    path: "/remote/devices.json",
    random,
    now: clock.now,
    enforceFileModes: true,
  });
  const auditOnError = vi.fn();
  const audit = createAuditLog({
    fs,
    path: "/remote/audit.log",
    now: clock.now,
    enforceFileModes: true,
    onError: auditOnError,
  });
  const pairing: Pairing = createPairing({
    random,
    now: clock.now,
    timers: clock.timers,
    onChange: () => undefined,
  });

  function makeSession(): {
    socket: FakeSocket;
    session: ReturnType<typeof createPairSession>;
    onFailure: ReturnType<typeof vi.fn<(reason: PairRefusal) => void>>;
    onSettled: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
  } {
    const socket = new FakeSocket();
    const onFailure = vi.fn<(reason: PairRefusal) => void>();
    const onSettled = vi.fn();
    const log = vi.fn();
    const session = createPairSession(socket, {
      pairing,
      devices,
      audit,
      timers: clock.timers,
      source: SOURCE,
      log,
      onFailure,
      onSettled,
    });
    return { socket, session, onFailure, onSettled, log };
  }

  const first = makeSession();

  async function auditLines(): Promise<string[]> {
    await audit.flushed();
    return (fs.files.get("/remote/audit.log")?.data ?? "").split("\n").filter((l) => l !== "");
  }

  return {
    clock,
    fs,
    devices,
    audit,
    auditLines,
    pairing,
    makeSession,
    socket: first.socket,
    session: first.session,
    onFailure: first.onFailure,
    onSettled: first.onSettled,
    log: first.log,
  };
}

function pairFrame(secret: string, deviceName: string, v: number = PROTOCOL_VERSION): string {
  return JSON.stringify({ t: "pair", v, secret, deviceName, client: "test/1.0" });
}

describe("createPairSession", () => {
  it("a valid pair frame sends nothing, closes nothing, adds no device, and reaches confirming with the name", () => {
    const { pairing, socket, session, devices } = makeHarness();
    const { secret } = pairing.open();

    session.onText(pairFrame(secret, "Phone"));

    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBeUndefined();
    expect(devices.count()).toBe(0);
    expect(pairing.status()).toMatchObject({ kind: "confirming", deviceName: "Phone" });
  });

  it("approving mints a device, sends exactly one paired frame, closes 1000, and the token authenticates", async () => {
    const { pairing, socket, session, devices, auditLines, onSettled } = makeHarness();
    const { secret } = pairing.open();
    session.onText(pairFrame(secret, "Phone"));

    const status = pairing.status();
    if (status.kind !== "confirming") throw new Error("unreachable");
    pairing.decide(status.requestId, true);
    await flush();

    expect(socket.sent).toHaveLength(1);
    const [frame] = socket.sent;
    expect(frame?.t).toBe("paired");
    expect(frame?.v).toBe(PROTOCOL_VERSION);
    const deviceId = frame?.deviceId as string;
    const token = frame?.token as string;
    expect(devices.authenticate(deviceId, token)?.id).toBe(deviceId);
    expect(socket.closed).toEqual({ code: 1000, reason: "paired" });

    const lines = await auditLines();
    expect(lines.some((l) => l.includes("pairing-requested"))).toBe(true);
    expect(lines.some((l) => l.includes(" paired "))).toBe(true);
    expect(lines.some((l) => l.includes(token))).toBe(false);
    expect(lines.some((l) => l.includes(secret))).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("denying closes 4403, sends nothing, adds no device", async () => {
    const { pairing, socket, session, devices } = makeHarness();
    const { secret } = pairing.open();
    session.onText(pairFrame(secret, "Phone"));

    const status = pairing.status();
    if (status.kind !== "confirming") throw new Error("unreachable");
    pairing.decide(status.requestId, false);
    await flush();

    expect(socket.sent).toEqual([]);
    expect(socket.closed?.code).toBe(4403);
    expect(devices.count()).toBe(0);
  });

  it("[bite-proof] a wrong secret closes 4401, calls onFailure(mismatch), and leaves the window open", () => {
    const { pairing, socket, session, onFailure } = makeHarness();
    pairing.open();

    session.onText(pairFrame(WRONG_SECRET, "Phone"));

    expect(socket.closed?.code).toBe(4401);
    expect(onFailure).toHaveBeenCalledWith("mismatch");
    expect(pairing.status().kind).toBe("open");
    // I1: an unauthenticated peer must not learn *why* it was refused —
    // the reason lives only in the audit log, never on the wire.
    expect(socket.closed?.reason).toBe("");
  });

  it("an expired window closes 4401 closed, with no reason on the wire", () => {
    const { pairing, clock, makeSession } = makeHarness();
    const { secret } = pairing.open();
    clock.advance(120_000); // the window's own timer expires it

    // A fresh session, so its own 5s handshake timer starts now — well
    // after the window closed, but with plenty of room before it fires.
    const { socket, session, onFailure } = makeSession();
    session.onText(pairFrame(secret, "Phone"));

    expect(socket.closed?.code).toBe(4401);
    expect(onFailure).toHaveBeenCalledWith("closed");
    expect(socket.closed?.reason).toBe("");
  });

  it("[I1] a busy window (already confirming another device) closes 4401 with no reason on the wire", () => {
    const harness = makeHarness();
    const { pairing, makeSession } = harness;
    const { secret } = pairing.open();
    // Puts the window into "confirming" via a second, separate session.
    const busy = makeSession();
    busy.session.onText(pairFrame(secret, "First"));

    const { socket, session, onFailure } = makeSession();
    session.onText(pairFrame(secret, "Second"));

    expect(socket.closed?.code).toBe(4401);
    expect(onFailure).toHaveBeenCalledWith("busy");
    expect(socket.closed?.reason).toBe("");
  });

  it("[I1] denying a pairing closes with no reason on the wire (the outcome is audited only)", async () => {
    const { pairing, socket, session } = makeHarness();
    const { secret } = pairing.open();
    session.onText(pairFrame(secret, "Phone"));
    const status = pairing.status();
    if (status.kind !== "confirming") throw new Error("unreachable");
    pairing.decide(status.requestId, false);
    await flush();

    expect(socket.closed?.code).toBe(4403);
    expect(socket.closed?.reason).toBe("");
  });

  it("reusing a secret after an approved pairing closes 4401, and the device count stays at 1", async () => {
    const harness = makeHarness();
    const { pairing } = harness;
    const { secret } = pairing.open();
    harness.session.onText(pairFrame(secret, "Phone"));
    const status = pairing.status();
    if (status.kind !== "confirming") throw new Error("unreachable");
    pairing.decide(status.requestId, true);
    await flush();
    expect(harness.devices.count()).toBe(1);

    // A second connection, same (now stale) secret.
    const socket2 = new FakeSocket();
    const session2 = createPairSession(socket2, {
      pairing,
      devices: harness.devices,
      audit: harness.audit,
      timers: harness.clock.timers,
      source: SOURCE,
      log: vi.fn(),
      onFailure: vi.fn(),
      onSettled: vi.fn(),
    });
    session2.onText(pairFrame(secret, "Phone2"));

    expect(socket2.closed?.code).toBe(4401);
    expect(harness.devices.count()).toBe(1);
  });

  it.each<[string, string]>([
    [
      "a hello frame",
      JSON.stringify({
        t: "hello",
        v: 1,
        deviceId: "a".repeat(32),
        token: "b".repeat(43),
        client: "x",
      }),
    ],
    ["a bidi-emptied name", pairFrame(WRONG_SECRET, "\u{202E}\u{200B}")],
  ])("%s closes 4400, leaving the window open", (_label, text) => {
    const { pairing, socket, session } = makeHarness();
    pairing.open();

    session.onText(text);

    expect(socket.closed?.code).toBe(4400);
    expect(pairing.status().kind).toBe("open");
  });

  it("[bite-proof: version before secret] a v:2 frame closes 4426 and the window stays open, even with the right secret", () => {
    const { pairing, socket, session } = makeHarness();
    const { secret } = pairing.open();

    session.onText(pairFrame(secret, "Phone", 2));

    expect(socket.closed?.code).toBe(4426);
    expect(pairing.status().kind).toBe("open");
  });

  it("silence for 4999ms leaves the socket open; at 5000ms it closes 4408 timeout", () => {
    const { clock, socket, onFailure } = makeHarness();

    clock.advance(HANDSHAKE_TIMEOUT_MS - 1);
    expect(socket.closed).toBeUndefined();

    clock.advance(1);
    expect(socket.closed?.code).toBe(4408);
    expect(onFailure).toHaveBeenCalledWith("timeout");
  });

  it("a binary frame while awaiting closes 4400", () => {
    const { socket, session } = makeHarness();
    session.onBinary(new Uint8Array([1]));
    expect(socket.closed?.code).toBe(4400);
  });

  it("onClose mid-confirmation cancels the pairing, settles once, and adds no device", async () => {
    const { pairing, session, devices, onSettled } = makeHarness();
    const { secret } = pairing.open();
    session.onText(pairFrame(secret, "Phone"));
    expect(pairing.status().kind).toBe("confirming");

    session.onClose(1006);
    await flush();

    expect(pairing.status()).toEqual({ kind: "closed" });
    expect(devices.count()).toBe(0);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("approve, then onClose before devices.add() resolves: no device kept, nothing sent, settled once, and the abandoned reason is audited", async () => {
    const { pairing, socket, session, devices, auditLines, onSettled } = makeHarness();
    const { secret } = pairing.open();
    session.onText(pairFrame(secret, "Phone"));
    const status = pairing.status();
    if (status.kind !== "confirming") throw new Error("unreachable");

    pairing.decide(status.requestId, true);
    session.onClose(1006); // synchronously right after decide(), before any microtask runs

    await flush();

    expect(devices.count()).toBe(0);
    expect(socket.sent).toEqual([]);
    expect(onSettled).toHaveBeenCalledTimes(1);
    const lines = await auditLines();
    expect(lines.some((l) => l.includes("pairing-denied") && l.includes("abandoned"))).toBe(true);
  });

  it("devices.add() throwing records an error audit line, closes 1011, and settles once", async () => {
    const { pairing, socket, session, devices, auditLines, onSettled, log } = makeHarness();
    const { secret } = pairing.open();
    session.onText(pairFrame(secret, "Phone"));
    const status = pairing.status();
    if (status.kind !== "confirming") throw new Error("unreachable");

    devices.add = async () => {
      throw new Error("boom");
    };

    pairing.decide(status.requestId, true);
    await flush();

    expect(socket.closed?.code).toBe(1011);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
    const lines = await auditLines();
    expect(lines.some((l) => l.includes("error") && l.includes("boom"))).toBe(true);
  });

  it("[fix] a devices.revoke() failure on the abandoned path still settles once, with an error audit line and no unhandled rejection", async () => {
    const { pairing, fs, session, auditLines, onSettled, log } = makeHarness();
    const { secret } = pairing.open();
    session.onText(pairFrame(secret, "Phone"));
    const status = pairing.status();
    if (status.kind !== "confirming") throw new Error("unreachable");

    // devices.add()'s own persist() must still succeed (its rename is the
    // 1st call); only revoke()'s later persist() (the 2nd rename) fails.
    const realRename = fs.rename.bind(fs);
    let renames = 0;
    fs.rename = async (from: string, to: string) => {
      renames += 1;
      if (renames > 1) throw new Error("disk full");
      return realRename(from, to);
    };

    pairing.decide(status.requestId, true);
    session.onClose(1006); // socket gone before devices.add() resolves

    await flush();

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
    const lines = await auditLines();
    expect(lines.some((l) => l.includes("error") && l.includes("disk full"))).toBe(true);
  });

  it("[fix] onClose while awaiting-pair disarms the handshake timer: no false timeout refusal, and settles exactly once", async () => {
    const { clock, session, auditLines, onFailure, onSettled } = makeHarness();

    // No pair frame ever arrives; the socket just goes away.
    session.onClose(1006);
    clock.advance(HANDSHAKE_TIMEOUT_MS);

    expect(onFailure).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(await auditLines()).toEqual([]);
  });

  it("[fix] onClose after the decision already arrived does not call pairing.cancel() again", async () => {
    const clock = fakeClock(0);
    const fs = memoryFs();
    const random = countingRandom();
    const devices = createDeviceStore({
      fs,
      path: "/remote/devices.json",
      random,
      now: clock.now,
      enforceFileModes: true,
    });
    const audit = createAuditLog({
      fs,
      path: "/remote/audit.log",
      now: clock.now,
      enforceFileModes: true,
      onError: vi.fn(),
    });

    let resolveDecision!: (outcome: PairingOutcome) => void;
    const decision = new Promise<PairingOutcome>((resolve) => {
      resolveDecision = resolve;
    });
    const cancel = vi.fn();
    const begin = vi.fn(() => ({ ok: true as const, requestId: "r1", decision }));
    const onSettled = vi.fn();
    const socket = new FakeSocket();
    const session = createPairSession(socket, {
      pairing: { begin, cancel },
      devices,
      audit,
      timers: clock.timers,
      source: SOURCE,
      log: vi.fn(),
      onFailure: vi.fn(),
      onSettled,
    });

    session.onText(pairFrame(WRONG_SECRET, "Phone")); // begin() is stubbed; the secret's content is irrelevant
    resolveDecision("approved");
    await Promise.resolve(); // let the decision's `.then` run: sets `decided`, starts handleDecision

    session.onClose(1006); // fires while handleDecision is still awaiting devices.add()

    await flush();

    expect(cancel).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
