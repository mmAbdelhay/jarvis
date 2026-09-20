// Tests for the session stream store (Task 4, fix round 1): attach/
// re-attach against a real RpcClient (Task 3) driven through a fake
// transport and fake clock. See
// the mobile milestone 7, task 4 plan (docs/superpowers/plans),
// task-4-review.md and progress.md's amending ruling (I2/I3/I4) for the
// behaviour under test.

import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import type { Credential, Endpoint } from "./rpc-client";
import { createRpcClient } from "./rpc-client";
import { ATTACH_BUFFER_MAX_CHARS, createSessionStream } from "./session-stream";
import type { TerminalSink } from "./session-stream";
import { gapMarker } from "./stream-cursor";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };
const SESSION_ID = "s1";

function createEnv() {
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
  return { transport, clock, logs, client };
}

/** The store under test shares its host's clock, exactly as a screen would
 * (one fake clock drives both the RpcClient's own timers — handshake,
 * request timeout, backoff — and the store's snapshot-retry timers). */
function createStream(
  client: ReturnType<typeof createRpcClient>,
  clock: ReturnType<typeof createFakeClock>,
  log: (line: string) => void = () => {},
) {
  return createSessionStream({ client, sessionId: SESSION_ID, log, clock });
}

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function completeHandshake(
  transport: ReturnType<typeof createFakeTransport>,
  capabilities: string[] = ["session:output"],
): FakeSocket {
  const socket = latestSocket(transport);
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities }),
  });
  return socket;
}

type ParsedFrame = { t: string; [key: string]: unknown };

function parsedFrames(socket: FakeSocket): ParsedFrame[] {
  return socket.sent.map((s) => JSON.parse(s) as ParsedFrame);
}

function reqFrames(socket: FakeSocket): ParsedFrame[] {
  return parsedFrames(socket).filter((f) => f.t === "req");
}

function createRecordingSink(): TerminalSink & { writes: string[]; resets: number } {
  const writes: string[] = [];
  let resets = 0;
  return {
    writes,
    get resets() {
      return resets;
    },
    write(data: string) {
      writes.push(data);
    },
    reset() {
      resets += 1;
    },
  };
}

function pushFrame(socket: FakeSocket, seq: number, payload: unknown, dropped?: number): void {
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "psh", ch: "session:output", p: payload, seq, dropped }),
  });
}

/** `RpcClient.call` resolves its promise synchronously, but the `.then` this
 * store attaches to it only runs as a microtask — every test that emits a
 * frame the store reacts to through that promise must flush the microtask
 * queue before asserting. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function answerSnapshot(socket: FakeSocket, id: number, value: unknown): Promise<void> {
  socket.emit({ kind: "message", text: encodeMessage({ t: "res", id, v: value }) });
  await flush();
}

async function errorSnapshot(
  socket: FakeSocket,
  id: number,
  code: "internal",
  text: string,
): Promise<void> {
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "err", id, code, text, language: "en" }),
  });
  await flush();
}

async function dropSocket(socket: FakeSocket): Promise<void> {
  socket.emit({ kind: "close", code: 1006, reason: "dropped" });
  await flush();
}

/** Advances the shared fake clock past RpcClient's own 30 000ms request
 * timeout and flushes the resulting promise rejection through to the
 * store. */
async function advanceRequestTimeout(
  clock: ReturnType<typeof createFakeClock>,
  socket: FakeSocket,
): Promise<void> {
  // Keep the connection alive as a real server would while only the
  // snapshot reply stalls. The watchdog is a separate failure mode.
  clock.advance(15_000);
  socket.emit({ kind: "message", text: encodeMessage({ t: "ping", seq: 1 }) });
  clock.advance(15_000);
  socket.emit({ kind: "message", text: encodeMessage({ t: "ping", seq: 2 }) });
  await flush();
}

