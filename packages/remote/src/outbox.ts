// The per-connection send queue (M5 plan, "streams", Task 2): a `control`
// lane for already-encoded `res`/`err` replies and a `pushes` lane for
// `reliable`/`latest`/`stream` pushes, coalesced and capped so one slow
// phone can never make this process's memory grow without bound. Nothing
// here touches a real socket or timer directly — both arrive through
// `OutboxDeps` (io.ts's `SocketLike`/`Timers`/`Clock`), so tests run against
// `FakeSocket` and `fakeClock()` with no real network or wall-clock wait.
//
// Byte accounting has two different meanings on purpose (controller ruling,
// folded from the Task 1 review). `queuedBytes()` — and the per-`(channel,
// key)` stream cap it shares its arithmetic with — is *rule-2* bytes: the
// content a frame carries (`utf8Bytes(text)` for control, `utf8Bytes(
// JSON.stringify(payload))` for reliable/latest, `utf8Bytes(chunk)` for a
// stream chunk). The 4 MiB/16 MiB congestion thresholds compare *wire*
// bytes instead: the UTF-8 length of the frame `JSON.stringify` would
// actually hand the socket. `JSON.stringify` escapes `"`, `\` and control
// characters (ESC and friends) to `\uXXXX` (6 bytes), so a stream chunk's
// raw content bytes can undercount its wire size by up to ~6x; reliable/
// latest entries already store `utf8Bytes(JSON.stringify(payload))`, which
// is already escape-accurate, so only stream entries carry a second figure.
// A fixed per-frame envelope (`{"t":"psh","ch":...,"seq":...}`) is left out
// of the wire estimate: at most a few dozen bytes against multi-MiB
// thresholds, it cannot itself cross a threshold this queue enforces.
//
// Both totals — and the per-`(channel,key)` cap total — are maintained
// *incrementally*: add on enqueue/coalesce, subtract on drop/send/purge/
// dispose. Nothing here re-derives a byte count by rescanning a lane or by
// re-stringifying a queued entry, and nothing splices out of the middle of
// a large array. The `pushes` lane is a doubly linked list (`PushNode`),
// so sending the head, removing a drained stream entry from the middle
// (the per-key cap), and purging are all O(1) or O(the entries actually
// touched) rather than O(lane length) — the earlier version of this file
// recomputed a coalesced entry's wire size via `JSON.stringify` on every
// enqueue and rescanned the whole lane to find a `(channel,key)`'s oldest
// entry, which made a sustained flood quadratic in the number of chunks
// (52.9s measured on 64 MiB of 1 KiB chunks; see outbox.flood.test.ts).
// A stream entry's content itself is stored as a queue of pieces
// (`chunks: string[]`), one per coalesced push, rather than one big string
// rebuilt with `+=`/`slice` on every push and every cap check — the pieces
// are only joined into one string when the entry is actually sent (at most
// once, and bounded by the entry's own cap).

import { describeError } from "./io.js";
import type { Clock, SocketLike, Timers } from "./io.js";
import type { ChannelPolicies, ChannelPolicy, StreamPolicy } from "./policy.js";
import { dropHead, utf8Bytes } from "./policy.js";
import { encodeMessage } from "./protocol.js";
import type { ServerMessage } from "./protocol.js";

export const SEND_WATERMARK_BYTES = 1_048_576;
export const CONGESTED_BYTES = 4_194_304;
export const MAX_QUEUED_BYTES = 16_777_216;
export const CONGESTION_CLOSE_MS = 10_000;
export const OUTBOX_TICK_MS = 50;

