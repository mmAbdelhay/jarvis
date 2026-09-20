import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./lib/clock";
import { createFakeTransport, type FakeSocket } from "./lib/fake-transport";
import { createRpcClient } from "./lib/rpc-client";
import { createSessionInput } from "./lib/session-input";
import { createSessionStream } from "./lib/session-stream";
import { createSessionsStore } from "./lib/sessions-store";
import { gapMarker } from "./lib/stream-cursor";

type Frame = { t: string; id: number; ch: string; a: unknown[]; add?: unknown[]; drop?: unknown[] };
function frames(socket: FakeSocket): Frame[] {
  return socket.sent.map((text) => JSON.parse(text) as Frame);
}
function request(socket: FakeSocket, channel: string): Frame {
  const frame = frames(socket).findLast((item) => item.t === "req" && item.ch === channel);
  if (!frame) throw new Error(`missing request ${channel}`);
  return frame;
}
async function answer(socket: FakeSocket, channel: string, value: unknown) {
  // No extra `await Promise.resolve()` hop is needed here: `emit()` below
  // resolves the matching in-flight request synchronously (rpc-client's
  // `handleRes` calls `entry.resolve()` directly from the message handler),
  // which schedules every downstream `await`/`.then()` continuation (store
  // updates, stream writes, `SendResult` mapping) as a microtask *before*
  // this async function's own body finishes running. Because every call
  // site does `await answer(...)`, that single inherent hop already runs
  // after all of those continuations, so a second hop here was dead weight
  // — proved by running the suite with 0, 1 and 2 explicit hops: all three
  // pass identically.
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "res", id: request(socket, channel).id, v: value }),
  });
}
function welcome(socket: FakeSocket) {
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({
      t: "welcome",
      v: PROTOCOL_VERSION,
      capabilities: ["sessions:update", "session:output"],
    }),
  });
}