describe("createSessionStream: open", () => {
  it("sends one sub add frame then one req session:snapshot, in that order", () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);

    stream.open(createRecordingSink());

    const frames = parsedFrames(socket);
    const relevant = frames.filter((f) => f.t === "sub" || f.t === "req");
    expect(relevant).toHaveLength(2);
    expect(relevant[0]).toEqual({ t: "sub", add: [{ ch: "session:output", key: SESSION_ID }] });
    expect(relevant[1]).toMatchObject({ t: "req", ch: "session:snapshot", a: [SESSION_ID] });
    expect(stream.get().phase).toBe("attaching");
  });

  it("a second open without close is a no-op", () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);

    stream.open(createRecordingSink());
    const framesAfterFirst = parsedFrames(socket).length;
    stream.open(createRecordingSink());
    expect(parsedFrames(socket)).toHaveLength(framesAfterFirst);
  });

  it(
    "Minor 2: does not send session:snapshot before the client reaches open " +
      "(waits for the open event instead of queueing)",
    () => {
      const { client, transport, clock } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL); // still "connecting"/"authenticating"
      const stream = createStream(client, clock);

      stream.open(createRecordingSink());
      expect(stream.get().phase).toBe("waiting");

      const socket = completeHandshake(transport);
      expect(reqFrames(socket)).toHaveLength(1); // exactly one, sent once open fires
      expect(stream.get().phase).toBe("attaching");
    },
  );
});

describe("createSessionStream: attach buffering", () => {
  it(
    "buffers pushes before the snapshot answer and drains them without duplicates " +
      "[bite-proof: write pushes live while attaching; 'abc' is written twice]",
    async () => {
      const { client, transport, clock } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport);
      const stream = createStream(client, clock);
      const sink = createRecordingSink();
      stream.open(sink);

      pushFrame(socket, 1, { sessionId: SESSION_ID, chunk: "abc", offset: 0 });
      pushFrame(socket, 2, { sessionId: SESSION_ID, chunk: "de", offset: 3 });
      expect(sink.writes).toEqual([]);

      const req = reqFrames(socket)[0];
      await answerSnapshot(socket, req.id as number, { text: "abc", end: 3 });

      expect(sink.writes).toEqual(["abc", "de"]);
      expect(stream.get().phase).toBe("live");
    },
  );

  it("a push for another session never reaches the sink, and is counted as ignored", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    const sink = createRecordingSink();
    stream.open(sink);

    const req = reqFrames(socket)[0];
    await answerSnapshot(socket, req.id as number, { text: "", end: 0 });
    pushFrame(socket, 1, { sessionId: "s2", chunk: "nope", offset: 0 });

    expect(sink.writes).toEqual([]);
    expect(stream.get().ignoredCount).toBe(1);
  });

  it("a malformed push never reaches the sink, and is counted as ignored", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    const sink = createRecordingSink();
    stream.open(sink);

    const req = reqFrames(socket)[0];
    await answerSnapshot(socket, req.id as number, { text: "", end: 0 });
    // Missing the required `offset` field: parseStreamChunk rejects it.
    pushFrame(socket, 1, { sessionId: SESSION_ID, chunk: "nope" });

    expect(sink.writes).toEqual([]);
    expect(stream.get().ignoredCount).toBe(1);
  });

  it("initial attach with a large end shows no marker", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    const sink = createRecordingSink();
    stream.open(sink);

    const req = reqFrames(socket)[0];
    await answerSnapshot(socket, req.id as number, { text: "xyz", end: 1000 });

    expect(sink.writes).toEqual(["xyz"]);
    expect(stream.get().gapCount).toBe(0);
  });

  it(
    "buffer cap: pushes exceeding ATTACH_BUFFER_MAX_CHARS before the snapshot answers drop the " +
      "oldest, carrying its dropped count onto the survivor, and write one marker",
    async () => {
      const { client, transport, clock } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport);
      const stream = createStream(client, clock);
      const sink = createRecordingSink();
      stream.open(sink);

      const half = ATTACH_BUFFER_MAX_CHARS / 2 + 50_000; // two halves exceed the cap together
      const chunkA = "a".repeat(half);
      const chunkB = "b".repeat(half);
      // chunkA carries its own dropped=500 (Minor 4): evicting it must not
      // lose that count — it lands on chunkB's entry.
      pushFrame(socket, 1, { sessionId: SESSION_ID, chunk: chunkA, offset: 0 }, 500);
      pushFrame(socket, 2, { sessionId: SESSION_ID, chunk: chunkB, offset: half });

      const req = reqFrames(socket)[0];
      await answerSnapshot(socket, req.id as number, { text: "", end: 0 });

      // Compared as booleans, not with a direct string equality, so a
      // failure here doesn't dump a ~500 000-character diff.
      expect(sink.writes.length).toBe(2);
      expect(sink.writes[0] === gapMarker(500)).toBe(true);
      expect(sink.writes[1] === chunkB).toBe(true);
      expect(stream.get().gapCount).toBe(1);
      expect(stream.get().droppedBytes).toBe(500);
    },
  );
});

