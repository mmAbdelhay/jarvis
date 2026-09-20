// The session stream store (Task 4): attaches to one session's output,
// de-duplicates against a `RpcClient`'s pushes with the cursor in
// `stream-cursor.ts`, and re-attaches after every reconnect (M5 plan
// ruling 10; M7 rulings 7, 8, 9). See
// the mobile milestone 7, task 4 plan (docs/superpowers/plans)
// and, for fix round 1, task-4-review.md and progress.md's amending
// ruling (I2/I3/I4).
//
// Logging discipline (rule 7 of the brief): `log` lines carry only the
// phase, the session id and the running gap count — never chunk or
// snapshot text.

import type { Clock } from "./clock";
import type { RpcClient, RpcError } from "./rpc-client";
import {
  applyChunk,
  applySnapshot,
  gapMarker,
  parseSnapshot,
  parseStreamChunk,
} from "./stream-cursor";

export const ATTACH_BUFFER_MAX_CHARS = 1_048_576;

// Fix round 1, I3: a snapshot `timeout` is retried in place (still
// subscribed, still buffering) rather than sticking the store in
// `waiting` forever while the socket stays open and the watchdog never
// fires again.
const SNAPSHOT_RETRY_DELAYS_MS = [1_000, 3_000];

export type TerminalSink = {
  write(data: string): void;
  reset(): void;
};

export type SessionStreamPhase = "idle" | "attaching" | "live" | "waiting" | "failed";

export type SessionStreamView = {
  phase: SessionStreamPhase;
  gapCount: number;
  droppedBytes: number;
  // Fix round 1, I4: a push that fails to parse, or belongs to another
  // session, is ignored *and counted* (brief rule 3) — surfaced here since
  // the view is the store's one public stat surface.
  ignoredCount: number;
  error?: RpcError;
};

export type SessionStream = {
  get(): SessionStreamView;
  subscribe(listener: (view: SessionStreamView) => void): () => void;
  open(sink: TerminalSink): void;
  close(): void;
  restart(sink: TerminalSink): void;
  // Fix round 1, I3: restarts attach from a `failed` phase (e.g. after the
  // snapshot retries are exhausted). A new `open` state still restarts
  // attach on its own, same as before.
  retry(): void;
};

type BufferedPush = { offset: number; chunk: string; dropped: number | undefined };

// M9 Task 7: the attach/replay/gap-marker machinery below is identical for
// a session's own pty and one of the Workspace's existing terminal panes —
// only the channel names, the push payload's key field and the id itself
// differ (see terminal-stream.ts). `createAttachStream` is that shared
// core; `createSessionStream` is now a thin, exports-preserving wrapper
// around it, so every existing session-stream.test.ts case (and its
// `sessionId`-shaped call site in session/[id].tsx) is untouched.
export type AttachStreamDeps = {
  client: RpcClient;
  /** The subscription key and the value `keyField` must match on every
   *  push — a session id or a terminal pane key. */
  id: string;
  /** The push channel to subscribe/listen on (`session:output` or
   *  `terminal:data`). */
  pushChannel: string;
  /** The field name a push's payload carries `id` under (`sessionId` or
   *  `paneKey`) — passed straight through to `parseStreamChunk`. */
  keyField: string;
  /** The RPC channel that returns this attach's backlog + cursor
   *  (`session:snapshot` or `terminal:snapshot`). */
  snapshotChannel: string;
  /** The fixed first word of every log line this store emits — kept
   *  distinct per caller only so a log reader can tell a session's stream
   *  from a terminal pane's; never any content from the stream itself. */
  logPrefix: string;
  log(line: string): void;
  clock: Clock;
};

