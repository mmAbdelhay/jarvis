// A synthetic memory-bound proof (Task 2 brief, "outbox.flood.test.ts"): 64
// MiB of stream traffic across three keys, interleaved with reliable and
// latest pushes, must never let `queuedBytes()` grow past a small multiple
// of the per-key cap — no matter how long the phone stays stalled. Uses
// `fakeClock`/`FakeSocket` throughout; no real timer or network wait, so
// this stays fast and deterministic.

import { describe, expect, it } from "vitest";
import { fakeClock } from "./clock-double.js";
import { OUTBOX_TICK_MS, createOutbox } from "./outbox.js";
import type { ChannelPolicies, ChannelPolicy, StreamPolicy } from "./policy.js";
import { STREAM_MAX_BYTES, utf8Bytes } from "./policy.js";
import { FakeSocket } from "./socket-double.js";

type StreamPayload = { k?: string; c: string; o?: number };

const KEYS = ["p1", "p2", "p3"] as const;

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

const policies: ChannelPolicies = new Map<string, ChannelPolicy>([
  ["t:stream", streamPolicy],
  ["t:latest", { kind: "latest" }],
  ["t:reliable", { kind: "reliable" }],
]);

describe("outbox flood", () => {
  // Deterministic (fakeClock/FakeSocket — no real timer or network wait),
  // but 64 MiB of synthetic chunking/pushing is real CPU work; the default
  // 5s test timeout is tight on a loaded/slower CI runner (observed on
  // windows-latest). The explicit 30_000 below is the same convention as
  // bridge.integration.test.ts's own per-test timeout override.
  it("bounds queued bytes across three keys under sustained pressure, preserving reliable order/seq and per-key " +
    "offset contiguity, without ever congesting [bite-proof: remove the per-key cap]", () => {
    const socket = new FakeSocket();
    const clock = fakeClock();
    const congested: Array<"sustained" | "ceiling"> = [];
    const outbox = createOutbox({
      socket,
      policies,
      now: clock.now,
      timers: clock.timers,
      log: () => {},
      onCongested: (reason) => congested.push(reason),
    });

    socket.bufferedAmount = 2 * 1024 * 1024;

    const CHUNK_UNITS = 1024;
    const totalChunks = (64 * 1024 * 1024) / CHUNK_UNITS; // 65,536 chunks across 3 keys
    const offsets: Record<(typeof KEYS)[number], number> = { p1: 0, p2: 0, p3: 0 };
    const emittedBytes: Record<(typeof KEYS)[number], number> = { p1: 0, p2: 0, p3: 0 };
    let latestPushed = 0;
    let reliablePushed = 0;
    let maxSample = 0;
    let maxPieceCount = 0;

    const started = Date.now();

    for (let i = 0; i < totalChunks; i++) {
      // `i % 3` is always 0, 1 or 2 — a safe index into the fixed 3-element KEYS tuple.
      const key = KEYS[i % 3] as (typeof KEYS)[number];
      // "mixed ASCII/UTF-8": every 7th chunk carries a 2-byte code point,
      // which grows a chunk's UTF-8 byte size beyond its string length.
      const chunk = i % 7 === 0 ? `é${"x".repeat(CHUNK_UNITS - 2)}` : "x".repeat(CHUNK_UNITS);
      const offset = offsets[key];
      offsets[key] = offset + chunk.length;
      emittedBytes[key] += utf8Bytes(chunk);
      outbox.push("t:stream", { k: key, c: chunk, o: offset }, key);

      if (latestPushed < 1000 && i % 65 === 0) {
        outbox.push("t:latest", { tick: latestPushed }, undefined);
        latestPushed++;
      }
      if (reliablePushed < 50 && i % 1300 === 0) {
        outbox.push("t:reliable", { id: reliablePushed }, undefined);
        reliablePushed++;
      }

      if (i % 1000 === 999) {
        clock.advance(OUTBOX_TICK_MS);
        maxSample = Math.max(maxSample, outbox.queuedBytes());
        maxPieceCount = Math.max(maxPieceCount, outbox.pieceCount());
      }
    }
    // The 50th reliable push may land after the last sampled tick.
    if (reliablePushed < 50) {
      outbox.push("t:reliable", { id: reliablePushed }, undefined);
      reliablePushed++;
    }

    expect(maxSample).toBeLessThanOrEqual(3 * STREAM_MAX_BYTES + 64 * 1024);
    // Task 6 rule 6, "structural piece bound": alongside the byte-level
    // ceiling above, the queue never grows anywhere close to one entry
    // per push (65,536 stream + 1,000 latest + 50 reliable pushes here).
    // Each of the 50 `reliable` pushes can split whichever key's stream
    // entry follows it into a new one (a reliable entry always breaks
    // contiguity), so a key can briefly hold more than one queued
    // StreamEntry — up to 3 keys * 51 possible splits, plus the 50
    // `reliable` entries themselves (never flushed here — the socket
    // stays stalled the whole run) and one coalesced `latest` entry.
    // Measured max was 57; this ceiling is generous on purpose (a
    // structural bound, not a tight one) while still nowhere near
    // "one node per push".
    expect(maxPieceCount).toBeLessThanOrEqual(3 * 51 + 50 + 1);
    expect(congested).toEqual([]);

    socket.bufferedAmount = 0;
    // Unstall and flush everything queued.
    for (let guard = 0; guard < 1_000_000 && outbox.queuedBytes() > 0; guard++) {
      clock.advance(OUTBOX_TICK_MS);
    }
    expect(outbox.queuedBytes()).toBe(0);

    const elapsedMs = Date.now() - started;
    // Sanity ceiling only (>=10x the measured time), never a bite-proof;
    // the measured duration is pasted into the task report.
    expect(elapsedMs).toBeLessThan(10_000);

    const pushed = socket.sent.filter((m) => (m as { t: string }).t === "psh") as Array<{
      ch: string;
      p: unknown;
      seq: number;
      dropped?: number;
    }>;

    const reliableFrames = pushed.filter((f) => f.ch === "t:reliable") as Array<{
      p: { id: number };
      seq: number;
    }>;
    expect(reliableFrames).toHaveLength(50);
    expect(reliableFrames.map((f) => f.p.id)).toEqual(Array.from({ length: 50 }, (_, i) => i));

    for (let i = 1; i < pushed.length; i++) {
      const current = pushed[i] as { seq: number };
      const previous = pushed[i - 1] as { seq: number };
      expect(current.seq).toBe(previous.seq + 1);
    }

    const streamFrames = pushed.filter((f) => f.ch === "t:stream") as Array<{
      p: StreamPayload;
      dropped?: number;
    }>;
    for (const key of KEYS) {
      const frames = streamFrames.filter((f) => f.p.k === key);
      let previousEnd: number | undefined;
      let retainedPlusDropped = 0;
      for (const frame of frames) {
        const o = frame.p.o as number;
        if (previousEnd !== undefined) expect(o).toBeGreaterThanOrEqual(previousEnd);
        previousEnd = o + frame.p.c.length;
        retainedPlusDropped += utf8Bytes(frame.p.c) + (frame.dropped ?? 0);
      }
      expect(retainedPlusDropped).toBe(emittedBytes[key]);
    }
  }, 30_000);

  it("bounds the stream piece queue for a flood of 1-2 byte and empty chunks on one key " +
    "[bite-proof: merge small pieces]", () => {
    const socket = new FakeSocket();
    const clock = fakeClock();
    const congested: Array<"sustained" | "ceiling"> = [];
    const outbox = createOutbox({
      socket,
      policies,
      now: clock.now,
      timers: clock.timers,
      log: () => {},
      onCongested: (reason) => congested.push(reason),
    });

    // Stalled the entire time: nothing ever drains, so every push goes
    // through enqueue + the per-key cap loop — the path the review found
    // quadratic for tiny pieces (Important 1) and unbounded for empty
    // ones (Minor 1).
    socket.bufferedAmount = 2 * 1024 * 1024;

    const REAL_CHUNKS = 500_000; // 1-2 UTF-8 bytes each, ~1 MiB of real content total
    let offset = 0;
    let emittedBytes = 0;
    let maxSample = 0;
    let maxPieceCount = 0;

    const started = Date.now();

    for (let i = 0; i < REAL_CHUNKS; i++) {
      // One empty chunk (Task 6 behaviour rule 3) ahead of every real one
      // (Important 1): both must never grow `chunks` without bound at
      // this offset, and the empty one — the very first push for this
      // key on iteration 0, where nothing yet exists to coalesce into —
      // must never leave a phantom entry behind either.
      outbox.push("t:stream", { k: "p1", c: "", o: offset }, "p1");
      // Alternates 1- and 2-byte-wide code points so both the merge
      // threshold and the byte accounting see mixed sizes.
      const chunk = i % 2 === 0 ? "x" : "é";
      offset += chunk.length;
      emittedBytes += utf8Bytes(chunk);
      outbox.push("t:stream", { k: "p1", c: chunk, o: offset - chunk.length }, "p1");

      if (i % 1000 === 999) {
        maxSample = Math.max(maxSample, outbox.queuedBytes());
        maxPieceCount = Math.max(maxPieceCount, outbox.pieceCount());
      }
    }

    const elapsedMs = Date.now() - started;
    // Sanity ceiling only (>=10x the measured time), never a bite-proof;
    // the measured duration is pasted into the task report. Without the
    // merge fix this does not finish in any reasonable time (the review
    // measured ~25us per push+shift at this piece count, i.e. minutes
    // here), so the ceiling alone already separates fixed from broken.
    //
    // final-review fix wave item 6 asked for a structural bound here too
    // (a piece/frame count); Task 6 adds exactly that handle,
    // `Outbox.pieceCount()` — but it counts queued *entries*, not the
    // pieces inside one entry's private `chunks: string[]`, which stays
    // exactly as invariant under the public surface as the comment this
    // replaces used to say (`buildQueuedPushMessage`'s
    // `entry.chunks.join("")` erases the distinction before any frame is
    // ever built). `pieceCount()` therefore cannot discriminate merged
    // from unmerged pieces here — every push in this test lands on the
    // same key, so the entry count never exceeds 1 regardless of the
    // merge fix — but it does directly prove the *other* half of
    // behaviour rule 3: the empty chunk on iteration 0, with no existing
    // entry to absorb it, never leaves a phantom entry queued (still
    // dropped, still exactly one real entry once the first real chunk
    // lands, for the rest of the run).
    expect(elapsedMs).toBeLessThan(10_000);
    expect(maxSample).toBeLessThanOrEqual(STREAM_MAX_BYTES + 8);
    expect(maxPieceCount).toBeLessThanOrEqual(1);
    expect(congested).toEqual([]);

    socket.bufferedAmount = 0;
    for (let guard = 0; guard < 1_000_000 && outbox.queuedBytes() > 0; guard++) {
      clock.advance(OUTBOX_TICK_MS);
    }
    expect(outbox.queuedBytes()).toBe(0);

    const streamFrames = socket.sent.filter(
      (m) => (m as { ch: string }).ch === "t:stream",
    ) as Array<{ p: StreamPayload; dropped?: number }>;
    // Every empty chunk coalesced away with no frame of its own (Minor
    // 1): each surviving frame carries non-empty content.
    for (const frame of streamFrames) expect(frame.p.c.length).toBeGreaterThan(0);

    let previousEnd: number | undefined;
    let retainedPlusDropped = 0;
    for (const frame of streamFrames) {
      const o = frame.p.o as number;
      if (previousEnd !== undefined) expect(o).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = o + frame.p.c.length;
      retainedPlusDropped += utf8Bytes(frame.p.c) + (frame.dropped ?? 0);
    }
    expect(retainedPlusDropped).toBe(emittedBytes);
  }, 30_000);
});
