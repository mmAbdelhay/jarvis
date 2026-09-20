// Tests for a Workspace terminal pane's raw input (M9 Task 7): the same
// reject-not-queue/never-replayed/debounced-resize machinery
// session-input.test.ts exhaustively covers via `createRawInput`, exercised
// here only for the wiring that differs — the `terminal:input`/
// `terminal:resize` channel names, the pane key in place of a session id,
// and the `terminal-input:` log prefix. See session-input.test.ts for the
// Ctrl latch/ended/dispose/mode edge cases this reuses unchanged.

import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import type { Credential, Endpoint } from "./rpc-client";
import { createRpcClient } from "./rpc-client";
import { RESIZE_DEBOUNCE_MS } from "./session-input";
import { createTerminalInput } from "./terminal-input";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };
const PANE_KEY = "tab-1:p1";

function createHarness() {
  const transport = createFakeTransport();
  const clock = createFakeClock();
  const logs: string[] = [];
  const client = createRpcClient({
    transport,
    clock,
    random: () => 0.5,
    client: "jarvis-mobile-test",
    log: (line) => logs.push(line),
  });
  const input = createTerminalInput({ client, paneKey: PANE_KEY, clock, log: (l) => logs.push(l) });
  return { client, transport, clock, logs, input };
}

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function completeHandshake(
  transport: ReturnType<typeof createFakeTransport>,
  capabilities: string[] = ["terminal:input", "terminal:resize"],
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

function connectAndOpen(h: ReturnType<typeof createHarness>) {
  h.client.connect(ENDPOINT, CREDENTIAL);
  return completeHandshake(h.transport);
}

describe("createTerminalInput: sendText", () => {
  it("sends exactly one terminal:input frame with [paneKey, text] and resolves sent on res", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);

    const pending = h.input.sendText("ls -la");
    const frames = reqFrames(socket, "terminal:input");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.a).toEqual([PANE_KEY, "ls -la"]);

    socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: frames[0]?.id, v: null }) });
    await expect(pending).resolves.toEqual({ kind: "sent" });
  });

  // M7 ruling 3 (carried into terminal input unchanged): the phone never
  // appends Enter on its own — a text send is verbatim, never with a
  // trailing CR.
  it("never appends Enter to a text send", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    void h.input.sendText("git status");
    expect(reqFrames(socket, "terminal:input")[0]?.a).toEqual([PANE_KEY, "git status"]);
  });

  // "Input never replayed": a send dropped by a 1006 disconnect resolves
  // uncertain and is never re-sent once the reconnect's welcome arrives.
  it("resolves uncertain on an in-flight drop and never re-sends after reconnect", async () => {
    const h = createHarness();
    const socket1 = connectAndOpen(h);
    const pending = h.input.sendText("in flight");
    expect(reqFrames(socket1, "terminal:input")).toHaveLength(1);

    socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
    await expect(pending).resolves.toEqual({ kind: "uncertain" });

    h.clock.advance(1_000);
    const socket2 = completeHandshake(h.transport);
    expect(reqFrames(socket2, "terminal:input")).toHaveLength(0);
  });

  it("resolves offline while reconnecting and never sends afterwards", async () => {
    const h = createHarness();
    h.client.connect(ENDPOINT, CREDENTIAL);
    const socket1 = completeHandshake(h.transport);
    socket1.emit({ kind: "close", code: 1006, reason: "dropped" });

    const pending = h.input.sendText("typed while down");

    h.clock.advance(1_000);
    const socket2 = completeHandshake(h.transport);
    expect(reqFrames(socket2, "terminal:input")).toHaveLength(0);
    await expect(pending).resolves.toEqual({ kind: "offline" });
  });
});

describe("createTerminalInput: resize", () => {
  it("debounces three resize() calls into one terminal:resize frame", () => {
    const h = createHarness();
    const socket = connectAndOpen(h);

    h.input.resize(80, 24);
    h.input.resize(100, 30);
    h.input.resize(120, 40);
    h.clock.advance(RESIZE_DEBOUNCE_MS);

    const frames = reqFrames(socket, "terminal:resize");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.a).toEqual([PANE_KEY, 120, 40]);
  });

  it("reassert() sends the last size again even when unchanged", () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.resize(80, 24);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    expect(reqFrames(socket, "terminal:resize")).toHaveLength(1);

    h.input.reassert();

    expect(reqFrames(socket, "terminal:resize")).toHaveLength(2);
  });

  // Last-active-wins (M7 ruling 11): a fresh connection has no notion of
  // "last sent", so the same size goes over again once reconnected.
  it("resends the size once after a reconnect's welcome via reassert on open", () => {
    const h = createHarness();
    const socket1 = connectAndOpen(h);
    h.input.resize(80, 24);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    expect(reqFrames(socket1, "terminal:resize")).toHaveLength(1);

    socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
    h.clock.advance(1_000);
    const socket2 = completeHandshake(h.transport);

    expect(reqFrames(socket2, "terminal:resize")).toHaveLength(1);
    expect(reqFrames(socket2, "terminal:resize")[0]?.a).toEqual([PANE_KEY, 80, 24]);
  });

  it("ignores an out-of-range size", () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    h.input.resize(0, 24);
    h.input.resize(80, 1001);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    expect(reqFrames(socket, "terminal:resize")).toHaveLength(0);
  });
});

describe("createTerminalInput: logging", () => {
  it("logs only phase/id/len — never the command bytes or the cols/rows", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h);
    const secret = "rm -rf ~/no-thanks";
    const pending = h.input.sendText(secret);
    const sendFrame = reqFrames(socket, "terminal:input")[0];
    socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: sendFrame?.id, v: null }) });
    await pending;

    h.input.resize(137, 53);
    h.clock.advance(RESIZE_DEBOUNCE_MS);
    const resizeFrame = reqFrames(socket, "terminal:resize")[0];
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "res", id: resizeFrame?.id, v: null }),
    });
    await Promise.resolve();

    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain("137");
      expect(line).not.toContain("53");
    }
    expect(h.logs.some((line) => line.startsWith("terminal-input: "))).toBe(true);
  });
});