export function createAttachStream(deps: AttachStreamDeps): SessionStream {
  const { client, id } = deps;
  const target = { ch: deps.pushChannel, key: id };

  const listeners = new Set<(view: SessionStreamView) => void>();
  let view: SessionStreamView = {
    phase: "idle",
    gapCount: 0,
    droppedBytes: 0,
    ignoredCount: 0,
  };

  let opened = false;
  let sink: TerminalSink | undefined;
  let rendered = 0;
  let attachGeneration = 0;

  let buffer: BufferedPush[] = [];
  let bufferChars = 0;
  // Fix round 1, Minor 4: the dropped count of a buffer entry evicted by
  // the cap is not lost — it's carried onto the next buffered entry (or
  // held here until one arrives), the same way the laptop's outbox merges
  // a head-dropped chunk's count forward.
  let carryDropped = 0;

  let unsubscribePush: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;
  let retryTimer: unknown;

  function setView(patch: Partial<SessionStreamView>): void {
    const phaseChanged = patch.phase !== undefined && patch.phase !== view.phase;
    view = { ...view, ...patch };
    if (phaseChanged) {
      deps.log(`${deps.logPrefix}: ${view.phase} id=${id} gaps=${view.gapCount}`);
    }
    for (const listener of [...listeners]) {
      listener(view);
    }
  }

  function cancelRetryTimer(): void {
    if (retryTimer !== undefined) {
      deps.clock.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  }

  function clearBuffer(): void {
    buffer = [];
    bufferChars = 0;
    carryDropped = 0;
  }

  function bufferPush(offset: number, chunk: string, dropped: number | undefined): void {
    let effectiveDropped = dropped;
    if (carryDropped > 0) {
      effectiveDropped = (effectiveDropped ?? 0) + carryDropped;
      carryDropped = 0;
    }
    buffer.push({ offset, chunk, dropped: effectiveDropped });
    bufferChars += chunk.length;
    while (bufferChars > ATTACH_BUFFER_MAX_CHARS && buffer.length > 0) {
      const removed = buffer.shift();
      if (removed === undefined) break;
      bufferChars -= removed.chunk.length;
      if (removed.dropped !== undefined) carryDropped += removed.dropped;
    }
    if (buffer.length > 0 && carryDropped > 0) {
      const head = buffer[0];
      if (head !== undefined) {
        head.dropped = (head.dropped ?? 0) + carryDropped;
        carryDropped = 0;
      }
    }
  }

  /**
   * Writes a cursor step's gap marker (if any) and text to the live sink.
   * Fix round 1, I2: the marker (and the gap stats) reflect a real,
   * unrendered gap only — `step.gapUnits > 0` after skip/trim — never
   * merely because the push carried `dropped > 0`. A push whose bytes are
   * already fully covered by an earlier snapshot or push must draw no
   * marker at all, even if the laptop reports bytes dropped for that same
   * range. The marker is always its own `sink.write` call, never
   * concatenated into the text write, so it can't split a chunk.
   */
  function writeStep(
    step: { write: string; gapUnits: number; reset: boolean },
    dropped: number | undefined,
    suppressMarker: boolean,
  ): void {
    if (sink === undefined) return;
    if (step.reset) sink.reset();
    if (step.gapUnits > 0 && !suppressMarker) {
      sink.write(gapMarker(dropped));
      setView({
        gapCount: view.gapCount + 1,
        droppedBytes: view.droppedBytes + (dropped ?? 0),
      });
    }
    if (step.write.length > 0) sink.write(step.write);
  }

  function applyPush(offset: number, chunk: string, dropped: number | undefined): void {
    const step = applyChunk(rendered, offset, chunk);
    writeStep(step, dropped, false);
    rendered = step.rendered;
  }

  function drainBuffer(): void {
    const pending = buffer;
    clearBuffer();
    for (const entry of pending) {
      applyPush(entry.offset, entry.chunk, entry.dropped);
    }
  }

  function applySnapshotAnswer(value: unknown, suppressMarker: boolean): void {
    const snapshot = parseSnapshot(value);
    if (snapshot === undefined) {
      setView({ phase: "failed", error: undefined });
      return;
    }
    const step = applySnapshot(rendered, snapshot);
    writeStep(step, undefined, suppressMarker);
    rendered = step.rendered;
    drainBuffer();
    setView({ phase: "live" });
  }

  function attemptSnapshot(generation: number, retryIndex: number, suppressMarker: boolean): void {
    void client.call(deps.snapshotChannel, [id]).then((result) => {
      if (!opened || generation !== attachGeneration) return; // stale or closed

      if (!result.ok) {
        if (result.error.kind === "timeout") {
          const delay = SNAPSHOT_RETRY_DELAYS_MS[retryIndex];
          if (delay !== undefined) {
            // Stay in "attaching": pushes keep buffering across the retry.
            retryTimer = deps.clock.setTimeout(() => {
              retryTimer = undefined;
              if (!opened || generation !== attachGeneration) return;
              // Fix round 2, Minor 3: the socket may have dropped while we
              // waited for the retry delay. Re-attaching here would queue a
              // snapshot call under the default queueing option while the
              // client isn't `open` — wasted, since the next `open` event
              // starts a fresh generation that supersedes it anyway (the
              // same wasted-snapshot shape Minor 2 fixed for the initial
              // attach). Do nothing; `handleState`'s `open` branch restarts
              // attach as usual.
              if (client.state() !== "open") return;
              attemptSnapshot(generation, retryIndex + 1, suppressMarker);
            }, delay);
            return;
          }
          setView({ phase: "failed", error: undefined });
          return;
        }
        if (result.error.kind === "offline") {
          setView({ phase: "waiting" });
          return;
        }
        setView({ phase: "failed", error: result.error });
        return;
      }

      applySnapshotAnswer(result.value, suppressMarker);
    });
  }

  function startAttach(): void {
    attachGeneration += 1;
    const generation = attachGeneration;
    cancelRetryTimer();
    clearBuffer();
    const suppressMarker = rendered === 0;
    setView({ phase: "attaching" });
    attemptSnapshot(generation, 0, suppressMarker);
  }

  function handlePush(payload: unknown, dropped: number | undefined): void {
    if (!opened) return;
    const parsed = parseStreamChunk(payload, deps.keyField, id);
    if (parsed === undefined) {
      setView({ ignoredCount: view.ignoredCount + 1 }); // another session's push, or malformed
      return;
    }

    if (view.phase === "attaching") {
      bufferPush(parsed.offset, parsed.chunk, dropped);
      return;
    }
    if (view.phase !== "live") return;
    applyPush(parsed.offset, parsed.chunk, dropped);
  }

  function handleState(state: string): void {
    if (!opened) return;
    if (state === "open") {
      startAttach(); // ruling 7: re-attach on every welcome, keeping `rendered`
      return;
    }
    if (view.phase === "live" || view.phase === "attaching") {
      setView({ phase: "waiting" });
    }
  }

  function attachIfConnected(): void {
    // Fix round 1, Minor 2: don't queue a snapshot call that a later
    // `onState("open")` will immediately supersede — wait for that event
    // to start the (only) attach instead.
    if (client.state() === "open") {
      startAttach();
      return;
    }
    setView({ phase: "waiting" });
  }

  function open(newSink: TerminalSink): void {
    if (opened) return; // a second open without close is a no-op
    opened = true;
    sink = newSink;
    unsubscribePush = client.onPush(deps.pushChannel, handlePush);
    unsubscribeState = client.onState(handleState);
    client.subscribe(target);
    attachIfConnected();
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    cancelRetryTimer();
    unsubscribePush?.();
    unsubscribeState?.();
    unsubscribePush = undefined;
    unsubscribeState = undefined;
    client.unsubscribe(target);
    clearBuffer();
    sink = undefined;
    rendered = 0; // Fix round 1, Minor 3: the next open starts a fresh attach.
    setView({ phase: "idle", error: undefined });
  }

  function restart(newSink: TerminalSink): void {
    rendered = 0;
    if (!opened) {
      open(newSink);
      return;
    }
    sink = newSink;
    clearBuffer();
    attachIfConnected();
  }

  // Final review M6: retry() is meant to restart a *failed* attach (the
  // screen only shows its Retry control when phase is "failed"); gating it
  // here too means a stray call while `live` (or any other phase) can't
  // trigger a wasted re-snapshot.
  function retry(): void {
    if (!opened || view.phase !== "failed") return;
    attachIfConnected();
  }

  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open,
    close,
    restart,
    retry,
  };
}

export function createSessionStream(deps: {
  client: RpcClient;
  sessionId: string;
  log(line: string): void;
  clock: Clock;
}): SessionStream {
  return createAttachStream({
    client: deps.client,
    id: deps.sessionId,
    clock: deps.clock,
    log: deps.log,
    pushChannel: "session:output",
    keyField: "sessionId",
    snapshotChannel: "session:snapshot",
    logPrefix: "session-stream",
  });
}