describe("session scenario over the real client and stores", () => {
  it("deduplicates attach, sends input once, reconnects without replay and releases subscriptions", async () => {
    const transport = createFakeTransport();
    const clock = createFakeClock();
    const logs: string[] = [];
    const token = "T".repeat(43);
    const client = createRpcClient({
      transport,
      clock,
      random: () => 0.5,
      client: "session-test",
      log: (line) => logs.push(line),
    });
    client.connect(
      { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) },
      { deviceId: "d".repeat(32), token },
    );
    const first = transport.sockets[0];
    if (!first) throw new Error("missing first socket");
    welcome(first);
    expect(frames(first)[0]).toMatchObject({ t: "hello", token });
    expect(client.state()).toBe("open");

    const sessions = createSessionsStore({ client });
    const beforeFocus = first.sent.length;
    sessions.focus();
    expect(frames(first).find((item) => item.t === "sub")?.add).toEqual(["sessions:update"]);
    // Important (review r1): existence-only checks tolerate a duplicate
    // `sessions:list` request; pin the exact count so a superseded-refresh
    // regression (the class Task 4/6 fix rounds targeted) fails loudly.
    expect(first.sent.length - beforeFocus).toBe(2); // sub add + one sessions:list req
    const row = {
      id: "s1",
      summary: "Task",
      project: "Jarvis",
      projectPath: "/Users/me/Jarvis",
      agentId: "claude",
      state: "running",
      startedAt: 1,
      lastActivityAt: 1,
    };
    await answer(first, "sessions:list", [row, { ...row, id: "s2", state: "done" }]);
    expect(sessions.find("s1")?.state).toBe("running");
    const writes: string[] = [];
    const stream = createSessionStream({
      client,
      clock,
      sessionId: "s1",
      log: (line) => logs.push(line),
    });
    const beforeOpen = first.sent.length;
    stream.open({
      write: (text) => writes.push(text),
      reset: () => {
        writes.length = 0;
      },
    });
    expect(
      frames(first)
        .filter((item) => item.t === "sub")
        .at(-1)?.add,
    ).toEqual([{ ch: "session:output", key: "s1" }]);
    // Important (review r1): pin the exact count so a duplicate
    // `session:snapshot` attach (a stray retry, or a second `open()`) fails.
    expect(first.sent.length - beforeOpen).toBe(2); // sub add + one snapshot req
    let seq = 0;
    function push(socket: FakeSocket, chunk: string, offset: number, dropped?: number) {
      socket.emit({
        kind: "message",
        text: encodeMessage({
          t: "psh",
          ch: "session:output",
          seq: ++seq,
          p: { sessionId: "s1", chunk, offset },
          dropped,
        }),
      });
    }
    push(first, "lo wo", 3);
    expect(request(first, "session:snapshot").a).toEqual(["s1"]);
    await answer(first, "session:snapshot", { text: "hello", end: 5 });
    expect(writes.join("")).toBe("hello wo");
    push(first, "rld", 8);
    expect(writes.join("")).toBe("hello world");
    push(first, "!", 12, 1);
    expect(writes.slice(-2)).toEqual([gapMarker(1), "!"]);
    expect(stream.get().gapCount).toBe(1);

    const input = createSessionInput({
      client,
      clock,
      sessionId: "s1",
      log: (line) => logs.push(line),
    });
    for (const [send, expected] of [
      [() => input.sendText("1"), "1"],
      [() => input.sendKey("enter"), "\r"],
      [
        () => {
          input.armCtrl();
          return input.sendText("c");
        },
        "\x03",
      ],
    ] as const) {
      const beforeSend = first.sent.length;
      const pending = send();
      // Important (review r1): exactly one frame per call — a duplicate
      // send would otherwise pass silently as long as one of the two was
      // eventually answered.
      expect(first.sent.length - beforeSend).toBe(1);
      expect(request(first, "session:input").a).toEqual(["s1", expected]);
      await answer(first, "session:input", null);
      expect(await pending).toEqual({ kind: "sent" });
    }
    const beforeResize = first.sent.length;
    input.resize(48, 30);
    expect(first.sent.length).toBe(beforeResize); // debounced: nothing sent yet
    clock.advance(300);
    expect(first.sent.length - beforeResize).toBe(1); // exactly one session:resize frame
    expect(request(first, "session:resize").a).toEqual(["s1", 48, 30]);
    await answer(first, "session:resize", null);

    first.emit({ kind: "close", code: 1006, reason: "drop" });
    expect(client.state()).toBe("reconnecting");
    expect(await input.sendText("rm -rf /tmp/x")).toEqual({ kind: "offline" });
    // F15 (M7 T9, deferred): checked *before* the backoff timer fires, so
    // an eager (un-debounced) reconnect — a second socket opened on close
    // rather than after the delay — would be caught here rather than
    // silently passing once the advance below makes a second socket
    // expected either way.
    expect(transport.sockets).toHaveLength(1);
    clock.advance(1000);
    const second = transport.sockets[1];
    if (!second) throw new Error("missing reconnect socket");
    welcome(second);
    expect(client.state()).toBe("open");
    const reconnect = frames(second);
    expect(reconnect[0].t).toBe("hello");
    expect(reconnect[1]).toEqual({
      t: "sub",
      add: ["sessions:update", { ch: "session:output", key: "s1" }],
    });
    expect(reconnect.filter((item) => item.t === "sub")).toHaveLength(1);
    expect(reconnect.slice(2).every((item) => item.t === "req")).toBe(true);
    expect([...reconnect.slice(2).map((item) => item.ch)].sort()).toEqual([
      "session:resize",
      "session:snapshot",
      "sessions:list",
    ]);
    expect(reconnect.some((item) => item.ch === "session:input")).toBe(false);
    await answer(second, "sessions:list", [row]);
    expect(request(second, "session:snapshot").a).toEqual(["s1"]);
    await answer(second, "session:snapshot", { text: "hello world!?", end: 14 });
    await answer(second, "session:resize", null);
    expect(writes.join("")).toBe(`hello world${gapMarker(1)}!?`);

    const unsubscribe = sessions.subscribe(() =>
      input.setEnded(sessions.find("s1")?.state === "done"),
    );
    second.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "sessions:update",
        seq: ++seq,
        p: [{ ...row, state: "done" }],
      }),
    });
    const before = second.sent.length;
    expect(await input.sendKey("enter")).toEqual({ kind: "ended" });
    expect(second.sent).toHaveLength(before);
    unsubscribe();
    stream.close();
    sessions.blur();
    input.dispose();
    expect(frames(second).slice(-2)).toEqual([
      { t: "sub", drop: [{ ch: "session:output", key: "s1" }] },
      { t: "sub", drop: ["sessions:update"] },
    ]);
    // Minor (review r1): the reconnect-instant check above (:185-192) only
    // covers frames present right after resubscribe; sweep the second
    // socket's entire lifetime — through the snapshot answer, the
    // `sessions:update` push and the drops — so a replay fired later could
    // not hide from it.
    expect(frames(second).some((item) => item.ch === "session:input")).toBe(false);
    for (const secret of [token, "rm -rf", "hello", "world", "\x03"])
      expect(logs.some((line) => line.includes(secret))).toBe(false);
    client.disconnect();
    const afterDisconnect = second.sent.length;
    clock.advance(60_000);
    expect(transport.sockets).toHaveLength(2);
    expect(second.sent).toHaveLength(afterDisconnect);
  });
});
