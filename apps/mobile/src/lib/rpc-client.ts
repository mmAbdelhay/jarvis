// The RPC client (Task 4): a state machine over a `Transport` that speaks
// the @jarvis/wire protocol — hello/welcome, request correlation with a
// drop-surviving queue, subscriptions that re-send after every `welcome`,
// a heartbeat watchdog, reconnect backoff and close-code routing. See
// the mobile milestone 6, task 4 plan (docs/superpowers/plans)
// and rulings.md (8-11) for the behaviour this file implements.
//
// Logging discipline (rule 9): `log` lines carry only state names, close
// codes, channel names, ids and counts — never the token, the secret,
// request args or payloads, and never a raw frame or free-form transport
// message text.

import {
  BLOB_IDLE_TIMEOUT_MS,
  CLOSE,
  HANDSHAKE_TIMEOUT_MS,
  MAX_BLOB_BYTES,
  MAX_MISSED_PONGS,
  PING_INTERVAL_MS,
  PROTOCOL_VERSION,
  REMOTE_ERROR_CODES,
  encodeMessage,
} from "@jarvis/wire";
import type { ClientMessage, RemoteErrorCode, ServerMessage, SubTarget } from "@jarvis/wire";
import { UPLOAD_CHUNK_BYTES, base64ByteLength, splitBase64 } from "./base64-chunks";
import { createBackoff } from "./backoff";
import type { Clock } from "./clock";
import type { Language } from "./i18n";
import type { Transport, TransportEvent, TransportSocket, Trust } from "./transport";
import { socketUrl } from "./transport";

export type ClientState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "open"
  | "reconnecting"
  | "unpaired"
  | "incompatible"
  | "closed";

export type Credential = { deviceId: string; token: string };
// M11: `name` is set only when the stored pairing was made under
// system-trust mode (rulings.md 1) — its presence, not `host`, decides
// both the dialled URL and the `Trust` handed to the transport.
export type Endpoint = { host: string; port: number; fingerprint: string; name?: string };

export type RpcError =
  | { kind: "remote"; code: RemoteErrorCode; text: string; language: Language }
  | { kind: "offline" }
  | { kind: "timeout" }
  | { kind: "unsupported" }
  // Task 5: a second `upload()` call while one is already in flight on this
  // socket — client-side only, never reaches the wire, so the first
  // upload's binary frames are never interleaved with a second header.
  | { kind: "busy" }
  // Task 5: the caller's own `cancelled()` predicate turned true between
  // two scheduled chunks — the header may already be on the wire, but no
  // further binary frames were sent.
  | { kind: "cancelled" };

export type RpcResult<T = unknown> = { ok: true; value: T } | { ok: false; error: RpcError };

export type CallOptions = {
  whenNotOpen?: "queue" | "reject";
  /** An integer 1000-600000 replaces the default request timeout for this
   * call only. Anything else (non-integer, out of range, `undefined`) is
   * ignored and the default applies. */
  timeoutMs?: number;
};

export type UploadOptions = {
  timeoutMs?: number;
  /** Task 5: called after each chunk is handed to the transport, with the
   *  cumulative decoded bytes sent so far and the total decoded byte count.
   *  Never called for a chunk that fails to send. */
  onProgress?(sent: number, total: number): void;
  /** Task 5: checked before each scheduled chunk is sent (including the
   *  first). Once it answers `true`, no further chunk is sent and the
   *  upload resolves `{ kind: "cancelled" }` — the caller's own cancel()
   *  button, not a transport failure. */
  cancelled?(): boolean;
};

export type RpcClientDeps = {
  transport: Transport;
  clock: Clock;
  random(): number;
  client: string;
  log(line: string): void;
};

export type RpcClient = {
  connect(endpoint: Endpoint, credential: Credential): void;
  disconnect(): void;
  call(channel: string, args: unknown[], options?: CallOptions): Promise<RpcResult>;
  upload(
    channel: string,
    args: unknown[],
    base64: string,
    options?: UploadOptions,
  ): Promise<RpcResult>;
  subscribe(target: SubTarget): RpcResult<void>;
  unsubscribe(target: SubTarget): void;
  onPush(
    channel: string,
    handler: (payload: unknown, dropped: number | undefined) => void,
  ): () => void;
  onState(
    handler: (
      state: ClientState,
      detail: {
        closeCode?: number;
        lastFrameAt?: number;
        pinMismatch?: true;
        // Task 5: set only on the one "open" notification `setAppActive(true)`
        // delivers itself, when the resume actually re-sent a `sub add` (or
        // would have — see setAppActive) — never on an ordinary welcome's
        // "open", including one that happens to land while not suspended.
        resumed?: true;
      },
    ) => void,
  ): () => void;
  state(): ClientState;
  capabilities(): readonly string[];
  subscriptions(): readonly SubTarget[];
  lastFrameAt(): number | undefined;
  // Task 5 (M10 ruling d): the app's own foreground/background signal,
  // driven by `_layout.tsx`'s one `AppState` listener through
  // `app-lifecycle.ts`'s `appActivityFor`. `false` drops every
  // subscription in one `sub drop` frame (if open) and stops new frames
  // for `subscribe`/`unsubscribe` while suspended; `true` re-sends them in
  // one `sub add` and notifies `onState("open", { resumed: true })`. Never
  // touches the socket itself — the connection stays open (or keeps
  // reconnecting) the whole time.
  setAppActive(active: boolean): void;
};

