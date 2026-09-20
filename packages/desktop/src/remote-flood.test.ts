// The M5 desktop pipeline, end to end, under flood (task 8's brief). No
// production code is exercised through a mock of itself: this is a real
// `createShellManager` (platform) feeding a real `createBroadcaster`, through
// main.ts's own two `shells` subscriptions (reproduced verbatim below —
// ~line 900 of main.ts), into a subscription-gated sink that calls a real
// `createOutbox` (@jarvis/remote) over a local socket stub with a settable
// `bufferedAmount`. Every fixture — the synthetic shell process, the socket,
// the subscription set — lives in this file only; nothing here changes
// production code.
//
// Ruling 10 (plan ruling 10) is what the "attach mid-flood" test proves: a
// client that has just read `snapshot(pane)` reconstructs the pane's live
// tail by, for every `terminal:data` push with `offset` o and `chunk` c,
// dropping it if `o + c.length <= end`, else rendering `c.slice(max(0, end
// − o))`.
import {
  createOutbox,
  OUTBOX_TICK_MS,
  STREAM_MAX_BYTES,
  type SocketLike,
  utf8Bytes,
} from "@jarvis/remote";
import { createShellManager, type ShellProcess, type ShellSpawner } from "@jarvis/platform";
import type { SystemMetrics } from "@jarvis/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBroadcaster, type PushSink } from "./broadcast.js";
import { remotePushPolicies } from "./remote-push-policy.js";

/** A `ShellProcess` a test drives by hand: `emit`/`emitExit` stand in for a
 *  real pty's data/exit events (mirrors platform/src/shell.test.ts's own
 *  FakeShell). */
