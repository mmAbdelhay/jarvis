// Task 5: raw session input — verbatim text, mode-aware keys, a Ctrl
// latch, and a debounced resize. Raw input is never queued or retried
// (ruling 6): every send uses `{whenNotOpen:"reject"}`, so a drop while a
// call is in flight is reported `uncertain`, never re-sent. See
// the mobile milestone 7, task 5 plan (docs/superpowers/plans).

import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import type { Credential, Endpoint, RpcClient } from "./rpc-client";
import { createRpcClient } from "./rpc-client";
import {
  MAX_INPUT_CHARS,
  RESIZE_DEBOUNCE_MS,
  type SessionInput,
  createSessionInput,
} from "./session-input";
import type { KeyName, TerminalModes } from "./terminal-keys";
import { keyBytes } from "./terminal-keys";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };
const CLIENT_STRING = "jarvis-mobile/1.0.0/ios";
const SESSION_ID = "s1";

// rpc-client.ts:82 — REQUEST_TIMEOUT_MS is not exported, so this is a
// named local copy rather than a bare literal in the test body below. If
// the real constant ever changes, this test should be updated to match,
// not silently keep passing against a stale value.
const RPC_REQUEST_TIMEOUT_MS = 30_000;

/** Flushes pending microtasks (e.g. a `.then()` chained onto an already-
 * resolved `RpcClient.call()`), without depending on how many `await
 * Promise.resolve()` hops the implementation happens to need today. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// RI1: every harness created anywhere in this file registers itself here,
// including what it *attempted* to send (every `sendText`/`sendKey` call,
// whatever the outcome) alongside what actually reached the wire. One
// `afterEach` (below) then checks, for *every* test, that neither
// `SessionInput`'s own logs nor `RpcClient`'s logs contain any of those
// payloads — this is the whole-file guard for the brief's "across the
// whole file, log lines contain none of the texts or byte sequences
// sent", and it also covers every *refused* send (ended, offline,
// tooLong, ctrlInvalid, after dispose), since those never reach the wire
// but are still recorded here at the call site.
type RegisteredHarness = {
  logs: string[];
  rpcLogs: string[];
  transport: ReturnType<typeof createFakeTransport>;
  attemptedPayloads: string[];
  attemptCount: number;
};
const registeredHarnesses: RegisteredHarness[] = [];

function createHarness() {
  const transport = createFakeTransport();
  const clock = createFakeClock();
  const rpcLogs: string[] = [];
  const client = createRpcClient({
    transport,
    clock,
    random: () => 0.5,
    client: CLIENT_STRING,
    log: (line) => rpcLogs.push(line),
  });
  const logs: string[] = [];
  const rawInput = createSessionInput({
    client,
    clock,
    sessionId: SESSION_ID,
    log: (line) => logs.push(line),
  });

  const registered: RegisteredHarness = {
    logs,
    rpcLogs,
    transport,
    attemptedPayloads: [],
    attemptCount: 0,
  };
  registeredHarnesses.push(registered);

  let currentModes: TerminalModes = { applicationCursor: false };
  // Wraps sendText/sendKey/setModes so every *attempt* — including one
  // `SessionInput` itself refuses before ever touching the wire — is
  // recorded here, independent of and in addition to whatever the fake
  // socket saw. `attemptCount` and `attemptedPayloads.push(...)` happen
  // in the same statement pair below deliberately, so a future edit that
  // drops the recording push while leaving the count (or vice versa) is
  // itself caught by the "recorded nothing" guard in `afterEach`.
  const input: SessionInput = {
    ...rawInput,
    sendText(text: string) {
      registered.attemptCount++;
      registered.attemptedPayloads.push(text);
      return rawInput.sendText(text);
    },
    sendKey(key: KeyName) {
      registered.attemptCount++;
      registered.attemptedPayloads.push(keyBytes(key, currentModes));
      return rawInput.sendKey(key);
    },
    setModes(modes: TerminalModes) {
      currentModes = modes;
      rawInput.setModes(modes);
    },
  };

  return { client, transport, clock, logs, rpcLogs, input };
}

function isBenignSingleChar(payload: string): boolean {
  // A single plain letter/digit ("a", "1", ...) is expected to turn up
  // inside ordinary log words ("rateLimited", "len=1") with no leak
  // involved; every other payload — multi-character text, or any single
  // non-alphanumeric byte such as a control character — could never
  // legitimately appear in a log line built only from `session-input:
  // <kind> id=<id> len=<n>` / `resize-<kind>`, so any match there is a
  // genuine leak.
  return payload.length === 1 && /[a-zA-Z0-9]/.test(payload);
}

function assertPayloadsAbsent(logs: string[], payloads: string[]): void {
  for (const line of logs) {
    for (const payload of payloads) expect(line).not.toContain(payload);
  }
}

afterEach(() => {
  for (const harness of registeredHarnesses) {
    const forbidden: string[] = [];
    for (const socket of harness.transport.sockets) {
      for (const raw of socket.sent) {
        let frame: { t?: string; ch?: string; a?: unknown[] };
        try {
          frame = JSON.parse(raw);
        } catch {
          continue;
        }
        if (frame.t !== "req" || frame.ch !== "session:input") continue;
        const payload = frame.a?.[1];
        if (typeof payload === "string" && payload.length > 0) forbidden.push(payload);
      }
    }
    for (const payload of harness.attemptedPayloads) {
      if (payload.length > 0) forbidden.push(payload);
    }
    const checked = forbidden.filter((payload) => !isBenignSingleChar(payload));

    // RI1's "no vacuous pass" guard: if this harness attempted at least
    // one send, the recording path above must have captured at least one
    // payload for it — otherwise the sweep below would compare against
    // nothing and pass without ever having checked anything.
    if (harness.attemptCount > 0) {
      expect(harness.attemptedPayloads.length).toBeGreaterThan(0);
    }

    assertPayloadsAbsent([...harness.logs, ...harness.rpcLogs], checked);
  }
  registeredHarnesses.length = 0;
});

describe("input logging sweep", () => {
  it("detects leaked attempted input even when no frame was sent", () => {
    const h = createHarness();
    h.input.sendText("refused-secret");
    expect(registeredHarnesses.at(-1)?.attemptedPayloads).toContain("refused-secret");
    expect(() => assertPayloadsAbsent(["leaked refused-secret"], ["refused-secret"])).toThrow();
    expect(() => assertPayloadsAbsent(["input: offline"], ["refused-secret"])).not.toThrow();
  });
});

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function completeHandshake(
  transport: ReturnType<typeof createFakeTransport>,
  capabilities: string[] = ["session:input", "session:resize"],
): FakeSocket {
  const socket = latestSocket(transport);
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities }),
  });
  return socket;
}

function reqFrames(socket: FakeSocket, ch: string): { id: number; a: unknown[] }[] {
  return socket.sent
    .map((s) => JSON.parse(s) as { t: string; id: number; ch: string; a: unknown[] })
    .filter((f) => f.t === "req" && f.ch === ch);
}

function connectAndOpen(harness: ReturnType<typeof createHarness>) {
  harness.client.connect(ENDPOINT, CREDENTIAL);
  return completeHandshake(harness.transport);
}

describe("session-input: sendText", () => {
  it("sends exactly one session:input frame with [sessionId, text] and resolves sent on res", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);

    const pending = h.input.sendText("hello");
    const frames = reqFrames(socket, "session:input");
    expect(frames).toHaveLength(1);
    expect(frames[0].a).toEqual([SESSION_ID, "hello"]);

    socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: frames[0].id, v: null }) });
    await expect(pending).resolves.toEqual({ kind: "sent" });
  });

  it("sends the text verbatim, never with a trailing CR", async () => {
    // [bite-proof: append "\r" to the sent text; this frame's data differs]
    const h = createHarness();
    const socket = connectAndOpen(h);
    void h.input.sendText("1");
    const frames = reqFrames(socket, "session:input");
    expect(frames[0].a).toEqual([SESSION_ID, "1"]);
  });

  it("empty text sends no frame and resolves empty", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    await expect(h.input.sendText("")).resolves.toEqual({ kind: "empty" });
    expect(reqFrames(socket, "session:input")).toHaveLength(0);
  });

  it("16385 chars is tooLong (no frame); exactly 16384 chars sends", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);

    const tooLong = "a".repeat(MAX_INPUT_CHARS + 1);
    await expect(h.input.sendText(tooLong)).resolves.toEqual({ kind: "tooLong" });
    expect(reqFrames(socket, "session:input")).toHaveLength(0);

    const exact = "b".repeat(MAX_INPUT_CHARS);
    const pending = h.input.sendText(exact);
    const frames = reqFrames(socket, "session:input");
    expect(frames).toHaveLength(1);
    expect(frames[0].a).toEqual([SESSION_ID, exact]);
    socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: frames[0].id, v: null }) });
    await expect(pending).resolves.toEqual({ kind: "sent" });
  });

  it("sends Arabic and tab-containing text byte-identical", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    void h.input.sendText("مرحبا");
    void h.input.sendText("a\tb");
    const frames = reqFrames(socket, "session:input");
    expect(frames.map((f) => f.a)).toEqual([
      [SESSION_ID, "مرحبا"],
      [SESSION_ID, "a\tb"],
    ]);
  });

  it("resolves offline while reconnecting, and never sends session:input after the reconnect's welcome", async () => {
    // [bite-proof: omit whenNotOpen:"reject" in the send call (use "queue"
    // instead); the frame appears on socket2 after welcome]
    const h = createHarness();
    h.client.connect(ENDPOINT, CREDENTIAL);
    const socket1 = completeHandshake(h.transport);
    socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
    expect(h.client.state()).toBe("reconnecting");

    // RM1: assert the wire is silent on a *named* assertion first — with
    // "reject" this call never reaches any queue, so completing the
    // reconnect below produces no frame — before awaiting the pending
    // promise. With "queue" instead, `flushQueue()` inside
    // `handleWelcome` sends it synchronously as part of
    // `completeHandshake`, so this assertion (not a hung `await`) is what
    // catches the regression.
    const pending = h.input.sendText("typed while down");

    h.clock.advance(1_000);
    const socket2 = completeHandshake(h.transport);
    expect(reqFrames(socket2, "session:input")).toHaveLength(0);

    await expect(pending).resolves.toEqual({ kind: "offline" });
  });

  it("an in-flight send resolves uncertain on a 1006 drop, and is never re-sent after reconnect", async () => {
    const h = createHarness();
    const socket1 = connectAndOpen(h);
    const pending = h.input.sendText("in flight");
    expect(reqFrames(socket1, "session:input")).toHaveLength(1);

    socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
    await expect(pending).resolves.toEqual({ kind: "uncertain" });

    h.clock.advance(1_000);
    const socket2 = completeHandshake(h.transport);
    expect(reqFrames(socket2, "session:input")).toHaveLength(0);
  });

  it("maps err rate-limited to rateLimited, and other remote errors to failed with the server text", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);

    const rl = h.input.sendText("a");
    let frames = reqFrames(socket, "session:input");
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "err",
        id: frames[0].id,
        code: "rate-limited",
        text: "slow down",
        language: "en",
      }),
    });
    await expect(rl).resolves.toEqual({ kind: "rateLimited" });

    const forbidden = h.input.sendText("b");
    frames = reqFrames(socket, "session:input");
    const last = frames[frames.length - 1];
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "err", id: last.id, code: "forbidden", text: "X", language: "en" }),
    });
    await expect(forbidden).resolves.toEqual({ kind: "failed", text: "X" });
  });

  it("a request timeout maps to uncertain, not failed (an in-flight send, no reply ever)", async () => {
    const h = createHarness();
    connectAndOpen(h);
    const pending = h.input.sendText("a");
    h.clock.advance(RPC_REQUEST_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ kind: "uncertain" });
  });

  it("unsupported maps to failed with an empty text", async () => {
    // RpcClient.call() never actually produces `unsupported` today (only
    // `subscribe()` does; ruling/brief still names the mapping, so it's
    // exercised directly against a minimal stub client rather than left
    // untested).
    const stubClient: RpcClient = {
      connect: () => {},
      disconnect: () => {},
      call: async () => ({ ok: false, error: { kind: "unsupported" } }),
      upload: async () => ({ ok: false, error: { kind: "unsupported" } }),
      subscribe: () => ({ ok: true, value: undefined }),
      unsubscribe: () => {},
      onPush: () => () => {},
      onState: () => () => {},
      state: () => "open",
      capabilities: () => [],
      subscriptions: () => [],
      lastFrameAt: () => undefined,
      setAppActive: () => {},
    };
    const clock = createFakeClock();
    const input = createSessionInput({
      client: stubClient,
      clock,
      sessionId: SESSION_ID,
      log: () => {},
    });
    await expect(input.sendText("a")).resolves.toEqual({ kind: "failed", text: "" });
  });
});

describe("session-input: Ctrl latch", () => {
  it("armCtrl(); sendText('c') sends \\x03 and clears the latch", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.armCtrl();
    expect(h.input.ctrlArmed()).toBe(true);
    const pending = h.input.sendText("c");
    const frames = reqFrames(socket, "session:input");
    expect(frames).toHaveLength(1);
    expect(frames[0].a).toEqual([SESSION_ID, "\x03"]);
    expect(h.input.ctrlArmed()).toBe(false);
    socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: frames[0].id, v: null }) });
    await expect(pending).resolves.toEqual({ kind: "sent" });
  });

  it("armCtrl(); sendText('cd') -> ctrlInvalid, no frame, latch clears", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.armCtrl();
    await expect(h.input.sendText("cd")).resolves.toEqual({ kind: "ctrlInvalid" });
    expect(reqFrames(socket, "session:input")).toHaveLength(0);
    expect(h.input.ctrlArmed()).toBe(false);
  });

  it("armCtrl(); sendKey('up') sends the arrow bytes and leaves the latch armed", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.armCtrl();
    const pending = h.input.sendKey("up");
    const frames = reqFrames(socket, "session:input");
    expect(frames[0].a).toEqual([SESSION_ID, "\x1b[A"]);
    expect(h.input.ctrlArmed()).toBe(true);
    socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: frames[0].id, v: null }) });
    await expect(pending).resolves.toEqual({ kind: "sent" });
  });

  it("disarmCtrl() clears an armed latch without sending anything", () => {
    const h = createHarness();
    h.input.armCtrl();
    h.input.disarmCtrl();
    expect(h.input.ctrlArmed()).toBe(false);
  });
});

describe("session-input: sendKey and modes", () => {
  it("sendKey('enter') sends CR", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    void h.input.sendKey("enter");
    const frames = reqFrames(socket, "session:input");
    expect(frames[0].a).toEqual([SESSION_ID, "\r"]);
  });

  it("setModes({applicationCursor:true}); sendKey('left') sends the SS3 form", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.setModes({ applicationCursor: true });
    void h.input.sendKey("left");
    const frames = reqFrames(socket, "session:input");
    expect(frames[0].a).toEqual([SESSION_ID, "\x1bOD"]);
  });
});

describe("session-input: ended", () => {
  it("setEnded(true) makes sendText and sendKey resolve ended, with no frames", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.setEnded(true);
    await expect(h.input.sendText("hi")).resolves.toEqual({ kind: "ended" });
    await expect(h.input.sendKey("enter")).resolves.toEqual({ kind: "ended" });
    expect(reqFrames(socket, "session:input")).toHaveLength(0);
  });

  it("ended takes precedence over an armed Ctrl latch — the latch stays armed, untouched", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.armCtrl();
    h.input.setEnded(true);
    await expect(h.input.sendText("c")).resolves.toEqual({ kind: "ended" });
    expect(reqFrames(socket, "session:input")).toHaveLength(0);
    // The ended check runs first (brief's order), so the latch was never
    // consulted, let alone disarmed.
    expect(h.input.ctrlArmed()).toBe(true);
  });

  it("setEnded(false) re-enables a merely-ended (not disposed) input", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.setEnded(true);
    await expect(h.input.sendText("x")).resolves.toEqual({ kind: "ended" });

    h.input.setEnded(false);
    const pending = h.input.sendText("hello");
    const frames = reqFrames(socket, "session:input");
    expect(frames).toHaveLength(1);
    expect(frames[0].a).toEqual([SESSION_ID, "hello"]);
    socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: frames[0].id, v: null }) });
    await expect(pending).resolves.toEqual({ kind: "sent" });
  });
});

describe("session-input: dispose is permanent (I1)", () => {
  it("dispose(); setEnded(false); sendText/sendKey/resize -> still ended, no frames, ever", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.dispose();

    // A stale closure or a late reconnect could still call setEnded(false)
    // on an already-disposed instance — it must be a no-op.
    h.input.setEnded(false);

    await expect(h.input.sendText("x")).resolves.toEqual({ kind: "ended" });
    await expect(h.input.sendKey("enter")).resolves.toEqual({ kind: "ended" });
    h.input.resize(80, 24);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    h.input.reassert();

    expect(reqFrames(socket, "session:input")).toHaveLength(0);
    expect(reqFrames(socket, "session:resize")).toHaveLength(0);
  });
});

describe("session-input: resize", () => {
  it("debounces three resize() calls within 300ms into one session:resize frame", () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    // No size is known yet at this point (nothing has called resize()
    // yet), so the onState("open") handler's reassert() is a no-op here —
    // there is no earlier frame to account for.
    h.input.resize(80, 24);
    h.clock.advance(100);
    h.input.resize(80, 24);
    h.clock.advance(100);
    h.input.resize(80, 24);
    expect(reqFrames(socket, "session:resize")).toHaveLength(0);
    h.clock.advance(300);
    expect(reqFrames(socket, "session:resize").map((f) => f.a)).toEqual([[SESSION_ID, 80, 24]]);
  });

  it("ignores non-integers and out-of-range sizes", () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.resize(0, 24);
    h.input.resize(80.5, 24);
    h.input.resize(1001, 24);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    expect(reqFrames(socket, "session:resize")).toHaveLength(0);
  });

  it("does not re-send the same size again", () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.resize(80, 24);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    expect(reqFrames(socket, "session:resize")).toHaveLength(1);
    h.input.resize(80, 24);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    expect(reqFrames(socket, "session:resize")).toHaveLength(1);
  });

  it("reassert() sends even when unchanged", () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.resize(80, 24);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    expect(reqFrames(socket, "session:resize")).toHaveLength(1);
    h.input.reassert();
    expect(reqFrames(socket, "session:resize")).toHaveLength(2);
  });

  it("clears the last-sent size on a failed resize, so the same size is retried (M1)", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.resize(80, 24);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    let frames = reqFrames(socket, "session:resize");
    expect(frames).toHaveLength(1);

    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "err",
        id: frames[0].id,
        code: "forbidden",
        text: "no",
        language: "en",
      }),
    });
    // Let the call()'s promise settle and sendResize's .then() run.
    await flushMicrotasks();

    h.input.resize(80, 24); // same size: without the M1 fix this would be swallowed
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    frames = reqFrames(socket, "session:resize");
    expect(frames).toHaveLength(2);
  });

  it("resends the size once after a reconnect's welcome via reassert on open", () => {
    // [bite-proof: skip reassert on the "open" state notification; no
    // frame appears after reconnect]
    const h = createHarness();
    const socket1 = connectAndOpen(h);
    h.input.resize(80, 24);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    expect(reqFrames(socket1, "session:resize")).toHaveLength(1);

    socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
    h.clock.advance(1_000);
    const socket2 = completeHandshake(h.transport);
    expect(reqFrames(socket2, "session:resize")).toHaveLength(1);
    expect(reqFrames(socket2, "session:resize")[0].a).toEqual([SESSION_ID, 80, 24]);
  });

  it("resize while not open queues nothing; only the reassert-on-open frame appears after welcome", () => {
    const h = createHarness();
    h.client.connect(ENDPOINT, CREDENTIAL);
    h.input.resize(80, 24);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    const socket = completeHandshake(h.transport);
    expect(reqFrames(socket, "session:resize")).toHaveLength(1);
    expect(reqFrames(socket, "session:resize")[0].a).toEqual([SESSION_ID, 80, 24]);
  });

  it("setEnded(true) cancels a pending resize debounce", () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.resize(80, 24);
    h.input.setEnded(true);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    expect(reqFrames(socket, "session:resize")).toHaveLength(0);
  });

  it("dispose() prevents a pending debounce from ever firing", () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.resize(80, 24);
    h.input.dispose();
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    expect(reqFrames(socket, "session:resize")).toHaveLength(0);
  });
});

describe("session-input: logging never leaks text or bytes", () => {
  it("a text send, a key send, an armed-Ctrl byte and a ctrlInvalid attempt never appear in the logs", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    const secret = "super-secret-password مرحبا";
    const pending = h.input.sendText(secret);
    const frames = reqFrames(socket, "session:input");
    socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: frames[0].id, v: null }) });
    await pending;

    // RM2: emit a `res` for the key frame so this send actually resolves
    // (and its log line actually gets produced) — otherwise the "\x1b[A"
    // check below never exercises anything.
    const keyPending = h.input.sendKey("up"); // key bytes "\x1b[A" must not leak either
    const keyFrame = reqFrames(socket, "session:input").at(-1);
    if (keyFrame !== undefined) {
      socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: keyFrame.id, v: null }) });
    }
    await keyPending;

    h.input.armCtrl();
    await h.input.sendText("cd"); // ctrlInvalid path: the attempted "cd" must not leak

    h.input.armCtrl();
    const ctrlPending = h.input.sendText("c"); // armed: sends the control byte "\x03"
    const ctrlFrame = reqFrames(socket, "session:input").at(-1);
    if (ctrlFrame !== undefined) {
      socket.emit({
        kind: "message",
        text: encodeMessage({ t: "res", id: ctrlFrame.id, v: null }),
      });
    }
    await ctrlPending;

    // The correctness check above (the shared afterEach) reads sent
    // payloads back off the wire; this direct check additionally proves
    // the specific secret and control byte are absent, in case a future
    // change ever logs something the wire itself didn't carry.
    for (const line of h.logs) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain("مرحبا");
      expect(line).not.toContain("cd");
      expect(line).not.toContain("\x03");
      expect(line).not.toContain("\x1b[A");
    }
  });

  it("a failed resize logs its kind only — never the cols/rows it attempted", async () => {
    const h = createHarness();
    // Never opened: the debounced resize call resolves offline, and that
    // failure must still be logged by kind, without leaking the size.
    h.client.connect(ENDPOINT, CREDENTIAL);
    h.input.resize(80, 24);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    // sendResize's `.then()` runs as a microtask; let it flush.
    await flushMicrotasks();

    expect(h.logs.some((line) => line.includes("resize-offline"))).toBe(true);
    for (const line of h.logs) {
      expect(line).not.toContain("80");
      expect(line).not.toContain("24");
    }
  });
});