const REQUEST_TIMEOUT_MS = 30_000;
const QUEUE_CAP = 64;
const BACKOFF_RESET_AFTER_OPEN_MS = 10_000;
// Fix round 1 (Important 1): mirrors packages/remote/src/protocol.ts's own
// (private, unexported) `MAX_SUB_TARGETS` — the server refuses a `sub`
// frame whose `add`/`drop` array is longer than this. Not currently
// re-exported by @jarvis/wire, and adding that export is outside this
// task's file list, so the value is duplicated here rather than imported.
// `sendSubFrames` below (fix round 2: shared by both the resume/welcome
// add and the suspend drop) chunks at this boundary so a batch past 64
// targets, either direction, can never trip it.
const MAX_SUB_TARGETS = 64;
// "2 missed server pings" == no frame at all for two ping intervals plus
// the one the client itself was waiting on — see global-constraints.md.
const DEAD_SOCKET_MS = PING_INTERVAL_MS * (MAX_MISSED_PONGS + 1);
// RFC 6455's reserved "abnormal closure" code: never sent on the wire, used
// locally to route a transport-level `error` event through the same
// close-code table as every other drop.
const ABNORMAL_CLOSE = 1006;

type QueuedRequest = {
  channel: string;
  args: unknown[];
  resolve: (result: RpcResult) => void;
  timeoutMs?: number;
};
type InFlightRequest = {
  resolve: (result: RpcResult) => void;
  timer: unknown;
  /** Only set for an upload's own in-flight entry (fix round 1, I1) — lets
   *  handleRes/handleErr, which are shared with every ordinary call()
   *  reply, know whether *this* id still had unsent chunks the moment it
   *  settled, without either function needing to reach into upload()'s own
   *  closure. */
  upload?: { lastActivityAt(): number; allSent(): boolean };
};

/** Fix round 1 (I1): a small cushion added on top of the laptop's own
 *  BLOB_IDLE_TIMEOUT_MS so this client's local timer never fires a hair
 *  before the laptop's does — the busy latch below exists precisely to
 *  outlast the laptop's own window, never to race it. */
const BLOB_DRAIN_MARGIN_MS = 1_000;

/** An integer 1000-600000 replaces `REQUEST_TIMEOUT_MS` for one request;
 * anything else (including `undefined`) falls back to the default. */
function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (
    typeof timeoutMs === "number" &&
    Number.isInteger(timeoutMs) &&
    timeoutMs >= 1_000 &&
    timeoutMs <= 600_000
  ) {
    return timeoutMs;
  }
  return REQUEST_TIMEOUT_MS;
}

function subKey(target: SubTarget): string {
  return typeof target === "string" ? `s:${target}` : `k:${target.ch}:${target.key}`;
}

function targetChannel(target: SubTarget): string {
  return typeof target === "string" ? target : target.ch;
}

function isRemoteErrorCode(value: unknown): value is RemoteErrorCode {
  return typeof value === "string" && (REMOTE_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Parses one server frame defensively, field by field (never spreads the
 * parsed JSON into a typed value): @jarvis/wire ships types, not parsers,
 * for server frames. Returns `undefined` for anything that doesn't match —
 * never throws.
 */
function parseServerMessage(text: string): ServerMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;

  switch (obj.t) {
    case "welcome": {
      if (typeof obj.v !== "number") return undefined;
      if (
        !Array.isArray(obj.capabilities) ||
        !obj.capabilities.every((c) => typeof c === "string")
      ) {
        return undefined;
      }
      return { t: "welcome", v: obj.v, capabilities: obj.capabilities as string[] };
    }
    case "res": {
      if (typeof obj.id !== "number") return undefined;
      return { t: "res", id: obj.id, v: obj.v };
    }
    case "err": {
      if (typeof obj.id !== "number") return undefined;
      if (!isRemoteErrorCode(obj.code)) return undefined;
      if (typeof obj.text !== "string") return undefined;
      if (obj.language !== "ar" && obj.language !== "en") return undefined;
      return { t: "err", id: obj.id, code: obj.code, text: obj.text, language: obj.language };
    }
    case "psh": {
      if (typeof obj.ch !== "string") return undefined;
      if (typeof obj.seq !== "number") return undefined;
      const dropped = typeof obj.dropped === "number" ? obj.dropped : undefined;
      return { t: "psh", ch: obj.ch, p: obj.p, seq: obj.seq, dropped };
    }
    case "ping": {
      if (typeof obj.seq !== "number") return undefined;
      return { t: "ping", seq: obj.seq };
    }
    default:
      return undefined;
  }
}

/** Best-effort `t` field for a log line, when `parseServerMessage` gave up. */
function frameKind(text: string): string {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw === "object" && raw !== null) {
      const t = (raw as Record<string, unknown>).t;
      if (typeof t === "string") return t;
    }
  } catch {
    // fall through
  }
  return "unknown";
}