class FakeShellProcess implements ShellProcess {
  #data: ((chunk: string) => void)[] = [];
  #exit: ((code: number) => void)[] = [];
  onData(listener: (chunk: string) => void): void {
    this.#data.push(listener);
  }
  onExit(listener: (code: number) => void): void {
    this.#exit.push(listener);
  }
  write(): void {}
  resize(): void {}
  kill(): void {}
  emit(chunk: string): void {
    for (const listener of this.#data) listener(chunk);
  }
  emitExit(code: number): void {
    for (const listener of this.#exit) listener(code);
  }
}

/** A local `SocketLike` stub (mirrors packages/remote/src/socket-double.ts,
 *  not exported from `@jarvis/remote`'s package root): every `send` is
 *  recorded as its parsed frame, and `bufferedAmount` is settable so a test
 *  can simulate a stalled or draining phone. */
class FakeSocket implements SocketLike {
  sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | undefined;
  terminated = false;
  bufferedAmount = 0;
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  terminate(): void {
    this.terminated = true;
  }
}

/** One recorded `terminal:data`/`terminal:exit`/... frame as delivered to
 *  the renderer sink, or as sent on the wire. */
type RendererEntry = { channel: string; payload: unknown };

function paneKeyOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const key = (payload as { paneKey?: unknown }).paneKey;
  return typeof key === "string" ? key : undefined;
}

/**
 * The harness the brief asks for: a synthetic pane's shell manager, a real
 * broadcaster whose renderer sink records every push it sees (the laptop's
 * own copy, unaffected by any phone's stall), and one real outbox wired to
 * a subscription-gated sink standing in for main.ts's per-connection push
 * plumbing — "subscribed targets only", keyed by the policy's own `keyOf`.
 */
function setupHarness(): {
  shells: ReturnType<typeof createShellManager>;
  panes: Map<string, FakeShellProcess>;
  broadcast: ReturnType<typeof createBroadcaster>;
  rendererLog: RendererEntry[];
  socket: FakeSocket;
  outbox: ReturnType<typeof createOutbox>;
  pushSpy: ReturnType<typeof vi.fn>;
  subscribe(channel: string, key?: string): void;
  congested: Array<"sustained" | "ceiling">;
} {
  const panes = new Map<string, FakeShellProcess>();
  // Each pane's own key doubles as the `cwd` `shells.start` is given below —
  // an arbitrary but unique string is all a synthetic spawner needs to hand
  // the right process back to the right pane.
  const spawn: ShellSpawner = ({ cwd }) => {
    const process = new FakeShellProcess();
    panes.set(cwd, process);
    return process;
  };
  const shells = createShellManager({ spawn });

  const rendererLog: RendererEntry[] = [];
  const toRenderer: PushSink = (channel, payload) => {
    rendererLog.push({ channel, payload });
  };
  const broadcast = createBroadcaster({ toRenderer });

  // main.ts's two `shells` subscriptions (~line 900), reproduced verbatim.
  shells.onOutput(({ paneKey, chunk, offset }) =>
    broadcast.send("terminal:data", { paneKey, chunk, offset }),
  );
  shells.onShellExit(({ paneKey, code }) => broadcast.send("terminal:exit", { paneKey, code }));

  const socket = new FakeSocket();
  const policies = remotePushPolicies();
  const congested: Array<"sustained" | "ceiling"> = [];
  const outbox = createOutbox({
    socket,
    policies,
    now: () => Date.now(),
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    log: () => {},
    onCongested: (reason) => congested.push(reason),
  });
  const pushSpy = vi.fn((channel: string, payload: unknown, key: string | undefined) =>
    outbox.push(channel, payload, key),
  );

  // channel -> the set of keys subscribed for it (`undefined` itself is a
  // valid set member: a bare, unkeyed subscription to that channel).
  const subscriptions = new Map<string, Set<string | undefined>>();
  function subscribe(channel: string, key?: string): void {
    const keys = subscriptions.get(channel) ?? new Set<string | undefined>();
    keys.add(key);
    subscriptions.set(channel, keys);
  }
  function isSubscribed(channel: string, key: string | undefined): boolean {
    return subscriptions.get(channel)?.has(key) ?? false;
  }

  // The sink: for subscribed targets only, key computed the same way the
  // real hub would (the policy's own `keyOf`) — an unkeyed policy (latest,
  // or reliable without keyOf) never subscribes by key.
  broadcast.addSink((channel, payload) => {
    const policy = policies.get(channel);
    if (policy === undefined) return;
    const key =
      policy.kind === "stream"
        ? policy.keyOf(payload)
        : policy.kind === "reliable"
          ? policy.keyOf?.(payload)
          : undefined;
    if (!isSubscribed(channel, key)) return;
    pushSpy(channel, payload, key);
  });

  return { shells, panes, broadcast, rendererLog, socket, outbox, pushSpy, subscribe, congested };
}

/** A flood chunk that carries its own index, so a reconstruction bug (an
 *  offset error, a dropped or reordered chunk) is visible in content, not
 *  just in length — same shape as platform/src/shell.test.ts's flood test. */
function floodChunk(index: number, size: number): string {
  return `${String(index).padStart(8, "0")}${"x".repeat(size - 8)}`;
}

/** Ruling 10's client attach rule, applied to one already-received frame:
 *  dropped entirely if it lies within `[0, end)`, otherwise rendered from
 *  `max(0, end - offset)` on. */
function ruling10Render(offset: number, chunk: string, end: number): string {
  if (offset + chunk.length <= end) return "";
  return chunk.slice(Math.max(0, end - offset));
}

function lastIndexMatching(
  frames: Record<string, unknown>[],
  predicate: (frame: Record<string, unknown>) => boolean,
): number {
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    if (frame !== undefined && predicate(frame)) return i;
  }
  return -1;
}

function firstIndexMatching(
  frames: Record<string, unknown>[],
  predicate: (frame: Record<string, unknown>) => boolean,
): number {
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame !== undefined && predicate(frame)) return i;
  }
  return -1;
}

