import { describe, expect, it } from "vitest";
import { fakeClock } from "./clock-double.js";
import type { SocketLike } from "./io.js";
import {
  CONGESTED_BYTES,
  CONGESTION_CLOSE_MS,
  MAX_QUEUED_BYTES,
  type Outbox,
  type OutboxDeps,
  OUTBOX_TICK_MS,
  createOutbox,
} from "./outbox.js";
import type { ChannelPolicies, ChannelPolicy, StreamPolicy } from "./policy.js";
import { STREAM_MAX_BYTES } from "./policy.js";
import { encodeMessage } from "./protocol.js";
import { FakeSocket } from "./socket-double.js";

/**
 * A `SocketLike` double whose `bufferedAmount` grows by the byte length of
 * every frame it's handed, standing in for a real socket's own buffer
 * filling up synchronously inside `send()` before the OS has flushed
 * anything (Task 6, M5 final Minor 1). `FakeSocket` (socket-double.ts)
 * deliberately never does this — most tests want to control
 * `bufferedAmount` directly — but the fast-path ceiling/tick-arm behaviour
 * below only has anything to observe once a send itself is what grows the
 * buffer.
 */
class GrowingBufferSocket implements SocketLike {
  sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | undefined = undefined;
  terminated = false;
  bufferedAmount = 0;

  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
    this.bufferedAmount += Buffer.byteLength(text, "utf8");
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  terminate(): void {
    this.terminated = true;
  }
}

type StreamPayload = { k?: string; c: string; o?: number };

const streamPolicy: StreamPolicy = {
  kind: "stream",
  maxBytes: STREAM_MAX_BYTES,
  keyOf: (p) => (p as StreamPayload).k,
  chunkOf: (p) => (p as StreamPayload).c,
  offsetOf: (p) => (p as StreamPayload).o,
  withChunk: (payload, chunk, offset) => {
    const { k } = payload as StreamPayload;
    const result: StreamPayload = { c: chunk };
    if (k !== undefined) result.k = k;
    if (offset !== undefined) result.o = offset;
    return result;
  },
};

// chunkOf throws for the marker payload "boom" only — everything else on
// this channel behaves exactly like `streamPolicy`. Exists to prove the
// queued path's enqueueStream catches a throwing codec the same way the
// fast path already does (final-review fix wave item 3).
const throwingStreamPolicy: StreamPolicy = {
  ...streamPolicy,
  chunkOf: (p) => {
    if ((p as StreamPayload).c === "boom") throw new Error("boom");
    return (p as StreamPayload).c;
  },
};

const policies: ChannelPolicies = new Map<string, ChannelPolicy>([
  ["t:stream", streamPolicy],
  ["t:stream-throws", throwingStreamPolicy],
  ["t:latest", { kind: "latest" }],
  ["t:reliable", { kind: "reliable" }],
  ["t:exit", { kind: "reliable", keyOf: (p) => (p as { k?: string }).k }],
]);

function setup(overrides: Partial<OutboxDeps> = {}): {
  socket: FakeSocket;
  clock: ReturnType<typeof fakeClock>;
  logs: string[];
  congested: Array<"sustained" | "ceiling">;
  outbox: Outbox;
} {
  const socket = new FakeSocket();
  const clock = fakeClock();
  const logs: string[] = [];
  const congested: Array<"sustained" | "ceiling"> = [];
  const outbox = createOutbox({
    socket,
    policies,
    now: clock.now,
    timers: clock.timers,
    log: (line) => logs.push(line),
    onCongested: (reason) => congested.push(reason),
    ...overrides,
  });
  return { socket, clock, logs, congested, outbox };
}