describe("createSessionStream: live pushes (I2 — marker only on a real gap)", () => {
  async function openAndAttach(
    client: ReturnType<typeof createRpcClient>,
    clock: ReturnType<typeof createFakeClock>,
    socket: FakeSocket,
    sink: TerminalSink,
    snapshot: unknown,
  ) {
    const stream = createStream(client, clock);
    stream.open(sink);
    const req = reqFrames(socket)[0];
    await answerSnapshot(socket, req.id as number, snapshot);
    return stream;
  }

  it("a dropped push with a matching offset gap writes the marker, then the text", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const sink = createRecordingSink();
    const stream = await openAndAttach(client, clock, socket, sink, { text: "abcde", end: 5 });
    expect(stream.get().phase).toBe("live");

    pushFrame(socket, 2, { sessionId: SESSION_ID, chunk: "later", offset: 100 }, 2048);

    expect(sink.writes).toEqual(["abcde", gapMarker(2048), "later"]);
    expect(stream.get().gapCount).toBe(1);
    expect(stream.get().droppedBytes).toBe(2048);
  });

  it(
    "I2 bite-proof: a push already fully covered by the snapshot draws no marker even when " +
      "dropped > 0 [bite-proof: use `dropped > 0` alone as the gap test; a marker is drawn]",
    async () => {
      const { client, transport, clock } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport);
      const sink = createRecordingSink();
      const stream = await openAndAttach(client, clock, socket, sink, {
        text: "abcdef",
        end: 6,
      });
      expect(stream.get().phase).toBe("live");

      // The laptop head-dropped 4 bytes, but the snapshot already covers
      // offset..offset+chunk.length (4..6 <= rendered 6): nothing is
      // missing, so no marker, no gap, no dropped-byte total.
      pushFrame(socket, 2, { sessionId: SESSION_ID, chunk: "ef", offset: 4 }, 4);

      expect(sink.writes).toEqual(["abcdef"]);
      expect(stream.get().gapCount).toBe(0);
      expect(stream.get().droppedBytes).toBe(0);
    },
  );
});