describe("the desktop pipeline under flood", () => {
  beforeEach(() => {
    // Only `setTimeout`/`clearTimeout` are faked — the outbox's own tick —
    // so `process.hrtime` (the flood test's own timing measurement) still
    // reads real wall-clock time. Vitest's default `toFake` set otherwise
    // includes `hrtime` itself, which would make a "measured" duration just
    // replay `vi.advanceTimersByTime`'s simulated total instead.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // This test's own 20_000ms sanity ceiling below already expects a real,
  // slow wall-clock run — the outer `it()` needs at least that much
  // headroom too, rather than relying on vitest's 5s default (observed
  // timing out on windows-latest, which ran this workload slower).
  it("keeps the renderer's copy complete while the phone's outbox stays bounded across a stalled 64 MiB flood " +
    "over two panes, accounts for every dropped byte once unstalled, and orders a pane's exit after its last " +
    "data frame", () => {
    const h = setupHarness();
    h.shells.start("tab-1", "tab-1");
    h.shells.start("tab-2", "tab-2");
    h.subscribe("terminal:data", "tab-1");
    h.subscribe("terminal:data", "tab-2");
    h.subscribe("terminal:exit", "tab-1");
    h.socket.bufferedAmount = 2 * 1024 * 1024;

    const PANES = ["tab-1", "tab-2"];
    const CHUNK_SIZE = 1024;
    const TOTAL_CHUNKS = (64 * 1024 * 1024) / CHUNK_SIZE; // 65,536
    const emittedBytes: Record<string, number> = { "tab-1": 0, "tab-2": 0 };
    let maxSample = 0;

    const startedNs = process.hrtime.bigint();
    for (let i = 0; i < TOTAL_CHUNKS; i++) {
      const pane = PANES[i % 2] as string;
      const chunk = floodChunk(i, CHUNK_SIZE);
      emittedBytes[pane] = (emittedBytes[pane] ?? 0) + utf8Bytes(chunk);
      h.panes.get(pane)?.emit(chunk);

      if (i % 1000 === 999) {
        vi.advanceTimersByTime(OUTBOX_TICK_MS);
        maxSample = Math.max(maxSample, h.outbox.queuedBytes());
      }
    }

    expect(h.congested).toEqual([]);
    // Two active stream keys, each capped independently at STREAM_MAX_BYTES.
    expect(maxSample).toBeLessThanOrEqual(2 * STREAM_MAX_BYTES + 64 * 1024);

    // The renderer's own copy is untouched by the phone's stall: every
    // chunk for both panes arrived, in order, with contiguous offsets.
    for (const pane of PANES) {
      const entries = h.rendererLog.filter(
        (entry) => entry.channel === "terminal:data" && paneKeyOf(entry.payload) === pane,
      );
      expect(entries).toHaveLength(TOTAL_CHUNKS / PANES.length);
      let expectedOffset = 0;
      for (const entry of entries) {
        const { offset, chunk } = entry.payload as { offset: number; chunk: string };
        expect(offset).toBe(expectedOffset);
        expectedOffset += chunk.length;
      }
      if (pane === "tab-1") {
        const full = entries.map((entry) => (entry.payload as { chunk: string }).chunk).join("");
        expect(full.slice(-(256 * 1024))).toBe(h.shells.log("tab-1"));
      }
    }

    // The pane's process exits while the phone is still stalled (buffer
    // still 2 MiB from above) — the non-trivial ordering case (final-
    // review fix wave item 7a): the reliable terminal:exit push queues
    // behind whatever terminal:data is still queued for tab-1, rather
    // than being emitted onto an already-empty, already-flushed outbox
    // where the ordering would hold true by construction alone.
    h.panes.get("tab-1")?.emitExit(0);

    // Unstall and flush everything queued for the phone.
    h.socket.bufferedAmount = 0;
    for (let guard = 0; guard < 1_000_000 && h.outbox.queuedBytes() > 0; guard++) {
      vi.advanceTimersByTime(OUTBOX_TICK_MS);
    }
    expect(h.outbox.queuedBytes()).toBe(0);

    for (const pane of PANES) {
      const frames = h.socket.sent.filter(
        (frame) => frame["ch"] === "terminal:data" && paneKeyOf(frame["p"]) === pane,
      );
      let deliveredPlusDropped = 0;
      for (const frame of frames) {
        const p = frame["p"] as { chunk: string };
        deliveredPlusDropped += utf8Bytes(p.chunk) + ((frame["dropped"] as number) ?? 0);
      }
      expect(deliveredPlusDropped).toBe(emittedBytes[pane]);

      const last = frames[frames.length - 1];
      expect(last).toBeDefined();
      if (last !== undefined) {
        const p = last["p"] as { offset: number; chunk: string };
        expect(p.offset + p.chunk.length).toBe(h.shells.snapshot(pane).end);
      }
    }

    const lastDataIndex = lastIndexMatching(
      h.socket.sent,
      (frame) => frame["ch"] === "terminal:data" && paneKeyOf(frame["p"]) === "tab-1",
    );
    const exitIndex = firstIndexMatching(
      h.socket.sent,
      (frame) => frame["ch"] === "terminal:exit" && paneKeyOf(frame["p"]) === "tab-1",
    );
    expect(exitIndex).toBeGreaterThan(-1);
    expect(lastDataIndex).toBeLessThan(exitIndex);

    const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
    // Sanity ceiling only (>=10x the measured time), never a bite-proof;
    // the measured duration is pasted into the task report.
    expect(elapsedMs).toBeLessThan(20_000);
  }, 30_000);

  it(
    "reconstructs a pane's tail after attaching mid-flood, applying ruling 10 to every frame with no drops " +
      "[bite-proof: an always-zero offset in the terminal:data forwarding breaks the reconstruction]",
    () => {
      const h = setupHarness();
      h.shells.start("tab-1", "tab-1");
      h.subscribe("terminal:data", "tab-1");

      const CHUNK_SIZE = 1024;
      const TOTAL_CHUNKS = (10 * 1024 * 1024) / CHUNK_SIZE; // 10,240
      // Each stall window is well under STREAM_MAX_BYTES (262,144) so a
      // periodic drain (below) never lets the per-key cap start dropping —
      // "so nothing drops" — while still leaving some pushed frames genuinely
      // unflushed at the moment the snapshot below is taken.
      const BURST = 200;
      const emitted: string[] = [];
      let snapshot: { text: string; end: number } | undefined;

      for (let i = 0; i < TOTAL_CHUNKS; i++) {
        if (i % BURST === 0) h.socket.bufferedAmount = 2 * 1024 * 1024;
        const chunk = floodChunk(i, CHUNK_SIZE);
        emitted.push(chunk);
        h.panes.get("tab-1")?.emit(chunk);
        // Taken mid-burst (BURST's *first* chunk, not its last): at i =
        // 4999 the snapshot fell exactly on a burst boundary, so every
        // sent frame either ended at or after `end` — the partial-overlap
        // branch of ruling10Render (offset < end < offset + chunk.length)
        // was never exercised (final-review fix wave item 7b). i = 5000
        // starts burst 25 (5000 % BURST === 0): only its first chunk has
        // been pushed when the snapshot is taken, but that whole burst
        // still merges into one frame once flushed, so `end` lands inside
        // that frame's range instead of on its boundary.
        if (i === 5000) snapshot = h.shells.snapshot("tab-1");
        if (i % BURST === BURST - 1) {
          h.socket.bufferedAmount = 0;
          vi.advanceTimersByTime(OUTBOX_TICK_MS);
        }
      }
      h.socket.bufferedAmount = 0;
      for (let guard = 0; guard < 1_000_000 && h.outbox.queuedBytes() > 0; guard++) {
        vi.advanceTimersByTime(OUTBOX_TICK_MS);
      }
      expect(h.outbox.queuedBytes()).toBe(0);
      expect(h.congested).toEqual([]);
      expect(snapshot).toBeDefined();
      if (snapshot === undefined) return;

      const frames = h.socket.sent.filter(
        (frame) => frame["ch"] === "terminal:data" && paneKeyOf(frame["p"]) === "tab-1",
      );
      for (const frame of frames) expect((frame["dropped"] as number | undefined) ?? 0).toBe(0);

      let rendered = "";
      for (const frame of frames) {
        const p = frame["p"] as { offset: number; chunk: string };
        rendered += ruling10Render(p.offset, p.chunk, snapshot.end);
      }
      const combined = snapshot.text + rendered;
      const fullEmitted = emitted.join("");
      expect(combined).toBe(fullEmitted.slice(-combined.length));
    },
  );

  it("never reaches the phone's outbox for an unsubscribed pane's flood", () => {
    const h = setupHarness();
    h.shells.start("tab-3", "tab-3");
    // tab-3 is deliberately never subscribed.

    const CHUNK_SIZE = 1024;
    const TOTAL_CHUNKS = (8 * 1024 * 1024) / CHUNK_SIZE; // 8,192
    for (let i = 0; i < TOTAL_CHUNKS; i++) {
      h.panes.get("tab-3")?.emit(floodChunk(i, CHUNK_SIZE));
    }

    expect(h.pushSpy).not.toHaveBeenCalled();
  });

  it("coalesces 1,000 metrics:update sends while stalled into one frame carrying the last sample", () => {
    const h = setupHarness();
    h.subscribe("metrics:update");
    h.socket.bufferedAmount = 2 * 1024 * 1024;

    let last: SystemMetrics | undefined;
    for (let i = 0; i < 1000; i++) {
      const sample: SystemMetrics = {
        cpuPercent: i,
        memoryUsedBytes: i,
        memoryTotalBytes: 100,
        diskUsedBytes: i,
        diskTotalBytes: 100,
        networkDownMbps: 0,
        networkUpMbps: 0,
        uptimeSeconds: i,
      };
      last = sample;
      h.broadcast.send("metrics:update", sample);
    }

    h.socket.bufferedAmount = 0;
    vi.advanceTimersByTime(OUTBOX_TICK_MS);

    const frames = h.socket.sent.filter((frame) => frame["ch"] === "metrics:update");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.["p"]).toEqual(last);
  });
});