/**
 * A coalesced stream entry merges an arriving piece into its current last
 * piece in place, rather than always appending a new array element, while
 * that last piece stays under this many UTF-16 units (fix round 1, review
 * finding "Important 1"). Without this, a phone sending many tiny chunks
 * (a PTY writing 1-2 bytes at a time) grew `chunks` by one element per
 * push with no ceiling: 262,144 two-byte pushes to fill one key's 256 KiB
 * cap left 262,144 array slots and string objects — ~9 MB of heap for
 * 256 KiB of counted bytes — and repeated `Array.shift()` in
 * `dropFromStreamEntry` turned quadratic as the array grew, stalling the
 * event loop on one connection with no congestion close. Merging keeps a
 * capped entry to roughly `maxBytes / CHUNK_MERGE_THRESHOLD_BYTES` pieces
 * (about 16 for the 256 KiB default cap) regardless of how small each
 * arriving chunk is. The threshold check reads `.length` (O(1), even on
 * an unflattened rope from repeated `+`) rather than `utf8Bytes` (an O(n)
 * walk) — re-walking the growing piece on every one of its merges would
 * reintroduce the same O(n^2) cost this fix removes; a UTF-16-unit
 * threshold is close enough to a byte threshold for this purpose, and the
 * exact rule-2/wire byte totals are still tracked incrementally as before.
 */
const CHUNK_MERGE_THRESHOLD_BYTES = 16_384;

export type OutboxDeps = {
  socket: SocketLike;
  policies: ChannelPolicies;
  now: Clock;
  timers: Timers;
  log(line: string): void;
  onCongested(reason: "sustained" | "ceiling"): void;
};

export type Outbox = {
  /** An already-encoded res or err frame. */
  reply(text: string): void;
  /** Caller has checked the subscription; `key` is the hub's `keyOf` result (undefined for unkeyed). */
  push(channel: string, payload: unknown, key: string | undefined): void;
  /** Removes queued pushes for a dropped target: an unkeyed channel when `key` is undefined. */
  purge(channel: string, key: string | undefined): void;
  queuedBytes(): number;
  /**
   * Test-only accessor (Task 6): the number of entries — reliable, latest
   * and stream alike — currently queued in the `pushes` lane, across every
   * channel and key. O(lane length): a plain walk, never called from a hot
   * path (only tests use it to observe queue growth without reaching into
   * the closure's private state).
   */
  pieceCount(): number;
  /**
   * Test-only accessor (Task 6 fix round 1): the total number of
   * per-`(channel,key)` `StreamKeyState` entries currently tracked, across
   * every channel — including a key with zero queued entries, which is
   * exactly the leak this exists to catch (a dropped zero-byte "new entry"
   * chunk must never leave one of these behind for a key it never actually
   * queued anything for). O(channel/key count), test-only.
   */
  streamKeyStateCount(): number;
  dispose(): void;
};

type ControlEntry = { text: string; bytes: number };

type ReliableEntry = { kind: "reliable"; channel: string; payload: unknown; bytes: number };
type LatestEntry = { kind: "latest"; channel: string; payload: unknown; bytes: number };
type StreamEntry = {
  kind: "stream";
  channel: string;
  key: string | undefined;
  template: unknown;
  /** Coalesced pieces, oldest first; joined into one string only when sent. */
  chunks: string[];
  /** Sum of `chunks[i].length` (UTF-16 units) — the offset-contiguity check needs this without joining. */
  chunkLength: number;
  offset: number | undefined;
  dropped: number;
  /** Rule 2: `utf8Bytes` of the joined chunk content. */
  bytes: number;
  /** Wire-byte estimate of the joined chunk content once JSON-escaped (see file header). */
  wireBytes: number;
};
type PushEntry = ReliableEntry | LatestEntry | StreamEntry;

/** A node in the `pushes` doubly linked list; stream nodes are additionally threaded per `(channel,key)`. */
type PushNode = {
  entry: PushEntry;
  prev: PushNode | undefined;
  next: PushNode | undefined;
  /** Assigned once, monotonically, at append — never reused. Lets coalescing check "is anything reliable after me?" in O(1). */
  insertIndex: number;
  keyPrev: PushNode | undefined;
  keyNext: PushNode | undefined;
};

/** Per-`(channel,key)` running state for the stream cap: total rule-2 bytes and the oldest/newest queued entry. */
type StreamKeyState = { bytes: number; head: PushNode | undefined; tail: PushNode | undefined };

