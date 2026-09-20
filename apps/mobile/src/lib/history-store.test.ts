import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import type { Credential, Endpoint } from "./rpc-client";
import { createRpcClient } from "./rpc-client";
import { createHistoryStore } from "./history-store";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };

function createEnv() {
  const transport = createFakeTransport();
  const clock = createFakeClock();
  const client = createRpcClient({
    transport,
    clock,
    random: () => 0.5,
    client: "jarvis-mobile-test",
    log: () => {},
  });
  client.connect(ENDPOINT, CREDENTIAL);
  const socket = latestSocket(transport);
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: [] }),
  });
  return { client, transport, clock, socket };
}

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function frames(socket: FakeSocket): Array<{ t: string; id?: number; ch?: string; a?: unknown[] }> {
  return socket.sent.map((text) => JSON.parse(text));
}

function reqs(socket: FakeSocket, ch?: string) {
  return frames(socket).filter(
    (frame) => frame.t === "req" && (ch === undefined || frame.ch === ch),
  );
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function answer(socket: FakeSocket, id: number, value: unknown): Promise<void> {
  socket.emit({ kind: "message", text: encodeMessage({ t: "res", id, v: value }) });
  await flush();
}

function session(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    project: "jarvis",
    projectPath: "/repo",
    agentId: "codex",
    state: "done",
    summary: "جلسة سابقة",
    startedAt: 1,
    lastActivityAt: 10,
    endedAt: 12,
    ...overrides,
  };
}

describe("createHistoryStore", () => {
  it("loads history and only fetches transcript for a selected known session", async () => {
    const { client, socket } = createEnv();
    const store = createHistoryStore({ client });

    store.open();
    expect(reqs(socket, "history:list")[0]).toMatchObject({ ch: "history:list", a: [] });
    await answer(socket, reqs(socket, "history:list")[0]?.id as number, [
      session("s1"),
      session("s2", { summary: "older", lastActivityAt: 1 }),
    ]);

    store.select("missing");
    expect(reqs(socket, "session:transcript")).toHaveLength(0);

    store.select("s1");
    expect(reqs(socket, "session:transcript")[0]).toMatchObject({
      ch: "session:transcript",
      a: ["s1"],
    });
    await answer(socket, reqs(socket, "session:transcript")[0]?.id as number, [
      { role: "user", text: "<script>alert(1)</script>", tools: [] },
    ]);

    expect(store.get()).toMatchObject({
      selectedId: "s1",
      transcript: [{ role: "user", text: "<script>alert(1)</script>", tools: [] }],
      loading: false,
    });
  });

  it("treats an empty transcript as a valid empty state", async () => {
    const { client, socket } = createEnv();
    const store = createHistoryStore({ client });
    store.open();
    await answer(socket, reqs(socket, "history:list")[0]?.id as number, [session("s1")]);

    store.select("s1");
    await answer(socket, reqs(socket, "session:transcript")[0]?.id as number, []);

    expect(store.get().transcript).toEqual([]);
    expect(store.get().notice).toBeUndefined();
  });

  it("refreshes history on reconnect without emitting mutation or live-output channels", async () => {
    const { client, transport, socket, clock } = createEnv();
    const store = createHistoryStore({ client });
    store.open();
    await answer(socket, reqs(socket, "history:list")[0]?.id as number, [session("s1")]);

    socket.emit({ kind: "close", code: 1006, reason: "drop" });
    clock.advance(1_000);
    const socket2 = latestSocket(transport);
    socket2.emit({ kind: "open" });
    socket2.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: [] }),
    });
    await flush();

    expect(reqs(socket2, "history:list")).toHaveLength(1);
    const allChannels = [...socket.sent, ...socket2.sent]
      .map((text) => JSON.parse(text) as { t?: string; ch?: string; add?: unknown[] })
      .flatMap((frame) => {
        if (frame.t === "req" && frame.ch) return [frame.ch];
        if (frame.t === "sub" && Array.isArray(frame.add)) return frame.add;
        return [];
      });
    expect(allChannels).not.toContain("session:resume");
    expect(allChannels).not.toContain("session:input");
    expect(allChannels).not.toContain("session:resize");
    expect(allChannels).not.toContain("session:output");
  });
});