function setupGrowing(overrides: Partial<OutboxDeps> = {}): {
  socket: GrowingBufferSocket;
  clock: ReturnType<typeof fakeClock>;
  congested: Array<"sustained" | "ceiling">;
  outbox: Outbox;
} {
  const socket = new GrowingBufferSocket();
  const clock = fakeClock();
  const congested: Array<"sustained" | "ceiling"> = [];
  const outbox = createOutbox({
    socket,
    policies,
    now: clock.now,
    timers: clock.timers,
    log: () => {},
    onCongested: (reason) => congested.push(reason),
    ...overrides,
  });
  return { socket, clock, congested, outbox };
}

describe("createOutbox", () => {
  it("sends replies and pushes immediately on an idle socket, pushes numbered from seq 1, no dropped", () => {
    const { socket, outbox } = setup();
    outbox.reply(encodeMessage({ t: "res", id: 1, v: "ok" }));
    outbox.push("t:latest", { x: 1 }, undefined);
    outbox.push("t:stream", { k: "p1", c: "ab", o: 0 }, "p1");

    expect(socket.sent).toEqual([
      { t: "res", id: 1, v: "ok" },
      { t: "psh", ch: "t:latest", p: { x: 1 }, seq: 1 },
      { t: "psh", ch: "t:stream", p: { k: "p1", c: "ab", o: 0 }, seq: 2 },
    ]);
  });

  it(
    "stalls while bufferedAmount is over the watermark, then flushes control before pushes on the next tick " +
      "[bite-proof: flush pushes before control]",
    () => {
      const { socket, clock, outbox } = setup();
      socket.bufferedAmount = 2 * 1024 * 1024;
      outbox.push("t:latest", { x: 1 }, undefined);
      expect(socket.sent).toEqual([]);
      outbox.reply(encodeMessage({ t: "res", id: 1, v: "ok" }));
      expect(socket.sent).toEqual([]);

      socket.bufferedAmount = 0;
      clock.advance(OUTBOX_TICK_MS);

      expect(socket.sent).toEqual([
        { t: "res", id: 1, v: "ok" },
        { t: "psh", ch: "t:latest", p: { x: 1 }, seq: 1 },
      ]);
    },
  );

  it("collapses latest into one frame that keeps its original queue position among other pushes", () => {
    const { socket, clock, outbox } = setup();
    socket.bufferedAmount = 2 * 1024 * 1024;
    outbox.push("t:latest", { x: 0 }, undefined);
    outbox.push("t:reliable", { m: "keep" }, undefined);
    for (let i = 1; i < 100; i++) outbox.push("t:latest", { x: i }, undefined);

    socket.bufferedAmount = 0;
    clock.advance(OUTBOX_TICK_MS);

    expect(socket.sent).toEqual([
      { t: "psh", ch: "t:latest", p: { x: 99 }, seq: 1 },
      { t: "psh", ch: "t:reliable", p: { m: "keep" }, seq: 2 },
    ]);
  });

  it("coalesces contiguous stream chunks into one frame", () => {
    const { socket, clock, outbox } = setup();
    socket.bufferedAmount = 2 * 1024 * 1024;
    outbox.push("t:stream", { k: "p1", c: "ab", o: 0 }, "p1");
    outbox.push("t:stream", { k: "p1", c: "cd", o: 2 }, "p1");

    socket.bufferedAmount = 0;
    clock.advance(OUTBOX_TICK_MS);

    expect(socket.sent).toEqual([
      { t: "psh", ch: "t:stream", p: { k: "p1", c: "abcd", o: 0 }, seq: 1 },
    ]);
  });

  it("skips empty stream chunks without producing a frame of their own or breaking contiguity", () => {
    const { socket, clock, outbox } = setup();
    socket.bufferedAmount = 2 * 1024 * 1024;
    outbox.push("t:stream", { k: "p1", c: "ab", o: 0 }, "p1");
    expect(outbox.pieceCount()).toBe(1);
    outbox.push("t:stream", { k: "p1", c: "", o: 2 }, "p1");
    // A zero-length chunk contiguous with the tail of an existing entry is
    // a no-op (Task 6 behaviour rule 3): no new entry, the same one entry
    // still queued.
    expect(outbox.pieceCount()).toBe(1);
    outbox.push("t:stream", { k: "p1", c: "cd", o: 2 }, "p1");
    expect(outbox.pieceCount()).toBe(1);

    socket.bufferedAmount = 0;
    clock.advance(OUTBOX_TICK_MS);

    expect(socket.sent).toEqual([
      { t: "psh", ch: "t:stream", p: { k: "p1", c: "abcd", o: 0 }, seq: 1 },
    ]);
  });

  it(
    "drops a zero-length chunk that would start a new entry at enqueue, leaving pieceCount() and " +
      "streamKeyStateCount() unchanged [bite-proof: enqueue it; count +1]",
    () => {
      const { socket, outbox } = setup();
      socket.bufferedAmount = 2 * 1024 * 1024; // stalled: goes through enqueueStream, not the fast path
      expect(outbox.pieceCount()).toBe(0);
      expect(outbox.streamKeyStateCount()).toBe(0);

      // No target for key "p1" exists yet — this chunk would have to start
      // a brand new StreamEntry, and it carries no content.
      outbox.push("t:stream", { k: "p1", c: "", o: 0 }, "p1");
      expect(outbox.pieceCount()).toBe(0);
      expect(outbox.queuedBytes()).toBe(0);
      // Task 6 fix round 1 (review minor): the drop must never even create
      // a StreamKeyState map entry for "p1" — not just leave it empty of
      // queued nodes.
      expect(outbox.streamKeyStateCount()).toBe(0);

      // A non-contiguous zero-length chunk (a gap after a real entry) is
      // the same "would start a new entry" case and is dropped the same
      // way — the real entry ahead of it is untouched, and no *second*
      // StreamKeyState appears for "p2" beyond the one its real chunk
      // already created.
      outbox.push("t:stream", { k: "p2", c: "ab", o: 0 }, "p2");
      expect(outbox.pieceCount()).toBe(1);
      expect(outbox.streamKeyStateCount()).toBe(1);
      outbox.push("t:stream", { k: "p2", c: "", o: 999 }, "p2");
      expect(outbox.pieceCount()).toBe(1);
      expect(outbox.streamKeyStateCount()).toBe(1);
    },
  );

  it("does not coalesce non-contiguous offsets", () => {
    const { socket, clock, outbox } = setup();
    socket.bufferedAmount = 2 * 1024 * 1024;
    outbox.push("t:stream", { k: "p1", c: "ab", o: 0 }, "p1");
    outbox.push("t:stream", { k: "p1", c: "xy", o: 0 }, "p1");

    socket.bufferedAmount = 0;
    clock.advance(OUTBOX_TICK_MS);

    expect(socket.sent).toEqual([
      { t: "psh", ch: "t:stream", p: { k: "p1", c: "ab", o: 0 }, seq: 1 },
      { t: "psh", ch: "t:stream", p: { k: "p1", c: "xy", o: 0 }, seq: 2 },
    ]);
  });

  it("does not coalesce a stream chunk past a reliable entry ahead of it [bite-proof: exit after data]", () => {
    const { socket, clock, outbox } = setup();
    socket.bufferedAmount = 2 * 1024 * 1024;
    outbox.push("t:stream", { k: "p1", c: "ab", o: 0 }, "p1");
    outbox.push("t:exit", { k: "p1", reason: "done" }, "p1");
    outbox.push("t:stream", { k: "p1", c: "cd", o: 2 }, "p1");

    socket.bufferedAmount = 0;
    clock.advance(OUTBOX_TICK_MS);

    expect(socket.sent).toEqual([
      { t: "psh", ch: "t:stream", p: { k: "p1", c: "ab", o: 0 }, seq: 1 },
      { t: "psh", ch: "t:exit", p: { k: "p1", reason: "done" }, seq: 2 },
      { t: "psh", ch: "t:stream", p: { k: "p1", c: "cd", o: 2 }, seq: 3 },
    ]);
  });

  it(
    "caps queued stream bytes per (channel,key) at STREAM_MAX_BYTES, dropping from the head " +
      "[bite-proof: skip the cap loop]",
    () => {
      const { socket, clock, outbox } = setup();
      socket.bufferedAmount = 2 * 1024 * 1024;
      const totalBytes = 300 * 1024;
      const chunkSize = 4 * 1024;
      let sent = 0;
      let offset = 0;
      while (sent < totalBytes) {
        outbox.push("t:stream", { k: "p1", c: "a".repeat(chunkSize), o: offset }, "p1");
        offset += chunkSize;
        sent += chunkSize;
      }

      expect(outbox.queuedBytes()).toBeLessThanOrEqual(STREAM_MAX_BYTES);

      socket.bufferedAmount = 0;
      clock.advance(OUTBOX_TICK_MS);

      expect(socket.sent).toHaveLength(1);
      const frame = socket.sent[0] as { p: StreamPayload; dropped?: number };
      const dropped = frame.dropped ?? 0;
      expect(dropped + (frame.p.c as string).length).toBe(totalBytes);
      expect(frame.p.o).toBe(dropped);
    },
  );

  it("empties the oldest same-key entry across a reliable break, moving its dropped count onto the newer one", () => {
    const { socket, clock, outbox } = setup();
    socket.bufferedAmount = 2 * 1024 * 1024;
    const aChunk = "a".repeat(5_000);
    outbox.push("t:stream", { k: "p1", c: aChunk, o: 0 }, "p1");
    outbox.push("t:reliable", { m: "break" }, undefined);
    const bChunk = "b".repeat(STREAM_MAX_BYTES);
    outbox.push("t:stream", { k: "p1", c: bChunk, o: aChunk.length }, "p1");

    socket.bufferedAmount = 0;
    clock.advance(OUTBOX_TICK_MS);

    const streamFrames = socket.sent.filter(
      (m) => (m as { ch: string }).ch === "t:stream",
    ) as Array<{
      p: StreamPayload;
      dropped?: number;
    }>;
    expect(streamFrames).toHaveLength(1);
    const [frame] = streamFrames as [{ p: StreamPayload; dropped?: number }];
    expect(frame.p.c).toBe(bChunk);
    expect(frame.dropped).toBe(aChunk.length);
  });

  it("caps each (channel,key) independently — flooding p1 never drops p2's bytes", () => {
    const { socket, clock, outbox } = setup();
    socket.bufferedAmount = 2 * 1024 * 1024;
    outbox.push("t:stream", { k: "p2", c: "hello", o: 0 }, "p2");
    let offset = 0;
    for (let i = 0; i < 100; i++) {
      const chunk = "x".repeat(4096);
      outbox.push("t:stream", { k: "p1", c: chunk, o: offset }, "p1");
      offset += chunk.length;
    }

    socket.bufferedAmount = 0;
    clock.advance(OUTBOX_TICK_MS);

    const p2 = socket.sent.find((m) => (m as { p: StreamPayload }).p.k === "p2") as {
      p: StreamPayload;
      dropped?: number;
    };
    expect(p2.p.c).toBe("hello");
    expect(p2.dropped ?? 0).toBe(0);
  });

  it(
    "logs and skips a queued stream push whose chunkOf throws, leaving the outbox usable for the next push " +
      "[bite-proof: catch chunkOf/offsetOf on the queued path]",
    () => {
      const { socket, clock, logs, outbox } = setup();
      socket.bufferedAmount = 2 * 1024 * 1024; // stalled: goes through enqueueStream, not the fast path
      outbox.push("t:stream-throws", { k: "p1", c: "boom", o: 0 }, "p1");
      outbox.push("t:stream-throws", { k: "p1", c: "ok", o: 0 }, "p1");

      socket.bufferedAmount = 0;
      clock.advance(OUTBOX_TICK_MS);

      expect(socket.sent).toEqual([
        { t: "psh", ch: "t:stream-throws", p: { k: "p1", c: "ok", o: 0 }, seq: 1 },
      ]);
      expect(logs.some((line) => line.includes("t:stream-throws"))).toBe(true);
    },
  );

  it(
    "logs and skips a purge match whose reliable keyOf throws, leaving the rest of the purge unaffected " +
      "[bite-proof: catch keyOf on the purge path]",
    () => {
      const throwingExitPolicy: ChannelPolicy = {
        kind: "reliable",
        keyOf: (p) => {
          if ((p as { k?: string }).k === "boom") throw new Error("boom");
          return (p as { k?: string }).k;
        },
      };
      const { socket, clock, logs, outbox } = setup({
        policies: new Map<string, ChannelPolicy>([
          ...policies,
          ["t:exit-throws", throwingExitPolicy],
        ]),
      });
      socket.bufferedAmount = 2 * 1024 * 1024;
      outbox.push("t:exit-throws", { k: "boom" }, "boom");
      outbox.push("t:stream", { k: "p2", c: "cd", o: 0 }, "p2");
      // Purging "p1" never matches "boom"'s entry (keyOf throws, treated as
      // no match) or "p2"'s (different key) — both stay queued.
      outbox.purge("t:exit-throws", "p1");

      socket.bufferedAmount = 0;
      clock.advance(OUTBOX_TICK_MS);

      expect(socket.sent).toEqual([
        { t: "psh", ch: "t:exit-throws", p: { k: "boom" }, seq: 1 },
        { t: "psh", ch: "t:stream", p: { k: "p2", c: "cd", o: 0 }, seq: 2 },
      ]);
      expect(logs.some((line) => line.includes("t:exit-throws"))).toBe(true);
    },
  );

  it("purge removes queued pushes for a dropped (channel,key) target, leaving others untouched", () => {
    const { socket, clock, outbox } = setup();
    socket.bufferedAmount = 2 * 1024 * 1024;
    outbox.push("t:stream", { k: "p1", c: "ab", o: 0 }, "p1");
    outbox.push("t:stream", { k: "p2", c: "cd", o: 0 }, "p2");
    outbox.purge("t:stream", "p1");

    socket.bufferedAmount = 0;
    clock.advance(OUTBOX_TICK_MS);

    expect(socket.sent).toEqual([
      { t: "psh", ch: "t:stream", p: { k: "p2", c: "cd", o: 0 }, seq: 1 },
    ]);
  });

  it("fires onCongested('sustained') once bufferedAmount stays over CONGESTED_BYTES for CONGESTION_CLOSE_MS", () => {
    const { socket, clock, congested, outbox } = setup();
    socket.bufferedAmount = 5 * 1024 * 1024;
    expect(socket.bufferedAmount).toBeGreaterThan(CONGESTED_BYTES);
    outbox.push("t:latest", { x: 1 }, undefined); // arms the tick
    clock.advance(50); // first tick: congestedSince is set here
    clock.advance(CONGESTION_CLOSE_MS - 100);
    expect(congested).toEqual([]);
    clock.advance(200);
    expect(congested).toEqual(["sustained"]);
    clock.advance(1000);
    expect(congested).toEqual(["sustained"]); // fires at most once
  });

  it("resets the sustained-congestion clock when bufferedAmount drops back under the threshold", () => {
    const { socket, clock, congested, outbox } = setup();
    socket.bufferedAmount = 5 * 1024 * 1024;
    outbox.push("t:latest", { x: 1 }, undefined);
    clock.advance(50);
    clock.advance(CONGESTION_CLOSE_MS - 500);
    socket.bufferedAmount = 3 * 1024 * 1024; // drop under CONGESTED_BYTES
    clock.advance(50); // this tick clears congestedSince
    socket.bufferedAmount = 5 * 1024 * 1024; // congested again, clock restarts
    clock.advance(CONGESTION_CLOSE_MS - 100);
    expect(congested).toEqual([]);
    clock.advance(200);
    expect(congested).toEqual(["sustained"]);
  });

  it("fires onCongested('ceiling') synchronously when one enqueue pushes past MAX_QUEUED_BYTES, then disposes", () => {
    const { socket, clock, congested, outbox } = setup();
    socket.bufferedAmount = 2 * 1024 * 1024; // stalled: reply enqueues instead of sending
    const huge = "a".repeat(17 * 1024 * 1024);
    outbox.reply(encodeMessage({ t: "res", id: 1, v: huge }));

    expect(congested).toEqual(["ceiling"]);
    expect(socket.sent).toEqual([]);
    expect(clock.pending()).toBe(0);

    socket.bufferedAmount = 0;
    clock.advance(OUTBOX_TICK_MS);
    expect(socket.sent).toEqual([]);
  });

  it(
    "a fast-path send that alone pushes bufferedAmount past the ceiling fires onCongested('ceiling') " +
      "synchronously, after the frame was already sent [bite-proof: skip the post-send check; no callback]",
    () => {
      const { socket, congested, outbox } = setupGrowing();
      const huge = "a".repeat(20 * 1024 * 1024);

      outbox.reply(encodeMessage({ t: "res", id: 1, v: huge }));

      expect(socket.bufferedAmount).toBeGreaterThan(MAX_QUEUED_BYTES);
      expect(socket.sent).toEqual([{ t: "res", id: 1, v: huge }]); // sent before the check ran
      expect(congested).toEqual(["ceiling"]);
    },
  );

  it(
    "arms the tick after a fast-path send that leaves bufferedAmount over 0, so sustained congestion is caught " +
      "without waiting for a later enqueue [bite-proof: never arm; no callback at 10s]",
    () => {
      const { socket, clock, congested, outbox } = setupGrowing();

      // A 2 MiB fast-path push leaves real bufferedAmount behind it —
      // comfortably under both thresholds, so nothing fires yet.
      outbox.push("t:latest", { x: "a".repeat(2 * 1024 * 1024) }, undefined);
      expect(socket.bufferedAmount).toBeGreaterThan(0);
      expect(socket.bufferedAmount).toBeLessThan(CONGESTED_BYTES);
      expect(congested).toEqual([]);
      expect(clock.pending()).toBe(1); // the tick is armed by afterFastSend, not by a later enqueue

      // The socket drains no further over the next 10s (a stalled phone) —
      // bufferedAmount crosses CONGESTED_BYTES and stays there the whole
      // window, with no further push ever enqueued to re-arm anything. One
      // extra tick beyond CONGESTION_CLOSE_MS accounts for the first tick
      // (at OUTBOX_TICK_MS) being what sets congestedSince in the first
      // place — the same two-step shape the existing sustained-congestion
      // test above uses.
      socket.bufferedAmount = CONGESTED_BYTES + 1024;
      clock.advance(CONGESTION_CLOSE_MS + OUTBOX_TICK_MS);

      expect(congested).toEqual(["sustained"]);
    },
  );

  it("logs and discards a push whose payload cannot be JSON-encoded, without consuming a seq", () => {
    const { socket, logs, outbox } = setup();
    outbox.push("t:latest", { x: 1n }, undefined); // BigInt: JSON.stringify throws
    expect(socket.sent).toEqual([]);
    expect(logs.some((line) => line.includes("t:latest"))).toBe(true);
    // M12 Task 12 minor: the encoding failure's own message — a BigInt
    // serialization error, which could in principle echo back fragments of
    // caller/device content — never reaches the log line, only the fixed
    // "encode t:latest" category (devices.ts's logPushWriteFailure already
    // applies the identical discipline to a push-record write failure).
    expect(logs.some((line) => line.includes("BigInt"))).toBe(false);
    expect(logs).toContainEqual("outbox: encode t:latest");

    outbox.push("t:latest", { x: 2 }, undefined);
    expect(socket.sent).toEqual([{ t: "psh", ch: "t:latest", p: { x: 2 }, seq: 1 }]);
  });

  // M12 Task 12 minor: when the thrown value does carry an error `code`
  // (an fs-style error, or any thrown object shaped like one), logChannel
  // includes it — the actionable part of an OS-level failure — but still
  // never the free-text message alongside it.
  it("includes a thrown error's code in the log line, but never its free-text message", () => {
    const throwingPolicy: ChannelPolicy = {
      kind: "reliable",
      keyOf: () => {
        throw Object.assign(new Error("ENOSPC: no space left on device, secret payload leaked"), {
          code: "ENOSPC",
        });
      },
    };
    const { socket, clock, logs, outbox } = setup({
      policies: new Map<string, ChannelPolicy>([...policies, ["t:code-throws", throwingPolicy]]),
    });
    socket.bufferedAmount = 2 * 1024 * 1024; // stalled: goes through the purge path
    outbox.push("t:code-throws", { k: "boom" }, "boom");
    outbox.purge("t:code-throws", "boom");

    socket.bufferedAmount = 0;
    clock.advance(OUTBOX_TICK_MS);

    expect(logs).toContainEqual("outbox: build t:code-throws code=ENOSPC");
    expect(logs.some((line) => line.includes("secret payload leaked"))).toBe(false);
  });

  it("dispose() makes later reply/push a no-op and clears all timers", () => {
    const { socket, clock, outbox } = setup();
    socket.bufferedAmount = 2 * 1024 * 1024;
    outbox.push("t:latest", { x: 1 }, undefined);
    expect(clock.pending()).toBe(1);

    outbox.dispose();
    expect(clock.pending()).toBe(0);

    outbox.push("t:latest", { x: 2 }, undefined);
    outbox.reply(encodeMessage({ t: "res", id: 1, v: "x" }));
    socket.bufferedAmount = 0;
    clock.advance(OUTBOX_TICK_MS);
    expect(socket.sent).toEqual([]);
  });

  it("disarms the tick once both lanes drain and bufferedAmount returns to 0", () => {
    const { socket, clock, outbox } = setup();
    socket.bufferedAmount = 2 * 1024 * 1024;
    outbox.push("t:latest", { x: 1 }, undefined);
    expect(clock.pending()).toBe(1);

    socket.bufferedAmount = 0;
    clock.advance(OUTBOX_TICK_MS);

    expect(socket.sent).toEqual([{ t: "psh", ch: "t:latest", p: { x: 1 }, seq: 1 }]);
    expect(clock.pending()).toBe(0);
  });

  it(
    "uses wire (JSON-escaped) bytes, not raw chunk bytes, for the congestion threshold — ESC-heavy streams " +
      "across a few keys trip it despite a small chunk-byte total",
    () => {
      const { socket, clock, congested, outbox } = setup();
      // Stalled just at the send watermark so entries queue rather than
      // fast-send: the flush loop's `bufferedAmount < SEND_WATERMARK_BYTES`
      // is false when equal, so nothing drains before the tick assertions.
      socket.bufferedAmount = 1_048_576; // === SEND_WATERMARK_BYTES
      // Each key's cap is 262,144 *chunk* bytes; an all-ESC chunk escapes
      // to `` (6 bytes) per byte on the wire, so three capped,
      // all-ESC keys sum to ~1.57 MiB chunk bytes but ~4.7 MiB wire bytes —
      // over CONGESTED_BYTES only under the wire-byte accounting.
      const escChunk = "\u{1b}".repeat(STREAM_MAX_BYTES);
      for (const key of ["p1", "p2", "p3"]) {
        outbox.push("t:stream", { k: key, c: escChunk, o: 0 }, key);
      }
      const chunkByteTotal = 3 * STREAM_MAX_BYTES;
      expect(socket.bufferedAmount + chunkByteTotal).toBeLessThan(CONGESTED_BYTES);

      clock.advance(50);
      clock.advance(CONGESTION_CLOSE_MS);

      expect(congested).toEqual(["sustained"]);
    },
  );
});