describe("createSessionStream: reconnect", () => {
  it(
    "re-attaches after welcome; sub is re-sent before req; only the missed tail is written " +
      "[bite-proof: skip re-attach on `open`; 'fgh' is never written]",
    async () => {
      const { client, transport, clock } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket1 = completeHandshake(transport);
      const sink = createRecordingSink();
      const stream = createStream(client, clock);
      stream.open(sink);
      const req1 = reqFrames(socket1)[0];
      await answerSnapshot(socket1, req1.id as number, { text: "abcde", end: 5 });
      expect(stream.get().phase).toBe("live");

      await dropSocket(socket1);
      expect(stream.get().phase).toBe("waiting");

      clock.advance(1_000); // first backoff delay at random()=0.5
      const socket2 = completeHandshake(transport);
      const frames2 = parsedFrames(socket2).filter((f) => f.t === "sub" || f.t === "req");
      expect(frames2[0]?.t).toBe("sub");
      expect(frames2[1]).toMatchObject({ t: "req", ch: "session:snapshot" });

      const req2 = frames2[1] as ParsedFrame;
      await answerSnapshot(socket2, req2.id as number, { text: "abcdefgh", end: 8 });

      expect(sink.writes).toEqual(["abcde", "fgh"]);
      expect(stream.get().phase).toBe("live");
    },
  );

  it("Minor 1: pushes arriving after the new welcome, before the new snapshot answer, are buffered", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket1 = completeHandshake(transport);
    const sink = createRecordingSink();
    const stream = createStream(client, clock);
    stream.open(sink);
    const req1 = reqFrames(socket1)[0];
    await answerSnapshot(socket1, req1.id as number, { text: "abcde", end: 5 });

    await dropSocket(socket1);
    clock.advance(1_000);
    const socket2 = completeHandshake(transport);
    expect(stream.get().phase).toBe("attaching"); // re-attach fired synchronously on "open"

    // Arrives before the snapshot answer: must be buffered, not applied live.
    pushFrame(socket2, 1, { sessionId: SESSION_ID, chunk: "zzz", offset: 8 });
    expect(sink.writes).toEqual(["abcde"]);

    const req2 = reqFrames(socket2)[0];
    await answerSnapshot(socket2, req2.id as number, { text: "abcdefgh", end: 8 });

    // The snapshot's own tail, then the buffered push, with no duplicate.
    expect(sink.writes).toEqual(["abcde", "fgh", "zzz"]);
  });

  it("Minor 1: a stale snapshot answer superseded by a reconnect (not just a restart) is ignored", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket1 = completeHandshake(transport);
    const sink = createRecordingSink();
    const stream = createStream(client, clock);
    stream.open(sink);
    const req1 = reqFrames(socket1)[0];

    // The reconnect starts a new generation before req1 is ever answered.
    await dropSocket(socket1);
    clock.advance(1_000);
    const socket2 = completeHandshake(transport);
    const req2 = reqFrames(socket2)[0];
    expect(req2.id).not.toBe(req1.id);

    // req1's socket is gone, but even if a stray "res" for it arrived, the
    // store must ignore it (stale generation) rather than write from it.
    // We can't emit on a closed socket's transport event stream in this
    // fake, so we assert the generation guard directly: answering req2
    // first, then simulating a late req1 answer on socket2 (same id
    // space) must not overwrite what req2 already produced.
    await answerSnapshot(socket2, req2.id as number, { text: "fresh", end: 5 });
    expect(sink.writes).toEqual(["fresh"]);

    await answerSnapshot(socket2, req1.id as number, { text: "stale", end: 5 });
    expect(sink.writes).toEqual(["fresh"]); // untouched by the stale id's answer
  });

  it("a stale snapshot answer (superseded by restart) is ignored", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const sink1 = createRecordingSink();
    const stream = createStream(client, clock);
    stream.open(sink1);
    const req1 = reqFrames(socket)[0];

    const sink2 = createRecordingSink();
    stream.restart(sink2);
    const req2 = reqFrames(socket)[1];
    expect(req2.id).not.toBe(req1.id);

    await answerSnapshot(socket, req1.id as number, { text: "stale", end: 5 });
    expect(sink1.writes).toEqual([]);
    expect(sink2.writes).toEqual([]);

    await answerSnapshot(socket, req2.id as number, { text: "fresh", end: 5 });
    expect(sink2.writes).toEqual(["fresh"]);
  });
});