export function createOutbox(deps: OutboxDeps): Outbox {
  const { socket, policies, now, timers, log, onCongested } = deps;

  const control: ControlEntry[] = [];
  let controlBytesTotal = 0;

  let pushHead: PushNode | undefined;
  let pushTail: PushNode | undefined;
  let insertCounter = 0;
  let lastReliableInsertIndex = 0;
  let pushBytesTotal = 0; // rule-2 sum over the pushes lane
  let pushWireBytesTotal = 0; // wire-byte sum over the pushes lane (see file header)

  const latestNodes = new Map<string, PushNode>(); // channel -> its one queued latest node
  const streamKeyStates = new Map<string, Map<string | undefined, StreamKeyState>>();

  let nextSeq = 1;
  let tickHandle: unknown;
  let congestedSince: number | undefined;
  let congestedFired = false;
  let disposed = false;
  const loggedMissingChannels = new Set<string>();

  // --- byte accounting ---------------------------------------------------

  /**
   * The UTF-8 byte length `JSON.stringify` would give this string's content
   * once escaped, computed by walking it instead of calling
   * `JSON.stringify` — so a chunk's wire contribution is O(its own length)
   * once, at enqueue/drop time, never O(the whole accumulated entry) on
   * every check. JSON escapes only `"`, `\`, and control characters
   * (U+0000-U+001F): `\b \f \n \r \t` as a 2-byte short escape, every other
   * control character (including ESC) as `\u00XX` (6 bytes); everything
   * else keeps its own UTF-8 byte length (matching `Buffer.byteLength`'s
   * convention of 3 bytes for a lone surrogate, same as `utf8Bytes`).
   */
  function escapedWireBytes(text: string): number {
    let total = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0x22 || code === 0x5c) {
        total += 2; // \" or \\
      } else if (
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
      ) {
        total += 2; // \b \t \n \f \r
      } else if (code < 0x20) {
        total += 6; // \u00XX — includes ESC (0x1b)
      } else if (code < 0x80) {
        total += 1;
      } else if (code < 0x800) {
        total += 2;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          total += 4; // a valid surrogate pair is one 4-byte UTF-8 code point
          i++;
        } else {
          total += 3; // lone high surrogate
        }
      } else {
        total += 3; // BMP char >= 0x800, or a lone low surrogate
      }
    }
    return total;
  }

  function queuedBytes(): number {
    return controlBytesTotal + pushBytesTotal;
  }

  /** See the `Outbox.pieceCount` doc comment — test-only, O(lane length). */
  function pieceCount(): number {
    let count = 0;
    for (let node = pushHead; node !== undefined; node = node.next) count++;
    return count;
  }

  /** See the `Outbox.streamKeyStateCount` doc comment — test-only. */
  function streamKeyStateCount(): number {
    let count = 0;
    for (const byChannel of streamKeyStates.values()) count += byChannel.size;
    return count;
  }

  /** Wire-byte total over both lanes: what the congestion thresholds (rule 6/7) compare against. */
  function wireQueuedBytes(): number {
    return controlBytesTotal + pushWireBytesTotal;
  }

  /**
   * M12 Task 12 minor: a fixed category plus, when the thrown value carries
   * one, its `code` — never `describeError(error)`'s free-text message.
   * Every caller here passes an error from encoding or building a push
   * message for `channel`, whose payload is caller/device content (the
   * M10 token rule's own shape of concern: never logged) — the same
   * token-safety discipline `devices.ts`'s `logPushWriteFailure` already
   * applies to a push-record write failure. `code` is read defensively
   * (never assumed to be a string), since `error` is whatever the failing
   * step threw, not something this module controls the shape of.
   */
  function logChannel(prefix: string, channel: string, error?: unknown): void {
    if (error === undefined) {
      log(`outbox: ${prefix} ${channel}`);
      return;
    }
    const code =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code.slice(0, 32)
        : undefined;
    log(`outbox: ${prefix} ${channel}${code !== undefined ? ` code=${code}` : ""}`);
  }

  function logMissingPolicyOnce(channel: string): void {
    if (loggedMissingChannels.has(channel)) return;
    loggedMissingChannels.add(channel);
    logChannel("no policy for channel", channel);
  }

  // --- pushes lane: linked-list plumbing ----------------------------------

  function appendPushNode(entry: PushEntry): PushNode {
    const node: PushNode = {
      entry,
      prev: pushTail,
      next: undefined,
      insertIndex: ++insertCounter,
      keyPrev: undefined,
      keyNext: undefined,
    };
    if (pushTail !== undefined) pushTail.next = node;
    pushTail = node;
    if (pushHead === undefined) pushHead = node;
    return node;
  }

  function unlinkMainNode(node: PushNode): void {
    if (node.prev !== undefined) node.prev.next = node.next;
    else pushHead = node.next;
    if (node.next !== undefined) node.next.prev = node.prev;
    else pushTail = node.prev;
    node.prev = undefined;
    node.next = undefined;
  }

  function getOrCreateStreamKeyState(channel: string, key: string | undefined): StreamKeyState {
    let byChannel = streamKeyStates.get(channel);
    if (byChannel === undefined) {
      byChannel = new Map();
      streamKeyStates.set(channel, byChannel);
    }
    let state = byChannel.get(key);
    if (state === undefined) {
      state = { bytes: 0, head: undefined, tail: undefined };
      byChannel.set(key, state);
    }
    return state;
  }

  function linkStreamNode(node: PushNode, state: StreamKeyState): void {
    node.keyPrev = state.tail;
    if (state.tail !== undefined) state.tail.keyNext = node;
    state.tail = node;
    if (state.head === undefined) state.head = node;
  }

  function unlinkStreamNode(node: PushNode, state: StreamKeyState): void {
    if (node.keyPrev !== undefined) node.keyPrev.keyNext = node.keyNext;
    else state.head = node.keyNext;
    if (node.keyNext !== undefined) node.keyNext.keyPrev = node.keyPrev;
    else state.tail = node.keyPrev;
    node.keyPrev = undefined;
    node.keyNext = undefined;
  }

  /**
   * Removes `node` from the pushes lane entirely (sent, purged, or capped
   * away) and unwinds every running total / auxiliary index it took part
   * in. O(1) — never rescans the lane.
   */
  function removeNode(node: PushNode): void {
    const entry = node.entry;
    unlinkMainNode(node);
    pushBytesTotal -= entry.bytes;
    if (entry.kind === "stream") {
      pushWireBytesTotal -= entry.wireBytes;
      const byChannel = streamKeyStates.get(entry.channel);
      const state = byChannel?.get(entry.key);
      if (state !== undefined) {
        unlinkStreamNode(node, state);
        if (state.head === undefined) {
          byChannel?.delete(entry.key);
          if (byChannel !== undefined && byChannel.size === 0)
            streamKeyStates.delete(entry.channel);
        }
      }
    } else {
      pushWireBytesTotal -= entry.bytes; // reliable/latest: wire bytes === rule-2 bytes (see file header)
      if (entry.kind === "latest" && latestNodes.get(entry.channel) === node) {
        latestNodes.delete(entry.channel);
      }
    }
  }

  // --- sending -------------------------------------------------------------

  /** Rule 8/9: every socket write is wrapped and logged, never left to throw into caller code. */
  function sendRaw(text: string): void {
    try {
      socket.send(text);
    } catch (error) {
      log(`outbox: send failed: ${describeError(error)}`);
    }
  }

  function buildPushMessage(
    channel: string,
    policy: ChannelPolicy,
    payload: unknown,
    seq: number,
  ): ServerMessage {
    if (policy.kind === "stream") {
      const chunk = policy.chunkOf(payload);
      const offset = policy.offsetOf(payload);
      const wire = policy.withChunk(payload, chunk, offset);
      return { t: "psh", ch: channel, p: wire, seq };
    }
    return { t: "psh", ch: channel, p: payload, seq };
  }

  function buildQueuedPushMessage(entry: PushEntry, seq: number): ServerMessage {
    if (entry.kind === "stream") {
      const policy = policies.get(entry.channel) as StreamPolicy;
      const chunk = entry.chunks.join("");
      const wire = policy.withChunk(entry.template, chunk, entry.offset);
      const message: ServerMessage = { t: "psh", ch: entry.channel, p: wire, seq };
      return entry.dropped > 0 ? { ...message, dropped: entry.dropped } : message;
    }
    return { t: "psh", ch: entry.channel, p: entry.payload, seq };
  }

  /**
   * Encodes and sends one push frame. Rule 8: an encoding failure (a
   * BigInt in the payload, say) is logged by channel name only and the
   * entry discarded without ever consuming a `seq` — the next push that
   * does encode gets the very next number, no gap.
   */
  function sendPushMessage(channel: string, message: ServerMessage, seq: number): void {
    let text: string;
    try {
      text = encodeMessage(message);
    } catch (error) {
      logChannel("encode", channel, error);
      return;
    }
    nextSeq = seq + 1;
    sendRaw(text);
  }

  function sendFastPush(channel: string, policy: ChannelPolicy, payload: unknown): void {
    const seq = nextSeq;
    let message: ServerMessage;
    try {
      message = buildPushMessage(channel, policy, payload, seq);
    } catch (error) {
      logChannel("build", channel, error);
      return;
    }
    sendPushMessage(channel, message, seq);
  }

  function sendControlHead(): void {
    const entry = control.shift();
    if (entry === undefined) return;
    controlBytesTotal -= entry.bytes;
    sendRaw(entry.text);
  }

  function sendPushHead(): void {
    const node = pushHead;
    if (node === undefined) return;
    const entry = node.entry;
    removeNode(node);
    const seq = nextSeq;
    let message: ServerMessage;
    try {
      message = buildQueuedPushMessage(entry, seq);
    } catch (error) {
      logChannel("build", entry.channel, error);
      return;
    }
    sendPushMessage(entry.channel, message, seq);
  }

  // --- congestion / disposal -------------------------------------------

  function fireCongested(reason: "sustained" | "ceiling"): void {
    if (congestedFired) return;
    congestedFired = true;
    onCongested(reason);
    dispose();
  }

  /** Rule 6: after any enqueue (control or push), the ceiling is checked synchronously, in wire bytes. */
  function afterEnqueue(): void {
    if (disposed) return;
    if (socket.bufferedAmount + wireQueuedBytes() > MAX_QUEUED_BYTES) fireCongested("ceiling");
  }

  /**
   * M5 final Minor 1 (Task 6): a fast-path send (`reply`/`push` writing
   * straight to `socket.send` because both lanes were empty and the socket
   * was under the watermark) skipped both checks the queued path always
   * runs — a single oversized frame could push `bufferedAmount` straight
   * past `MAX_QUEUED_BYTES` with nothing to ever notice, and the 4 MiB/10 s
   * sustained-congestion rule only ever got evaluated on the *next*
   * enqueue, which a socket that goes on sending nothing but fast-path
   * frames might never produce. Run the identical ceiling check `afterEnqueue`
   * runs (nothing was queued, so `wireQueuedBytes()` contributes nothing new
   * — only `socket.bufferedAmount`, which the send just grew), then arm the
   * tick whenever there is anything still sitting in the socket's own send
   * buffer, so `onTick`'s sustained-congestion clock starts counting without
   * waiting for a later enqueue that may never come.
   */
  function afterFastSend(): void {
    // Task 6 fix round 1 (review minor): the ceiling check is the exact
    // same check `afterEnqueue` already runs — nothing was queued by a
    // fast-path send, so `wireQueuedBytes()` contributes nothing new here
    // either, and reusing it rather than repeating its condition is what
    // keeps the two checks from ever silently drifting apart. `disposed`
    // is re-checked after, since `afterEnqueue` disposes on a ceiling hit
    // (via `fireCongested`) and arming a tick behind a just-disposed
    // outbox would leave a stray timer this outbox can no longer clear.
    afterEnqueue();
    if (disposed) return;
    if (socket.bufferedAmount > 0) armTick();
  }

  function armTick(): void {
    if (disposed) return;
    if (tickHandle !== undefined) return;
    tickHandle = timers.setTimeout(onTick, OUTBOX_TICK_MS);
  }

  function lanesEmpty(): boolean {
    return control.length === 0 && pushHead === undefined;
  }

  function flush(): void {
    while (!lanesEmpty() && socket.bufferedAmount < SEND_WATERMARK_BYTES) {
      if (control.length > 0) sendControlHead();
      else sendPushHead();
    }
  }

  function onTick(): void {
    tickHandle = undefined;
    if (disposed) return;

    const q = socket.bufferedAmount + wireQueuedBytes();
    if (q > MAX_QUEUED_BYTES) {
      fireCongested("ceiling");
      return;
    }
    if (q > CONGESTED_BYTES) {
      if (congestedSince === undefined) {
        congestedSince = now();
      } else if (now() - congestedSince >= CONGESTION_CLOSE_MS) {
        fireCongested("sustained");
        return;
      }
    } else {
      congestedSince = undefined; // rule 3: cleared once drained back under the threshold
    }

    flush();
    if (disposed) return;
    if (!lanesEmpty() || socket.bufferedAmount > 0) armTick();
  }

  // --- enqueue: control ----------------------------------------------------

  function reply(text: string): void {
    if (disposed) return;
    if (lanesEmpty() && socket.bufferedAmount < SEND_WATERMARK_BYTES) {
      sendRaw(text);
      afterFastSend();
      return;
    }
    const bytes = utf8Bytes(text);
    control.push({ text, bytes });
    controlBytesTotal += bytes;
    armTick();
    afterEnqueue();
  }

  // --- enqueue: pushes -------------------------------------------------

  /** Rule 2: reliable/latest bytes are `utf8Bytes(JSON.stringify(payload))`, computed at enqueue. */
  function tryStringifyBytes(channel: string, payload: unknown): number | undefined {
    try {
      return utf8Bytes(JSON.stringify(payload) as string);
    } catch (error) {
      logChannel("encode", channel, error);
      return undefined;
    }
  }

  function offsetsContiguous(
    entryOffset: number | undefined,
    entryChunkLength: number,
    newOffset: number | undefined,
  ): boolean {
    if (entryOffset === undefined && newOffset === undefined) return true;
    if (entryOffset === undefined || newOffset === undefined) return false;
    return entryOffset + entryChunkLength === newOffset;
  }

  function applyStreamDrop(
    entry: StreamEntry,
    state: StreamKeyState,
    droppedBytes: number,
    wireDelta: number,
    droppedUnits: number,
  ): void {
    entry.dropped += droppedBytes;
    if (entry.offset !== undefined) entry.offset += droppedUnits;
    entry.chunkLength -= droppedUnits;
    entry.bytes -= droppedBytes;
    entry.wireBytes -= wireDelta;
    state.bytes -= droppedBytes;
    pushBytesTotal -= droppedBytes;
    pushWireBytesTotal -= wireDelta;
  }

  /**
   * Drops `excess` rule-2 bytes from the head of `entry`'s piece queue,
   * whole pieces at a time (O(that piece's own length), never the whole
   * entry) and, for the one piece straddling the cut, `dropHead` on just
   * that piece.
   */
  function dropFromStreamEntry(entry: StreamEntry, state: StreamKeyState, excess: number): void {
    let remaining = excess;
    while (remaining > 0 && entry.chunks.length > 0) {
      const piece = entry.chunks[0] as string;
      const pieceBytes = utf8Bytes(piece);
      if (pieceBytes <= remaining) {
        entry.chunks.shift();
        applyStreamDrop(entry, state, pieceBytes, escapedWireBytes(piece), piece.length);
        remaining -= pieceBytes;
      } else {
        const { rest, droppedBytes, droppedUnits } = dropHead(piece, remaining);
        entry.chunks[0] = rest;
        applyStreamDrop(
          entry,
          state,
          droppedBytes,
          escapedWireBytes(piece.slice(0, droppedUnits)),
          droppedUnits,
        );
        remaining -= droppedBytes;
      }
    }
  }

  /**
   * Rule 5: while a `(channel,key)`'s queued bytes exceed `maxBytes`, drop
   * from its oldest queued entry's head; an entry drained to empty is
   * removed and its `dropped` count moves onto the next entry for the same
   * key (`node.keyNext` — O(1), the per-key thread this node was part of).
   */
  function enforceStreamCap(state: StreamKeyState, maxBytes: number): void {
    while (state.bytes > maxBytes && state.head !== undefined) {
      const node = state.head;
      const entry = node.entry as StreamEntry;
      dropFromStreamEntry(entry, state, state.bytes - maxBytes);
      if (entry.chunks.length === 0) {
        const carryDropped = entry.dropped;
        const nextSameKey = node.keyNext;
        removeNode(node);
        if (nextSameKey !== undefined) (nextSameKey.entry as StreamEntry).dropped += carryDropped;
      }
    }
  }

  function enqueueStream(
    channel: string,
    policy: StreamPolicy,
    payload: unknown,
    key: string | undefined,
  ): void {
    // Rule 8, extended to the queued path: the fast path already wraps
    // chunkOf/offsetOf (buildPushMessage, inside sendFastPush's try). A
    // throw here must not propagate into hub.ts's per-connection push
    // loop and skip the remaining connections for this push — logged by
    // channel name only, the push itself is dropped instead.
    let chunk: string;
    let offset: number | undefined;
    try {
      chunk = policy.chunkOf(payload);
      offset = policy.offsetOf(payload);
    } catch (error) {
      logChannel("build", channel, error);
      return;
    }
    const bytes = utf8Bytes(chunk);
    const wireBytes = escapedWireBytes(chunk);

    // Task 6 fix round 1 (review minor): a *non-creating* lookup — reading
    // whatever `(channel,key)` state already exists, never conjuring one
    // into being just to check it. `getOrCreateStreamKeyState` is called
    // below only on the two branches that actually queue something; the
    // drop branch (a zero-byte chunk with nothing to coalesce into) never
    // touches `streamKeyStates` at all, so it can never leave an empty
    // `StreamKeyState` map entry behind for a key that never got a real
    // push.
    const existingState = streamKeyStates.get(channel)?.get(key);

    // Rule 4c: coalesce into the newest queued entry for this key, unless a
    // reliable entry has been appended since — `insertIndex` makes that an
    // O(1) check instead of a backward scan of the whole lane.
    const target =
      existingState?.tail !== undefined && existingState.tail.insertIndex > lastReliableInsertIndex
        ? (existingState.tail.entry as StreamEntry)
        : undefined;

    let state: StreamKeyState;
    if (target !== undefined && offsetsContiguous(target.offset, target.chunkLength, offset)) {
      // `target` only ever comes from `existingState`, so this is always defined here.
      state = existingState as StreamKeyState;
      // Minor 1 (fix round 1): an empty chunk carries no content — leave
      // the piece queue untouched (offset contiguity for the *next* push
      // still works, since chunkLength/offset already reflect zero added
      // units) rather than growing `chunks` with a piece that can never
      // reach the cap and so is never dropped.
      if (chunk.length > 0) {
        const lastIndex = target.chunks.length - 1;
        const lastPiece = lastIndex >= 0 ? (target.chunks[lastIndex] as string) : undefined;
        if (lastPiece !== undefined && lastPiece.length < CHUNK_MERGE_THRESHOLD_BYTES) {
          target.chunks[lastIndex] = lastPiece + chunk;
        } else {
          target.chunks.push(chunk);
        }
      }
      target.chunkLength += chunk.length;
      target.bytes += bytes;
      target.wireBytes += wireBytes;
      target.template = payload;
    } else if (chunk.length > 0) {
      state = getOrCreateStreamKeyState(channel, key);
      const entry: StreamEntry = {
        kind: "stream",
        channel,
        key,
        template: payload,
        chunks: [chunk],
        chunkLength: chunk.length,
        offset,
        dropped: 0,
        bytes,
        wireBytes,
      };
      const node = appendPushNode(entry);
      linkStreamNode(node, state);
    } else {
      // Task 6 (M5 T2, security review requirement 4): a zero-byte chunk
      // that would *start* a new entry — no contiguous target to absorb it
      // into — carries no content and commits no offset of its own, so it
      // is dropped at enqueue rather than becoming a phantom StreamEntry: a
      // queued node with an empty `chunks` array that a stalled connection
      // could still flush as a content-free `psh` frame before anything
      // real ever reaches it. `existingState`/`streamKeyStates` are left
      // exactly as they were — untouched, not just unlinked — so a later
      // real chunk's contiguity check runs against whichever real entry
      // (if any) actually precedes this offset, unaffected by a push that
      // never happened. A real chunk (`chunk.length > 0`) always takes one
      // of the branches above instead; this one is reached only when
      // `chunk.length === 0`, so a real chunk can never be dropped here.
      return;
    }
    state.bytes += bytes;
    pushBytesTotal += bytes;
    pushWireBytesTotal += wireBytes;

    enforceStreamCap(state, policy.maxBytes);
  }

  function enqueueReliable(channel: string, payload: unknown, bytes: number): void {
    const entry: ReliableEntry = { kind: "reliable", channel, payload, bytes };
    appendPushNode(entry);
    pushBytesTotal += bytes;
    pushWireBytesTotal += bytes;
    lastReliableInsertIndex = insertCounter;
  }

  function enqueueLatest(channel: string, payload: unknown, bytes: number): void {
    const existing = latestNodes.get(channel);
    if (existing !== undefined) {
      const entry = existing.entry as LatestEntry;
      pushBytesTotal += bytes - entry.bytes;
      pushWireBytesTotal += bytes - entry.bytes;
      entry.payload = payload;
      entry.bytes = bytes;
      return;
    }
    const entry: LatestEntry = { kind: "latest", channel, payload, bytes };
    const node = appendPushNode(entry);
    latestNodes.set(channel, node);
    pushBytesTotal += bytes;
    pushWireBytesTotal += bytes;
  }

  function enqueuePush(
    channel: string,
    policy: ChannelPolicy,
    payload: unknown,
    key: string | undefined,
  ): void {
    if (policy.kind === "reliable") {
      const bytes = tryStringifyBytes(channel, payload);
      if (bytes === undefined) return;
      enqueueReliable(channel, payload, bytes);
      return;
    }
    if (policy.kind === "latest") {
      const bytes = tryStringifyBytes(channel, payload);
      if (bytes === undefined) return;
      enqueueLatest(channel, payload, bytes);
      return;
    }
    enqueueStream(channel, policy, payload, key);
  }

  function push(channel: string, payload: unknown, key: string | undefined): void {
    if (disposed) return;
    const policy = policies.get(channel);
    if (policy === undefined) {
      logMissingPolicyOnce(channel);
      return;
    }
    if (lanesEmpty() && socket.bufferedAmount < SEND_WATERMARK_BYTES) {
      sendFastPush(channel, policy, payload);
      afterFastSend();
      return;
    }
    enqueuePush(channel, policy, payload, key);
    armTick();
    afterEnqueue();
  }

  // --- purge / dispose ---------------------------------------------------

  /**
   * A stream entry's key is stored directly; a reliable entry has no key
   * field (the interface gives it none), so a keyed `reliable` policy's
   * entries are matched by recomputing `policy.keyOf(entry.payload)` on
   * demand instead. An unkeyed policy (`latest`, or `reliable` without
   * `keyOf`) only ever gets purged with `key === undefined`.
   */
  function matchesPurgeTarget(entry: PushEntry, channel: string, key: string | undefined): boolean {
    if (entry.channel !== channel) return false;
    if (entry.kind === "stream") return entry.key === key;
    const policy = policies.get(channel);
    if (policy !== undefined && policy.kind === "reliable" && policy.keyOf !== undefined) {
      // Same rule-8 treatment as the queued enqueue path: a throwing
      // keyOf must not abort the purge loop for every other entry — this
      // one entry is treated as not matching (left queued) and logged.
      try {
        return policy.keyOf(entry.payload) === key;
      } catch (error) {
        logChannel("build", channel, error);
        return false;
      }
    }
    return key === undefined;
  }

  function purge(channel: string, key: string | undefined): void {
    if (disposed) return;
    let node = pushHead;
    while (node !== undefined) {
      const next = node.next;
      if (matchesPurgeTarget(node.entry, channel, key)) removeNode(node);
      node = next;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    control.length = 0;
    controlBytesTotal = 0;
    pushHead = undefined;
    pushTail = undefined;
    pushBytesTotal = 0;
    pushWireBytesTotal = 0;
    latestNodes.clear();
    streamKeyStates.clear();
    congestedSince = undefined; // rule 10 / ruling 3: cleared on dispose too
    if (tickHandle !== undefined) {
      timers.clearTimeout(tickHandle);
      tickHandle = undefined;
    }
  }

  return { reply, push, purge, queuedBytes, pieceCount, streamKeyStateCount, dispose };
}