export function createRpcClient(deps: RpcClientDeps): RpcClient {
  const backoff = createBackoff(deps.random);

  let currentState: ClientState = "idle";
  let session: { endpoint: Endpoint; credential: Credential } | undefined;
  let socket: TransportSocket | undefined;
  let generation = 0;

  let capabilitySet = new Set<string>();
  // Ref-counted (ruling 16): two stores (e.g. Dashboard and Sessions) can
  // both subscribe to the same target; the wire `sub add`/`sub drop` is
  // sent only on the 0->1 / 1->0 transition, not on every call.
  const subscriptionMap = new Map<string, { target: SubTarget; count: number }>();
  // Task 5: the app's own foreground/background flag, set only by
  // `setAppActive` — orthogonal to the connection's own state and never
  // reset by a close/reconnect/disconnect, so a reconnect that lands while
  // the app is still backgrounded stays quiet (rule 3/behaviour test:
  // "ignore `suspended` in the welcome path").
  let suspended = false;
  const pushHandlers = new Map<
    string,
    Set<(payload: unknown, dropped: number | undefined) => void>
  >();
  const stateHandlers = new Set<
    (
      state: ClientState,
      detail: {
        closeCode?: number;
        lastFrameAt?: number;
        pinMismatch?: true;
        resumed?: true;
      },
    ) => void
  >();

  const queue: QueuedRequest[] = [];
  const inFlight = new Map<number, InFlightRequest>();
  let nextRequestId = 1;
  // Task 5: the request id of the one upload currently sending its paced
  // chunks on this socket, or undefined. Cleared the moment its promise
  // settles, one way or another.
  let activeUploadId: number | undefined;
  // Fix round 1 (I1): the laptop's own blobPhase (connection.ts) does not
  // necessarily return to "none" the instant an upload's *promise*
  // settles here — an early stop (this client's own cancel, an offline
  // drop mid-pacing, or the laptop's own `err` before every declared
  // chunk was sent) leaves the laptop still "receiving"/"discarding" that
  // blob for up to its own BLOB_IDLE_TIMEOUT_MS. A second `blob` header
  // sent while it is still in that phase gets the *whole socket* closed
  // (badFrame) by connection.ts's handleBlobHeader, not just refused —
  // this latch keeps `upload()` answering busy for that window instead,
  // for every channel alike (including a retry of the very upload that
  // triggered it).
  let blobDrain: { id: number; timer: unknown } | undefined;

  function clearBlobDrain(): void {
    if (blobDrain === undefined) return;
    deps.clock.clearTimeout(blobDrain.timer);
    blobDrain = undefined;
  }

  /** Starts (or restarts) the drain latch for `id`, timed from
   *  `lastActivityAt` — the last moment this client handed the laptop a
   *  byte for this blob (a chunk, or the header itself if no chunk ever
   *  went out) — so a cancel that lands long after the last chunk was
   *  sent doesn't reopen a fresh full window. */
  function startBlobDrain(id: number, lastActivityAt: number): void {
    // Fix round 2: never leave a stale drain timer running underneath a
    // fresh one — an orphaned old timer firing later would clear
    // `blobDrain` unconditionally, ending a *different*, still-active
    // drain early.
    clearBlobDrain();
    const elapsed = deps.clock.now() - lastActivityAt;
    const delay = Math.max(0, BLOB_IDLE_TIMEOUT_MS + BLOB_DRAIN_MARGIN_MS - elapsed);
    deps.log(`rpc: upload draining id=${id} delay=${delay}`);
    blobDrain = {
      id,
      timer: deps.clock.setTimeout(() => {
        deps.log(`rpc: upload drain window elapsed id=${id}`);
        blobDrain = undefined;
      }, delay),
    };
  }

  /** Shared tail for handleRes/handleErr settling an id that belonged to
   *  an upload: clears `activeUploadId` and, if that upload still had
   *  unsent chunks the moment it settled, starts the drain latch. */
  function settleUploadEntry(id: number, entry: InFlightRequest): void {
    if (activeUploadId === id) activeUploadId = undefined;
    if (entry.upload !== undefined && !entry.upload.allSent()) {
      startBlobDrain(id, entry.upload.lastActivityAt());
    }
  }

  let lastFrameAtValue: number | undefined;

  let handshakeTimer: unknown;
  let watchdogTimer: unknown;
  let resetBackoffTimer: unknown;
  let reconnectTimer: unknown;

  // Notification queue (final review T4 R2-1): a handler can itself cause a
  // newer transition (e.g. call disconnect() while being told
  // "authenticating"), which recursively calls setState again while the
  // first notification loop is still running. The old approach stopped
  // that inner loop's own delivery once `currentState` moved on, which
  // kept a *later* observer's last-seen state correct but could skip that
  // observer entirely for a state an *earlier* observer had already
  // reacted to — including "unpaired", which every observer must see once
  // to run its own cleanup. Instead, every `setState` call enqueues its
  // (state, detail) pair; one drain loop delivers each queued
  // notification, in order, to every handler — a re-entrant `setState`
  // just appends to the queue the already-running drain will reach next,
  // rather than starting a second, interleaved delivery.
  const pendingNotifications: {
    state: ClientState;
    detail: { closeCode?: number; lastFrameAt?: number; pinMismatch?: true; resumed?: true };
  }[] = [];
  let draining = false;

  function setState(
    next: ClientState,
    closeCode?: number,
    pinMismatch?: boolean,
    resumed?: boolean,
  ): void {
    currentState = next;
    deps.log(
      closeCode === undefined ? `rpc: state ${next}` : `rpc: state ${next} code=${closeCode}`,
    );
    const detail: {
      closeCode?: number;
      lastFrameAt?: number;
      pinMismatch?: true;
      resumed?: true;
    } = {};
    if (closeCode !== undefined) detail.closeCode = closeCode;
    if (lastFrameAtValue !== undefined) detail.lastFrameAt = lastFrameAtValue;
    if (pinMismatch) detail.pinMismatch = true;
    if (resumed) detail.resumed = true;
    pendingNotifications.push({ state: next, detail });
    if (draining) return; // the already-running drain loop will reach this
    draining = true;
    try {
      let item = pendingNotifications.shift();
      while (item !== undefined) {
        // Isolated like push handlers (rule 5): a throwing onState handler
        // must never wedge the state machine, and never stop the rest of
        // this notification (or a later one already queued) from being
        // delivered.
        for (const handler of [...stateHandlers]) {
          try {
            handler(item.state, item.detail);
          } catch {
            deps.log(`rpc: state handler threw state=${item.state}`);
          }
        }
        item = pendingNotifications.shift();
      }
    } finally {
      draining = false;
    }
  }

  function cancelHandshakeTimer(): void {
    if (handshakeTimer !== undefined) {
      deps.clock.clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
    }
  }
  function cancelWatchdogTimer(): void {
    if (watchdogTimer !== undefined) {
      deps.clock.clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  }
  function cancelResetBackoffTimer(): void {
    if (resetBackoffTimer !== undefined) {
      deps.clock.clearTimeout(resetBackoffTimer);
      resetBackoffTimer = undefined;
    }
  }
  function cancelReconnectTimer(): void {
    if (reconnectTimer !== undefined) {
      deps.clock.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  function armWatchdog(): void {
    cancelWatchdogTimer();
    watchdogTimer = deps.clock.setTimeout(() => {
      watchdogTimer = undefined;
      deps.log("rpc: watchdog timeout");
      selfClose(CLOSE.normal, "watchdog");
    }, DEAD_SOCKET_MS);
  }

  function rejectInFlight(): void {
    for (const [, entry] of inFlight) {
      deps.clock.clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: { kind: "offline" } });
    }
    inFlight.clear();
    // Task 5: every in-flight entry (including a mid-pacing upload) was
    // just resolved above — a scheduled chunk-send callback still pending
    // for that upload checks `inFlight.has(id)` and now finds it gone, so
    // it no-ops instead of sending onto a socket that is being torn down.
    activeUploadId = undefined;
    // Fix round 1 (I1): a closed socket is a fresh `Connection` object on
    // the laptop the moment (if ever) it reconnects — onSocketClosed
    // resets blobPhase to "none" itself, so any drain window left over
    // from a still-in-flight upload on the *old* socket is moot. "until
    // the socket closes" is this latch's own exit condition, not a
    // trigger.
    clearBlobDrain();
  }

  function rejectQueued(): void {
    const pending = queue.splice(0, queue.length);
    for (const item of pending) {
      item.resolve({ ok: false, error: { kind: "offline" } });
    }
  }

  function sendRequest(
    channel: string,
    args: unknown[],
    resolve: (result: RpcResult) => void,
    timeoutMs?: number,
  ): void {
    const id = nextRequestId++;
    const frame: ClientMessage = { t: "req", id, ch: channel, a: args };
    socket?.send(encodeMessage(frame));
    const timer = deps.clock.setTimeout(() => {
      inFlight.delete(id);
      resolve({ ok: false, error: { kind: "timeout" } });
    }, resolveTimeoutMs(timeoutMs));
    inFlight.set(id, { resolve, timer });
  }

  function flushQueue(): void {
    const pending = queue.splice(0, queue.length);
    for (const item of pending) {
      sendRequest(item.channel, item.args, item.resolve, item.timeoutMs);
    }
  }

  function openSocket(): void {
    if (session === undefined) return;
    generation += 1;
    const myGeneration = generation;
    setState("connecting");
    // A re-entrant onState handler (e.g. one that calls disconnect()) may
    // have already moved us on — disconnect() bumps `generation` itself, so
    // this is the "check state after notifying" rule: no socket is opened
    // for a `connect()` a handler already reversed.
    if (generation !== myGeneration) return;
    const { endpoint } = session;
    const url = socketUrl(endpoint.name ?? endpoint.host, endpoint.port, "/rpc");
    const trust: Trust =
      endpoint.name === undefined
        ? { kind: "pin", fingerprint: endpoint.fingerprint }
        : { kind: "system" };
    try {
      socket = deps.transport.open(url, trust, (event: TransportEvent) => {
        if (myGeneration !== generation) return; // a stale/superseded socket's late event
        handleTransportEvent(event);
      });
    } catch {
      // A synchronously-throwing transport.open (e.g. the native module is
      // missing) is treated exactly like a dead socket: route through the
      // same close-code table instead of leaving the state stuck at
      // "connecting".
      deps.log("rpc: transport open threw");
      handleClose(ABNORMAL_CLOSE);
    }
  }

  function scheduleReconnect(pinMismatch?: boolean): void {
    // Arm the timer before notifying: if a handler re-enters with
    // disconnect() during the "reconnecting" notification, disconnect()'s
    // own cancelReconnectTimer() correctly tears this one down, rather than
    // us silently overwriting a timer disconnect() already tried to clear.
    const delay = backoff.next();
    reconnectTimer = deps.clock.setTimeout(() => {
      reconnectTimer = undefined;
      openSocket();
    }, delay);
    setState("reconnecting", undefined, pinMismatch);
  }

  function handleTransportEvent(event: TransportEvent): void {
    switch (event.kind) {
      case "open":
        handleOpen();
        return;
      case "message":
        handleMessage(event.text);
        return;
      case "close":
        handleClose(event.code, event.reason);
        return;
      case "error":
        // Every transport error is always followed by its own `close`
        // event carrying the real code and reason (native-transport.ts and
        // both native modules emit error-then-close as one sequence for
        // every failure, including a pin mismatch's reason "fingerprint").
        // React to that close, not to this free-form message: handling
        // `error` here too would bump `generation` early and make the
        // very next event — the close that actually carries the reason —
        // look stale and get dropped.
        deps.log("rpc: transport error");
        return;
    }
  }

  function handleOpen(): void {
    if (session === undefined) return;
    // Send `hello` and arm both timers before notifying (N1): a handler
    // that reacts to "authenticating" by calling disconnect() must find a
    // real session and live timers to cancel, not a half-built one — and
    // since this is the last step, there is nothing left afterwards that a
    // re-entrant transition could run against.
    const hello: ClientMessage = {
      t: "hello",
      v: PROTOCOL_VERSION,
      deviceId: session.credential.deviceId,
      token: session.credential.token,
      client: deps.client,
    };
    socket?.send(encodeMessage(hello));
    armWatchdog();
    handshakeTimer = deps.clock.setTimeout(() => {
      handshakeTimer = undefined;
      deps.log("rpc: handshake timeout");
      selfClose(CLOSE.normal, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);
    setState("authenticating");
  }

  function selfClose(code: number, reason: string): void {
    socket?.close(code, reason);
    handleClose(code, reason);
  }

  function handleClose(code: number, reason?: string): void {
    generation += 1; // any later event from this socket is now stale
    cancelHandshakeTimer();
    cancelWatchdogTimer();
    cancelResetBackoffTimer();
    rejectInFlight();
    capabilitySet.clear(); // M1: nothing is "supported" without a live welcome
    socket = undefined;
    const pinMismatch = reason === "fingerprint";
    deps.log(`rpc: closed code=${code}${pinMismatch ? " reason=fingerprint" : ""}`);

    if (code === CLOSE.revoked || code === CLOSE.unauthorized) {
      // Ruling I5: unpaired is terminal — nothing queued under this
      // pairing may be sent later under a different one.
      rejectQueued();
      session = undefined; // M6: drop the revoked token from memory
      setState("unpaired", code, pinMismatch);
      return;
    }
    if (code === CLOSE.versionMismatch) {
      rejectQueued(); // ruling I5: incompatible is terminal too
      setState("incompatible", code, pinMismatch);
      return;
    }
    // Ruling I6: a pin mismatch (reason "fingerprint") must NOT auto-unpair
    // — an attacker on the LAN could force a re-pair that way. It stays on
    // the ordinary reconnect-with-backoff path; only the state detail
    // (pinMismatch) tells the UI why.
    //
    // N5 hand-off note for Task 6: `pinMismatch` is only set on *this*
    // "reconnecting" notification — the next "connecting" detail (and every
    // one after it, until the next mismatched close) does not repeat it. A
    // UI that wants to keep showing "certificate changed" while the client
    // keeps retrying must latch this flag itself rather than reading it off
    // the latest detail. A malformed/locally-invalid stored fingerprint
    // (native-transport.ts's own validation, before any native call)
    // surfaces through this same reason and flag — Task 6's copy should
    // read as "this device's saved certificate doesn't match", covering
    // both a real mismatch and a bad stored value.
    scheduleReconnect(pinMismatch);
  }

  function handleMessage(text: string): void {
    lastFrameAtValue = deps.clock.now();
    if (currentState === "authenticating" || currentState === "open") {
      armWatchdog();
    }
    const msg = parseServerMessage(text);
    if (msg === undefined) {
      // M2/N5: never log a server-supplied string verbatim — it could be
      // unbounded, split a UTF-16 surrogate pair under a raw `slice`, or
      // carry control/newline characters for log-line injection. Every
      // frame kind this protocol ever sends is lowercase ASCII, so
      // anything else (or too long to plausibly be a kind) logs as
      // "unknown" instead of being echoed back.
      const kind = frameKind(text);
      const safeKind = /^[a-z_]{1,32}$/.test(kind) ? kind : "unknown";
      deps.log(`rpc: malformed frame kind=${safeKind}`);
      if (currentState === "authenticating") {
        // Rule 1: before welcome, anything other than welcome (including a
        // frame that doesn't even parse) is a protocol violation.
        selfClose(CLOSE.normal, "protocol violation");
      }
      return;
    }

    if (currentState === "authenticating" && msg.t !== "welcome") {
      deps.log(`rpc: protocol violation before welcome kind=${msg.t}`);
      selfClose(CLOSE.normal, "protocol violation");
      return;
    }
    if (msg.t === "welcome" && currentState === "open") {
      // A repeated welcome is ignored: no re-subscribe, no capabilities
      // swap, no extra backoff-reset timer.
      deps.log("rpc: duplicate welcome ignored");
      return;
    }

    switch (msg.t) {
      case "welcome":
        handleWelcome(msg);
        return;
      case "res":
        handleRes(msg.id, msg.v);
        return;
      case "err":
        handleErr(msg.id, msg.code, msg.text, msg.language);
        return;
      case "psh":
        handlePush(msg.ch, msg.p, msg.dropped);
        return;
      case "ping":
        handlePing(msg.seq);
        return;
    }
  }

  /** Fix round 1 (Important 1): the capability filter `handleWelcome`'s own
   *  resubscribe and `setAppActive(true)`'s resume both need — a
   *  subscribed target whose channel the live `capabilitySet` no longer
   *  lists is dropped from the map and logged. Shared so the two call
   *  sites can never drift (Task 5 rule 4: "after the capability filter"). */
  function pruneUnsupportedSubscriptions(): void {
    for (const [key, entry] of [...subscriptionMap]) {
      if (!capabilitySet.has(targetChannel(entry.target))) {
        subscriptionMap.delete(key);
        deps.log(`rpc: unsupported subscription ch=${targetChannel(entry.target)}`);
      }
    }
  }

  /** Fix round 2: sends `targets` as one or more `sub` frames of the given
   *  op, chunked at MAX_SUB_TARGETS so a batch past the server's own
   *  per-frame cap is split rather than refused — shared by both `add` and
   *  `drop` so the two chunking paths can never drift apart. A no-op when
   *  `targets` is empty (every caller still guards on `.size > 0` itself
   *  so an empty resume/welcome/suspend logs nothing extra). */
  function sendSubFrames(op: "add" | "drop", targets: SubTarget[]): void {
    for (let i = 0; i < targets.length; i += MAX_SUB_TARGETS) {
      const chunk = targets.slice(i, i + MAX_SUB_TARGETS);
      const frame: ClientMessage =
        op === "add" ? { t: "sub", add: chunk } : { t: "sub", drop: chunk };
      socket?.send(encodeMessage(frame));
    }
  }

  /** Fix round 1 (Important 1): sends every currently-subscribed target as
   *  one or more `sub add` frames (via `sendSubFrames`). Shared by
   *  `handleWelcome`'s own resubscribe and `setAppActive(true)`'s resume. */
  function sendSubAddAll(): void {
    sendSubFrames(
      "add",
      [...subscriptionMap.values()].map((entry) => entry.target),
    );
  }

  function handleWelcome(msg: { v: number; capabilities: string[] }): void {
    cancelHandshakeTimer();

    if (msg.v !== PROTOCOL_VERSION) {
      // The client's own half of rule 1's version check: a welcome we
      // cannot speak is routed the same way as a server-sent 4426 —
      // incompatible, no reconnect — except there is no server close code
      // to report, so the client closes locally first.
      generation += 1;
      cancelWatchdogTimer();
      cancelResetBackoffTimer();
      rejectInFlight();
      rejectQueued(); // ruling I5: incompatible is terminal
      capabilitySet.clear();
      socket?.close(CLOSE.normal, "version mismatch");
      socket = undefined;
      deps.log(`rpc: incompatible protocol version v=${msg.v}`);
      setState("incompatible", CLOSE.versionMismatch);
      return;
    }

    capabilitySet = new Set(msg.capabilities);

    // Everything the transition to "open" promises — the backoff-reset
    // timer, re-subscribing, flushing the queue — happens before the
    // notification below, so a throwing (or re-entrant, e.g.
    // disconnect()-calling) onState handler can never suppress it.
    resetBackoffTimer = deps.clock.setTimeout(() => {
      resetBackoffTimer = undefined;
      backoff.reset();
    }, BACKOFF_RESET_AFTER_OPEN_MS);

    // Task 5, rule 3: the capability filter always runs (unsupported
    // targets are dropped and logged the same whether the app is
    // suspended or not), but a suspended app sends no `sub add` here — the
    // map still holds every remaining target for `setAppActive(true)` to
    // send later.
    pruneUnsupportedSubscriptions();
    if (!suspended && subscriptionMap.size > 0) {
      sendSubAddAll();
    }

    flushQueue();

    setState("open");
  }

  function handleRes(id: number, value: unknown): void {
    const entry = inFlight.get(id);
    if (entry === undefined) {
      // Fix round 1 (I1): a late reply for an id this client already
      // settled locally (its own cancel/timeout) — if it's the id
      // currently being drained, the laptop just told us its blobPhase is
      // done, so there's no need to wait out the rest of the margin.
      if (blobDrain?.id === id) clearBlobDrain();
      deps.log(`rpc: stray reply id=${id}`);
      return;
    }
    inFlight.delete(id);
    deps.clock.clearTimeout(entry.timer);
    settleUploadEntry(id, entry);
    entry.resolve({ ok: true, value });
  }

  function handleErr(id: number, code: RemoteErrorCode, text: string, language: Language): void {
    const entry = inFlight.get(id);
    if (entry === undefined) {
      if (blobDrain?.id === id) clearBlobDrain();
      deps.log(`rpc: stray reply id=${id}`);
      return;
    }
    inFlight.delete(id);
    deps.clock.clearTimeout(entry.timer);
    settleUploadEntry(id, entry);
    entry.resolve({ ok: false, error: { kind: "remote", code, text, language } });
  }

  function handlePush(channel: string, payload: unknown, dropped: number | undefined): void {
    const handlers = pushHandlers.get(channel);
    if (handlers === undefined) return;
    for (const handler of handlers) {
      try {
        handler(payload, dropped);
      } catch {
        deps.log(`rpc: push handler threw ch=${channel}`);
      }
    }
  }

  function handlePing(seq: number): void {
    const frame: ClientMessage = { t: "pong", seq };
    socket?.send(encodeMessage(frame));
  }

  function connect(endpoint: Endpoint, credential: Credential): void {
    if (currentState !== "idle" && currentState !== "closed" && currentState !== "unpaired") {
      deps.log(`rpc: connect ignored in state ${currentState}`);
      return;
    }
    session = { endpoint, credential };
    openSocket();
  }

  function disconnect(): void {
    generation += 1;
    cancelHandshakeTimer();
    cancelWatchdogTimer();
    cancelResetBackoffTimer();
    cancelReconnectTimer();

    if (socket !== undefined) {
      // M4: `bye` is only meaningful once the server has (or is about to
      // have) a session for us — never on a socket that hasn't finished
      // opening yet.
      if (currentState === "authenticating" || currentState === "open") {
        const bye: ClientMessage = { t: "bye" };
        socket.send(encodeMessage(bye));
      }
      socket.close(CLOSE.normal, "bye");
      socket = undefined;
    }

    rejectInFlight();
    rejectQueued();
    subscriptionMap.clear();
    capabilitySet.clear(); // M1
    session = undefined; // M6: drop the token from memory once disconnected
    setState("closed");
  }

  function call(channel: string, args: unknown[], options?: CallOptions): Promise<RpcResult> {
    return new Promise((resolve) => {
      if (currentState === "open") {
        sendRequest(channel, args, resolve, options?.timeoutMs);
        return;
      }
      // Task 3 / ruling 6: a non-queued call (raw input) must never sit
      // waiting for a future connect — it is offline now, or never sent.
      if (options?.whenNotOpen === "reject") {
        resolve({ ok: false, error: { kind: "offline" } });
        return;
      }
      // N3 / ruling I5: unpaired and incompatible are terminal — a call
      // made while already there must not sit in the queue waiting for a
      // `connect()` that either never comes (incompatible) or would send it
      // under a different pairing (unpaired, after a re-pair).
      if (currentState === "unpaired" || currentState === "incompatible") {
        resolve({ ok: false, error: { kind: "offline" } });
        return;
      }
      if (queue.length >= QUEUE_CAP) {
        resolve({ ok: false, error: { kind: "offline" } });
        return;
      }
      queue.push({ channel, args, resolve, timeoutMs: options?.timeoutMs });
    });
  }

  function upload(
    channel: string,
    args: unknown[],
    base64: string,
    options?: UploadOptions,
  ): Promise<RpcResult> {
    return new Promise((resolve) => {
      // Rule 1: checked before anything else, regardless of connection
      // state — an oversized or malformed payload is never sent, offline
      // or not.
      const bytes = base64ByteLength(base64);
      if (bytes === undefined || bytes > MAX_BLOB_BYTES) {
        resolve({ ok: false, error: { kind: "unsupported" } });
        return;
      }
      // Task 5: this socket carries one blob at a time (the wire protocol
      // has no id-multiplexed binary framing — see connection.ts's own
      // `blobPhase`). A second upload while one is already sending its
      // paced chunks — or while the laptop may still be draining an
      // earlier one that stopped early (fix round 1, I1) — is refused
      // locally, before it ever reaches the socket, rather than let a
      // second `blob` header race the laptop's still-non-"none" blobPhase
      // (connection.ts's handleBlobHeader closes the *whole socket* for
      // that, not just the blob). Applies to every channel alike,
      // including the voice upload lane — one active/draining upload per
      // socket, not per channel.
      if (activeUploadId !== undefined || blobDrain !== undefined) {
        resolve({ ok: false, error: { kind: "busy" } });
        return;
      }
      // M8 global constraint / ruling 12: an upload is never queued, in
      // every state including "connecting" — it either sends now, on a
      // live open socket, or is offline. A recording that missed its
      // window waits for an explicit Retry, which mints a fresh call.
      if (currentState !== "open") {
        resolve({ ok: false, error: { kind: "offline" } });
        return;
      }

      // `bytes` is already bounded by MAX_BLOB_BYTES above, so
      // `parts.length` here is at most `ceil(MAX_BLOB_BYTES /
      // UPLOAD_CHUNK_BYTES) = 101` — under @jarvis/wire's MAX_BLOB_CHUNKS
      // (128) with room to spare. Relied on, not asserted: a future
      // increase to MAX_BLOB_BYTES (or decrease to UPLOAD_CHUNK_BYTES)
      // without a matching MAX_BLOB_CHUNKS bump would silently push an
      // otherwise-valid upload over the laptop's chunk-count cap and get
      // it closed 4400 mid-transfer instead of rejected upfront as
      // `unsupported`.
      const parts = splitBase64(base64, UPLOAD_CHUNK_BYTES);
      const id = nextRequestId++;
      // Fix round 1 (I1): `allSent`/`lastActivityAt` track this upload's
      // own drain-relevance — read by settleUploadEntry (handleRes/
      // handleErr's shared path) via the closures on the inFlight entry
      // below, and by this function's own `finalize` directly.
      let allSent = false;
      let lastActivityAt = deps.clock.now();
      // Fix round 2: whether the `blob` header itself ever reached the
      // transport. A throw from `socket.send()` below means the laptop
      // never even started this blob's phase — draining would refuse the
      // next upload for nothing the laptop is actually doing.
      let headerSent = false;
      const timer = deps.clock.setTimeout(() => {
        finalize({ ok: false, error: { kind: "timeout" } });
      }, resolveTimeoutMs(options?.timeoutMs));
      inFlight.set(id, {
        resolve,
        timer,
        upload: { lastActivityAt: () => lastActivityAt, allSent: () => allSent },
      });
      activeUploadId = id;

      // Task 5: every exit from this upload past this point — success,
      // timeout, a thrown send, an explicit cancel — goes through this one
      // helper, so `activeUploadId`/`inFlight` are never cleared in one
      // path and left stale in another. handleRes/handleErr (shared with
      // ordinary call() replies) clear `activeUploadId` themselves for the
      // "server answered" exits; this helper covers every exit local to
      // this function. Fix round 1 (I1): any exit here while chunks
      // remained unsent starts the drain latch — the laptop's blobPhase
      // for this id is not "none" yet just because this promise settled.
      function finalize(result: RpcResult): void {
        inFlight.delete(id);
        deps.clock.clearTimeout(timer);
        if (activeUploadId === id) {
          activeUploadId = undefined;
          // Fix round 2: only arm the latch once the header actually
          // reached the transport — a header-send throw never started
          // anything on the laptop's side for this id to drain.
          // Fix round 2: only arm the latch once the header actually
          // reached the transport — a header-send throw never started
          // anything on the laptop's side for this id to drain.
          if (headerSent && !allSent) startBlobDrain(id, lastActivityAt);
        }
        resolve(result);
      }

      try {
        const header: ClientMessage = {
          t: "blob",
          id,
          ch: channel,
          a: args,
          bytes,
          chunks: parts.length,
        };
        socket?.send(encodeMessage(header));
        headerSent = true;
      } catch {
        // A throw from send (behaviour rule 4): never partially "in
        // flight" — clear the entry so a later, unrelated `res` for this
        // id is ignored (handleRes's stray-reply path) rather than
        // resolving a promise that already settled.
        deps.log("rpc: upload send threw");
        finalize({ ok: false, error: { kind: "offline" } });
        return;
      }

      deps.log(`rpc: upload ch=${channel} id=${id} bytes=${bytes} chunks=${parts.length}`);

      // Task 5 pacing: one chunk per scheduled turn, never a tight
      // synchronous loop — a 25 MiB upload no longer blocks this thread
      // for every chunk at once, and every turn re-checks the id is still
      // in flight (stop on close/timeout) and the caller's own cancelled()
      // predicate (stop on cancel) before sending the next chunk. A
      // regular call()/sub frame is a text frame and is dispatched by the
      // server independently of an in-progress blob's binary frames
      // (connection.ts's onText/onBinary split by WebSocket opcode, not by
      // byte position), so pacing this loop never risks corrupting another
      // request's framing — only a second *blob* header is refused, by the
      // busy check above.
      let sent = 0;
      const sendNext = (index: number): void => {
        if (!inFlight.has(id)) return; // resolved elsewhere: close/timeout/finalize
        if (index >= parts.length) {
          // Fix round 1 (I1): checked *before* cancelled() below — once
          // every declared chunk has already been handed to the
          // transport, there is nothing left for a cancel to stop. Fix
          // round 2: `allSent` is no longer set here — it is now set the
          // moment the *last* chunk is actually handed to sendBinary
          // (below), not a whole scheduled turn later, so a fast res/err
          // (or a timeout) landing in that gap doesn't see a stale
          // `allSent === false` and arm the drain latch for nothing.
          return; // awaiting res/err
        }
        if (options?.cancelled?.() === true) {
          finalize({ ok: false, error: { kind: "cancelled" } });
          return;
        }
        const part = parts[index] as string;
        try {
          socket?.sendBinary(part);
        } catch {
          deps.log("rpc: upload chunk send threw");
          finalize({ ok: false, error: { kind: "offline" } });
          return;
        }
        sent += base64ByteLength(part) ?? 0;
        lastActivityAt = deps.clock.now();
        // Fix round 2: flipped here, at the moment the last declared
        // chunk is actually hitting the transport — not a whole scheduled
        // turn later (the old trailing-turn check above).
        // Fix round 2: flipped here, at the moment the last declared
        // chunk is actually hitting the transport — not a whole scheduled
        // turn later (the old trailing-turn check above).
        if (index === parts.length - 1) allSent = true;
        options?.onProgress?.(sent, bytes);
        deps.clock.setTimeout(() => sendNext(index + 1), 0);
      };
      deps.clock.setTimeout(() => sendNext(0), 0);
    });
  }

  function subscribe(target: SubTarget): RpcResult<void> {
    const key = subKey(target);
    const existing = subscriptionMap.get(key);
    if (existing !== undefined) {
      // Ref-counted (ruling 16 / Task 3 rule 3): a duplicate subscribe
      // increments the count but sends no second frame — the 0->1
      // transition already happened.
      existing.count += 1;
      deps.log(`rpc: subscribe ch=${targetChannel(target)} ref=${existing.count}`);
      return { ok: true, value: undefined };
    }
    // The unsupported check applies only on the 0->1 transition: a refused
    // subscribe never creates an entry, so its count stays 0.
    if (currentState === "open" && !capabilitySet.has(targetChannel(target))) {
      return { ok: false, error: { kind: "unsupported" } };
    }
    subscriptionMap.set(key, { target, count: 1 });
    deps.log(`rpc: subscribe ch=${targetChannel(target)} ref=1`);
    // Task 5, rule 3: the map/ref-count bookkeeping above is unconditional
    // — only the frame is skipped while suspended, so the target is ready
    // for `setAppActive(true)`'s own `sub add` without this call ever
    // touching the socket.
    if (currentState === "open" && !suspended) {
      const frame: ClientMessage = { t: "sub", add: [target] };
      socket?.send(encodeMessage(frame));
    }
    return { ok: true, value: undefined };
  }

  function unsubscribe(target: SubTarget): void {
    const key = subKey(target);
    const existing = subscriptionMap.get(key);
    if (existing === undefined) return; // never-subscribed / already at 0: a no-op
    existing.count -= 1;
    if (existing.count > 0) {
      deps.log(`rpc: unsubscribe ch=${targetChannel(target)} ref=${existing.count}`);
      return;
    }
    subscriptionMap.delete(key);
    deps.log(`rpc: unsubscribe ch=${targetChannel(target)} ref=0`);
    // Task 5, rule 3: same as subscribe() above — while suspended, the
    // target is simply gone from the map already, so there is nothing for
    // the next `sub add` (on resume) to carry, without a `sub drop` ever
    // reaching the wire for it.
    if (currentState === "open" && !suspended) {
      const frame: ClientMessage = { t: "sub", drop: [target] };
      socket?.send(encodeMessage(frame));
    }
  }

  function onPush(
    channel: string,
    handler: (payload: unknown, dropped: number | undefined) => void,
  ): () => void {
    let handlers = pushHandlers.get(channel);
    if (handlers === undefined) {
      handlers = new Set();
      pushHandlers.set(channel, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  /** Task 5 (M10 ruling d). See the `RpcClient.setAppActive` doc comment
   *  above for the behaviour contract; this is its one implementation. */
  function setAppActive(active: boolean): void {
    if (active) {
      if (!suspended) return; // rule 4: idempotent — nothing to resume
      suspended = false;
      if (currentState !== "open") return; // rule 4: "if not open: nothing more"
      // Same capability filter handleWelcome runs on its own resubscribe
      // (rule 4: "after the capability filter") — a target that stopped
      // being supported while this device was suspended is dropped and
      // logged here too, not silently re-added.
      pruneUnsupportedSubscriptions();
      if (subscriptionMap.size > 0) {
        sendSubAddAll();
      }
      deps.log(`rpc: resume subs n=${subscriptionMap.size}`);
      // rule 4: delivered through the same ordered notification queue
      // every other state change uses (setState), so a re-entrant handler
      // can never see it out of order relative to another notification.
      setState("open", undefined, undefined, true);
      return;
    }
    if (suspended) return; // rule 2: idempotent
    suspended = true;
    if (currentState === "open" && subscriptionMap.size > 0) {
      // Fix round 2: chunked the same way `sendSubAddAll` chunks the
      // resume/welcome add, via the shared `sendSubFrames` — a watching
      // set past MAX_SUB_TARGETS is split into multiple `sub drop` frames
      // instead of being refused by the server as an oversized `sub`.
      sendSubFrames(
        "drop",
        [...subscriptionMap.values()].map((entry) => entry.target),
      );
      deps.log(`rpc: suspend subs n=${subscriptionMap.size}`);
    }
  }

  function onState(
    handler: (
      state: ClientState,
      detail: { closeCode?: number; lastFrameAt?: number; pinMismatch?: true; resumed?: true },
    ) => void,
  ): () => void {
    stateHandlers.add(handler);
    return () => {
      stateHandlers.delete(handler);
    };
  }

  return {
    connect,
    disconnect,
    call,
    upload,
    subscribe,
    unsubscribe,
    onPush,
    onState,
    state: () => currentState,
    capabilities: () => [...capabilitySet],
    subscriptions: () => [...subscriptionMap.values()].map((entry) => entry.target),
    lastFrameAt: () => lastFrameAtValue,
    setAppActive,
  };
}