describe("createSessionStream: snapshot failures", () => {
  it("an in-flight drop maps the snapshot call to offline -> phase waiting", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    stream.open(createRecordingSink());
    expect(reqFrames(socket)).toHaveLength(1);

    await dropSocket(socket);

    expect(stream.get().phase).toBe("waiting");
  });

  it("a remote error maps to phase failed with the error text unchanged", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    stream.open(createRecordingSink());
    const req = reqFrames(socket)[0];

    await errorSnapshot(socket, req.id as number, "internal", "boom");

    const view = stream.get();
    expect(view.phase).toBe("failed");
    expect(view.error).toEqual({ kind: "remote", code: "internal", text: "boom", language: "en" });
  });

  it("an invalid snapshot value maps to phase failed with no error", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    stream.open(createRecordingSink());
    const req = reqFrames(socket)[0];

    await answerSnapshot(socket, req.id as number, { text: "hi", end: 1 }); // end < text.length

    const view = stream.get();
    expect(view.phase).toBe("failed");
    expect(view.error).toBeUndefined();
  });

  it("I3: a snapshot timeout is retried after 1s then 3s, staying attached and buffering", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const sink = createRecordingSink();
    const stream = createStream(client, clock);
    stream.open(sink);
    expect(reqFrames(socket)).toHaveLength(1);

    // Attempt 1 times out.
    await advanceRequestTimeout(clock, socket);
    expect(stream.get().phase).toBe("attaching"); // never drops to "waiting"
    expect(reqFrames(socket)).toHaveLength(1); // the retry hasn't fired yet

    // A push during the gap between attempts must still be buffered, not
    // dropped, not applied live.
    pushFrame(socket, 1, { sessionId: SESSION_ID, chunk: "buffered", offset: 0 });
    expect(sink.writes).toEqual([]);

    clock.advance(1_000); // first retry delay
    expect(reqFrames(socket)).toHaveLength(2);

    // Attempt 2 also times out.
    await advanceRequestTimeout(clock, socket);
    expect(stream.get().phase).toBe("attaching");
    expect(reqFrames(socket)).toHaveLength(2);

    clock.advance(3_000); // second retry delay
    expect(reqFrames(socket)).toHaveLength(3);

    // Attempt 3 succeeds: the buffered push drains with no duplicate.
    const req3 = reqFrames(socket)[2];
    await answerSnapshot(socket, req3.id as number, { text: "", end: 0 });

    expect(sink.writes).toEqual(["buffered"]);
    expect(stream.get().phase).toBe("live");
  });

  it("I3: three consecutive timeouts move to failed; retry() restarts the attach", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const sink = createRecordingSink();
    const stream = createStream(client, clock);
    stream.open(sink);

    await advanceRequestTimeout(clock, socket); // attempt 1
    clock.advance(1_000);
    await advanceRequestTimeout(clock, socket); // attempt 2
    clock.advance(3_000);
    socket.emit({ kind: "message", text: encodeMessage({ t: "ping", seq: 1 }) });
    await advanceRequestTimeout(clock, socket); // attempt 3 — no more retries

    expect(stream.get().phase).toBe("failed");
    expect(stream.get().error).toBeUndefined();
    expect(reqFrames(socket)).toHaveLength(3);

    stream.retry();
    expect(stream.get().phase).toBe("attaching");
    expect(reqFrames(socket)).toHaveLength(4);

    const req4 = reqFrames(socket)[3];
    await answerSnapshot(socket, req4.id as number, { text: "ok", end: 2 });
    expect(sink.writes).toEqual(["ok"]);
    expect(stream.get().phase).toBe("live");
  });

  it(
    "final review M6: retry() is a no-op unless phase is failed " +
      '[bite-proof: drop the `view.phase !== "failed"` check and a stray retry() while ' +
      "live sends a second req frame]",
    async () => {
      const { client, transport, clock } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport);
      const sink = createRecordingSink();
      const stream = createStream(client, clock);
      stream.open(sink);
      const req1 = reqFrames(socket)[0];
      await answerSnapshot(socket, req1.id as number, { text: "ok", end: 2 });
      expect(stream.get().phase).toBe("live");

      stream.retry();
      expect(stream.get().phase).toBe("live");
      expect(reqFrames(socket)).toHaveLength(1); // no second snapshot request

      stream.close();
      stream.retry(); // not opened, and not failed either
      expect(reqFrames(socket)).toHaveLength(1);
    },
  );

  it(
    "Minor 3: a retry timer firing while the socket is down does not queue a snapshot; " +
      "the next open event alone re-attaches " +
      "[bite-proof: drop the client.state() === 'open' gate; a second req frame appears on socket2]",
    async () => {
      const { client, transport, clock } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket1 = completeHandshake(transport);
      const sink = createRecordingSink();
      const stream = createStream(client, clock);
      stream.open(sink);

      await advanceRequestTimeout(clock, socket1); // attempt 1 times out; retry timer set for +1s
      expect(reqFrames(socket1)).toHaveLength(1);

      // The socket drops before the retry timer fires. Backoff (random=0.5)
      // schedules the reconnect for the same +1s mark as the retry timer;
      // the retry timer was scheduled first, so it fires first, while the
      // client is still "reconnecting" (not "open").
      await dropSocket(socket1);
      expect(stream.get().phase).toBe("waiting");
      expect(client.state()).not.toBe("open");

      clock.advance(1_000); // fires the gated retry timer, then starts the reconnect attempt
      expect(client.state()).not.toBe("open"); // still connecting the new socket

      const socket2 = completeHandshake(transport); // welcome -> "open" -> the real re-attach
      expect(reqFrames(socket2)).toHaveLength(1); // not 2: the gated timer queued nothing

      const req2 = reqFrames(socket2)[0];
      await answerSnapshot(socket2, req2.id as number, { text: "ok", end: 2 });
      expect(sink.writes).toEqual(["ok"]);
      expect(stream.get().phase).toBe("live");
    },
  );
});

describe("createSessionStream: close", () => {
  it("sends one sub drop frame; a late answer and later pushes write nothing", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    const sink = createRecordingSink();
    stream.open(sink);
    const req = reqFrames(socket)[0];

    stream.close();

    const subFrames = parsedFrames(socket).filter((f) => f.t === "sub");
    expect(
      subFrames.some(
        (f) =>
          JSON.stringify(f.drop) === JSON.stringify([{ ch: "session:output", key: SESSION_ID }]),
      ),
    ).toBe(true);

    await answerSnapshot(socket, req.id as number, { text: "late", end: 4 });
    pushFrame(socket, 1, { sessionId: SESSION_ID, chunk: "later", offset: 0 });

    expect(sink.writes).toEqual([]);
    expect(stream.get().phase).toBe("idle");
  });

  it("Minor 3: close resets rendered, so the next open re-fetches the full retained tail", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    const sink1 = createRecordingSink();
    stream.open(sink1);
    const req1 = reqFrames(socket)[0];
    await answerSnapshot(socket, req1.id as number, { text: "abcde", end: 5 });
    stream.close();

    const sink2 = createRecordingSink();
    stream.open(sink2);
    const req2 = reqFrames(socket)[1];
    // A fresh open after close is a fresh attach: the full retained text,
    // not just a "missing tail" computed against the old `rendered`.
    await answerSnapshot(socket, req2.id as number, { text: "abcde", end: 5 });

    expect(sink2.writes).toEqual(["abcde"]);
  });
});

describe("createSessionStream: restart", () => {
  it("writes a fresh snapshot in full to the new sink, with no marker", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    const sink1 = createRecordingSink();
    stream.open(sink1);
    const req1 = reqFrames(socket)[0];
    await answerSnapshot(socket, req1.id as number, { text: "abcde", end: 5 });

    const sink2 = createRecordingSink();
    stream.restart(sink2);
    const req2 = reqFrames(socket)[1];
    await answerSnapshot(socket, req2.id as number, { text: "xyz", end: 9000 });

    expect(sink2.writes).toEqual(["xyz"]);
    expect(sink1.writes).toEqual(["abcde"]);
  });
});

describe("createSessionStream: logging", () => {
  it("never logs any chunk or snapshot text used anywhere in this scenario", async () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const clock = createFakeClock();
    const logs: string[] = [];
    const stream = createStream(client, clock, (l) => logs.push(l));
    const sink = createRecordingSink();
    stream.open(sink);
    const req = reqFrames(socket)[0];

    const secretTexts = ["SNAPSHOT_SECRET", "PUSH_SECRET_1", "PUSH_SECRET_2", "OTHER_SESSION_TEXT"];
    await answerSnapshot(socket, req.id as number, { text: "SNAPSHOT_SECRET", end: 16 });
    pushFrame(socket, 1, { sessionId: SESSION_ID, chunk: "PUSH_SECRET_1", offset: 16 });
    pushFrame(socket, 2, { sessionId: SESSION_ID, chunk: "PUSH_SECRET_2", offset: 29 }, 4096);
    pushFrame(socket, 3, { sessionId: "other-session", chunk: "OTHER_SESSION_TEXT", offset: 0 });
    stream.close();

    for (const secret of secretTexts) {
      expect(logs.some((l) => l.includes(secret))).toBe(false);
    }
    expect(logs.every((l) => /^session-stream: /.test(l))).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });
});
