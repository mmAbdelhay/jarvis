// One authenticated `/rpc` socket's whole lifecycle: silence until a valid
// `hello` authenticates it, `welcome` and a heartbeat once open, then
// `req`/`sub`/`pong`/`blob`/`bye` for as long as it stays open. Nothing is
// ever written before a successful `hello` (spec, "no banner before auth"):
// the only sends before `welcome` are the handshake's own refusal closes,
// which carry no payload at all.
//
// `state` is a discriminated union rather than separate `phase`/`device`
// variables: the authenticated device only *exists* in the "open" (and,
// once self-closed, "closed") variants, so the one check that gates every
// post-handshake frame (`state.phase !== "open"`) is also the only place
// that ever narrows `state.device` to a real `AuthenticatedDevice` — no
// second, redundant "is it actually defined" check stands behind it that
// could quietly swallow its removal.
//
// M5: every `res`/`err` reply and every push now flows through this
// connection's own `Outbox` (outbox.ts) rather than being written or
// dropped here directly — the outbox owns queueing, coalescing, the
// congestion thresholds and the per-`(channel,key)` stream cap. `welcome`
// and `ping` stay direct sends (never queued behind a stalled outbox: a
// client always sees them, or the socket is already gone). Subscriptions
// are keyed or bare: a bare channel name only ever subscribes an unkeyed
// policy (`isKeyedPolicy` gates it here, inside @jarvis/remote itself, not
// left to a desktop-side allowlist), and a `{ch,key}` target additionally
// needs `authorizeKey` to accept it and a free slot under
// `MAX_KEYED_SUBSCRIPTIONS`.

import type { AuditEvent, AuditLog } from "./audit.js";
import { describeError } from "./io.js";
import type { Clock, SocketLike, Timers } from "./io.js";
import { createRateLimiter, type RateLimiter } from "./limits.js";
import { createOutbox, type Outbox } from "./outbox.js";
import { isKeyedPolicy, MAX_KEYED_SUBSCRIPTIONS } from "./policy.js";
import type { ChannelPolicies } from "./policy.js";
import type { ClientMessage, RemoteErrorCode, ServerMessage, SubTarget } from "./protocol.js";
import {
  BLOB_IDLE_TIMEOUT_MS,
  CLOSE,
  encodeMessage,
  HANDSHAKE_TIMEOUT_MS,
  isValidBlobShape,
  MAX_BLOB_CHUNK_BYTES,
  MAX_MISSED_PONGS,
  parseClientMessage,
  PING_INTERVAL_MS,
  PROTOCOL_VERSION,
} from "./protocol.js";

/**
 * Ruling 11 (Task 6): once `onCongested` closes a connection (4413), the
 * client is expected to complete the WebSocket close handshake on its own.
 * A congested phone is, by definition, the one client least likely to ever
 * do that promptly — this is how long the server waits for the real
 * `close` event before giving up and calling `socket.terminate()` itself,
 * so a connection that caused congestion can never be left half-closed,
 * still holding its slot under the 8-open-client cap, indefinitely.
 */
export const CONGESTION_TERMINATE_MS = 2_000;

/**
 * M12 Task 3: how often a channel's `remote-call` outcome gets an audit
 * line — the desktop's own classifier (`auditPolicyFor`, remote-policy.ts)
 * decides this per channel; this file only ever asks `deps.auditPolicy`,
 * never names a channel itself.
 */
export type AuditPolicy = "always" | "first-per-key" | "never";

/** Rule 3: a hostile paired phone spamming unknown/forbidden channels gets
 *  at most this many `remote-call` audit lines per connection before one
 *  final "not audited" log line and silence for the rest of its life. */
export const AUDIT_PROBE_LINES_PER_CONNECTION = 20;

/** Rule 4: the only argument value a `remote-call` line may ever carry — an
 *  `input`-policy channel's own bounded id (a session id, a pane key), never
 *  a command, a path or a body. */
export const AUDIT_KEY_MAX_CHARS = 64;

/**
 * Fix round 1 (review I1): the `first-per-key` dedupe set's own per-connection
 * cap — every distinct `(channel, key)` pair a device manages to produce is
 * one entry, and an authenticated device otherwise controls how many of
 * those it can mint (a fresh session id, say) just as freely as it controls
 * how many refused probes it sends. Past this many entries, one log line and
 * nothing further recorded for `first-per-key` on this connection, mirroring
 * `AUDIT_PROBE_LINES_PER_CONNECTION`'s own cap-then-silence shape.
 */
export const AUDIT_INPUT_KEYS_PER_CONNECTION = 256;

export type AuthenticatedDevice = { id: string; name: string };

/** Called with `{id, name}` only, never the full stored device record (same rule as `handle`). */
export type AuthorizeKey = (channel: string, key: string, device: AuthenticatedDevice) => boolean;

export type RequestOutcome =
  | { kind: "value"; value: unknown }
  | { kind: "unknown-channel" }
  | { kind: "forbidden" };

/**
 * `blob` is `undefined` for every `req` (M8 rule 8) — only a completed
 * blob upload ever hands a handler bytes, never a JSON-carried request.
 */
export type RequestHandler = (
  channel: string,
  args: unknown[],
  device: AuthenticatedDevice,
  blob?: Uint8Array,
) => Promise<RequestOutcome>;

export type ErrorText = (code: RemoteErrorCode) => { text: string; language: "ar" | "en" };

export type AuthFailure = "bad-frame" | "bad-credentials" | "timeout";

export type ConnectionDeps = {
  source: string;
  now: Clock;
  timers: Timers;
  authenticate(deviceId: string, token: string): AuthenticatedDevice | undefined;
  handle: RequestHandler;
  policies: ChannelPolicies;
  authorizeKey: AuthorizeKey;
  /** The byte ceiling a blob header's declared `bytes` must not exceed for
   *  `channel` — `undefined` for a channel that accepts no blob at all
   *  (M8 rule 3.4: answered `err unknown-channel`, a throw treated the
   *  same and logged). */
  blobLimit(channel: string): number | undefined;
  errorText: ErrorText;
  log(line: string): void;
  onOpen(c: Connection): void;
  onAuthFailed(reason: AuthFailure): void;
  onClosed(c: Connection, code: number): void;
  /** M12 Task 3: the hub's own audit sink, passed straight through from
   *  `HubDeps.audit` — the same object `hub.ts` already records
   *  connect/disconnect/auth-failed lines to. */
  audit: Pick<AuditLog, "record">;
  /** M12 Task 3: the desktop's own classifier for `channel` — this file
   *  never names a channel, it only asks. */
  auditPolicy(channel: string): AuditPolicy;
};

export type Connection = {
  readonly device: AuthenticatedDevice | undefined;
  onText(text: string): void;
  onBinary(data: Uint8Array): void;
  onSocketClosed(code: number): void;
  push(channel: string, payload: unknown, key: string | undefined): void;
  /** With no `key`, the unkeyed subscription set only — a keyed target is
   *  never reported by the one-argument form. With a `key` (M10), the keyed
   *  set instead: `subscribes(ch, key)` answers whether this connection
   *  holds that exact `{ch,key}` target. */
  subscribes(channel: string, key?: string): boolean;
  close(code: number, reason: string): void;
};

type ReqMessage = Extract<ClientMessage, { t: "req" }>;
type SubMessage = Extract<ClientMessage, { t: "sub" }>;
type BlobMessage = Extract<ClientMessage, { t: "blob" }>;

type ConnState =
  | { phase: "awaiting-hello" }
  | { phase: "open"; device: AuthenticatedDevice }
  | { phase: "closed"; device: AuthenticatedDevice | undefined };

/**
 * One open connection's in-flight upload, separate from `ConnState` (M8
 * rule 2) so a blob's own lifecycle never has to be threaded through the
 * auth/open/closed state machine above. `receiving` is the only variant
 * that ever accumulates bytes; `discarding` tracks just enough shape to
 * stay in sync with the declared frame count for a refused blob, and
 * carries no channel/args — nothing about a refused upload is ever logged
 * again past its one refusal line.
 */
type BlobPhase =
  | { kind: "none" }
  | {
      kind: "receiving";
      id: number;
      ch: string;
      a: unknown[];
      declared: number;
      chunks: number;
      received: number;
      chunksLeft: number;
      parts: Uint8Array[];
    }
  | { kind: "discarding"; id: number; declared: number; received: number; chunksLeft: number };

/** Joins `parts` (each already validated to sum to exactly `length`) into one fresh `Uint8Array`. */
function concatParts(parts: Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** The composite key a keyed subscription is stored under: never a valid channel or key on its own, so it can never collide with a bare channel name in the same set. */
function keyedTargetId(channel: string, key: string): string {
  return `${channel}\u{0}${key}`;
}

export function createConnection(socket: SocketLike, deps: ConnectionDeps): Connection {
  let state: ConnState = { phase: "awaiting-hello" };
  const subscribed = new Set<string>();
  const keyedSubscribed = new Set<string>();
  const limiter: RateLimiter = createRateLimiter(deps.now);
  let outbox: Outbox | undefined;

  let missedPongs = 0;
  let pingSeq = 0;

  let handshakeTimer: unknown = deps.timers.setTimeout(() => {
    refuseAuth("timeout", CLOSE.handshakeTimeout);
  }, HANDSHAKE_TIMEOUT_MS);
  let heartbeatTimer: unknown;
  let congestionTerminateTimer: unknown;

  let blobPhase: BlobPhase = { kind: "none" };
  let blobIdleTimer: unknown;

  let closedHandled = false;

  // M12 Task 3 (rule 3): `first-per-key`'s own per-connection dedupe set —
  // `${channel}\u0000${key}` for every (channel, key) pair already
  // recorded, plus one `${channel}\u0000` sentinel per channel for calls
  // with no derivable key (fix round 1, review I1) — cleared on close.
  // `probeAuditCount`/`probeAuditCapLogged` are this connection's own
  // refused-probe cap; `auditedInputKeysCapLogged` is the matching cap for
  // this set (`AUDIT_INPUT_KEYS_PER_CONNECTION`). A fresh connection (a new
  // `createConnection` call, e.g. after a reconnect) always starts all of
  // these at zero/false again, never carried over.
  const auditedInputKeys = new Set<string>();
  let probeAuditCount = 0;
  let probeAuditCapLogged = false;
  let auditedInputKeysCapLogged = false;

  /** Rule 4: the first element of `args` when it is a string of 1-64
   *  characters — never any other argument, never the whole array. */
  function auditKeyFrom(args: unknown[]): string | undefined {
    const first = args[0];
    return typeof first === "string" && first.length >= 1 && first.length <= AUDIT_KEY_MAX_CHARS
      ? first
      : undefined;
  }

  /**
   * Rule 3's `first-per-key` dedupe: a real key dedupes per `(channel,
   * key)`; a call whose `args[0]` yields no key (fix round 1, review I1 —
   * not a 1-64 character string) dedupes under one `${channel}` sentinel
   * instead, so a channel with no derivable key ever gets at most one line
   * per connection, never one per call. The set itself is capped at
   * `AUDIT_INPUT_KEYS_PER_CONNECTION` — past that, one log line and nothing
   * further recorded for `first-per-key` on this connection.
   */
  function isNewAuditedKey(
    device: AuthenticatedDevice,
    channel: string,
    key: string | undefined,
  ): boolean {
    const id = key === undefined ? `${channel}\u{0}` : `${channel}\u{0}${key}`;
    if (auditedInputKeys.has(id)) return false;
    if (auditedInputKeysCapLogged) return false;
    if (auditedInputKeys.size >= AUDIT_INPUT_KEYS_PER_CONNECTION) {
      auditedInputKeysCapLogged = true;
      deps.log(`connection: further first-per-key audits from device=${device.id} not recorded`);
      return false;
    }
    auditedInputKeys.add(id);
    return true;
  }

  function safeAuditRecord(event: AuditEvent): void {
    try {
      deps.audit.record(event);
    } catch (error) {
      deps.log(`connection: audit record threw: ${describeError(error)}`);
    }
  }

  /** Rule 3's refused-probe half: capped at `AUDIT_PROBE_LINES_PER_CONNECTION`, one final log line at the cap, silence after. */
  function recordRefusedAudit(
    device: AuthenticatedDevice,
    channel: string,
    outcome: "forbidden" | "unknown-channel",
  ): void {
    if (probeAuditCapLogged) return;
    if (probeAuditCount >= AUDIT_PROBE_LINES_PER_CONNECTION) {
      probeAuditCapLogged = true;
      deps.log(`connection: further refused calls from device=${device.id} not audited`);
      return;
    }
    probeAuditCount += 1;
    safeAuditRecord({ kind: "remote-call", deviceId: device.id, channel, outcome });
  }

  /**
   * Rule 3, called once `deps.handle` has settled (or thrown) for an
   * authenticated `req`/blob — never before, and never in a way that can
   * change the `res`/`err` already on its way to the phone (rule 5:
   * `safeAuditRecord` never throws past this).
   */
  function recordRemoteCallAudit(
    device: AuthenticatedDevice,
    channel: string,
    args: unknown[],
    outcome: "ok" | "error" | "forbidden" | "unknown-channel",
  ): void {
    if (outcome === "forbidden" || outcome === "unknown-channel") {
      recordRefusedAudit(device, channel, outcome);
      return;
    }
    let policy: AuditPolicy;
    try {
      policy = deps.auditPolicy(channel);
    } catch (error) {
      deps.log(`connection: auditPolicy(${channel}) threw: ${describeError(error)}`);
      return;
    }
    if (policy === "never") return;
    if (policy === "always") {
      safeAuditRecord({ kind: "remote-call", deviceId: device.id, channel, outcome });
      return;
    }
    const key = auditKeyFrom(args);
    if (!isNewAuditedKey(device, channel, key)) return;
    safeAuditRecord({
      kind: "remote-call",
      deviceId: device.id,
      channel,
      outcome,
      ...(key !== undefined ? { key } : {}),
    });
  }

  /** `{kind:"value"}` -> "ok"; the outcome's own kind otherwise. */
  function auditOutcomeOf(outcome: RequestOutcome): "ok" | "forbidden" | "unknown-channel" {
    return outcome.kind === "value" ? "ok" : outcome.kind;
  }

  function clearHandshakeTimer(): void {
    if (handshakeTimer === undefined) return;
    deps.timers.clearTimeout(handshakeTimer);
    handshakeTimer = undefined;
  }

  function clearHeartbeatTimer(): void {
    if (heartbeatTimer === undefined) return;
    deps.timers.clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  /** Ruling 11: cleared on every path that closes this connection (`close`, `onSocketClosed`) so a terminate that already happened, or a socket that closed cleanly on its own, never gets a redundant/stray `terminate()` behind it. */
  function clearCongestionTerminateTimer(): void {
    if (congestionTerminateTimer === undefined) return;
    deps.timers.clearTimeout(congestionTerminateTimer);
    congestionTerminateTimer = undefined;
  }

  /** Ruling 11: armed only from the outbox's `onCongested` callback, right after `close(CLOSE.congested, "")` has already asked the client to close politely. */
  function armCongestionTerminateTimer(): void {
    clearCongestionTerminateTimer();
    congestionTerminateTimer = deps.timers.setTimeout(() => {
      congestionTerminateTimer = undefined;
      socket.terminate();
    }, CONGESTION_TERMINATE_MS);
  }

  function clearBlobIdleTimer(): void {
    if (blobIdleTimer === undefined) return;
    deps.timers.clearTimeout(blobIdleTimer);
    blobIdleTimer = undefined;
  }

  /** Rule 3's "arm the idle timer in every non-closing branch" and rule 4's re-arm on every binary frame — always a fresh 30s window, never additive. */
  function armBlobIdleTimer(): void {
    clearBlobIdleTimer();
    blobIdleTimer = deps.timers.setTimeout(fireBlobIdleTimeout, BLOB_IDLE_TIMEOUT_MS);
  }

  /** Rule 11: never frame contents — only the channel, the declared shape and an outcome word. */
  function logBlob(ch: string, bytes: number, chunks: number, outcome: string): void {
    deps.log(`connection: blob ch=${ch} bytes=${bytes} chunks=${chunks} ${outcome}`);
  }

  /** Rule 5: idle abandons a receiving blob with `err bad-request`; a discarding one is dropped silently — it already sent its one refusal frame. */
  function fireBlobIdleTimeout(): void {
    blobIdleTimer = undefined;
    if (blobPhase.kind === "receiving") {
      const { id, ch, declared, chunks } = blobPhase;
      sendErr(id, "bad-request");
      logBlob(ch, declared, chunks, "aborted:idle");
    }
    blobPhase = { kind: "none" };
  }

  function armHeartbeat(): void {
    heartbeatTimer = deps.timers.setTimeout(fireHeartbeat, PING_INTERVAL_MS);
  }

  function fireHeartbeat(): void {
    if (state.phase !== "open") return;
    if (missedPongs >= MAX_MISSED_PONGS) {
      socket.terminate();
      return;
    }
    missedPongs += 1;
    pingSeq += 1;
    send({ t: "ping", seq: pingSeq });
    armHeartbeat();
  }

  /** Every direct socket write (welcome/ping only — everything else goes through the outbox), wrapped and logged (rule 9). */
  function sendRaw(text: string): void {
    try {
      socket.send(text);
    } catch (error) {
      deps.log(`connection: send failed: ${describeError(error)}`);
    }
  }

  function send(message: ServerMessage): void {
    let text: string;
    try {
      text = encodeMessage(message);
    } catch (error) {
      deps.log(`connection: encode failed: ${describeError(error)}`);
      return;
    }
    sendRaw(text);
  }

  /** Encodes a res/err frame and hands it to the outbox; a failed encode is logged and dropped, never sent raw. */
  function reply(message: ServerMessage): void {
    let text: string;
    try {
      text = encodeMessage(message);
    } catch (error) {
      deps.log(`connection: encode failed: ${describeError(error)}`);
      return;
    }
    outbox?.reply(text);
  }

  function sendErr(id: number, code: RemoteErrorCode): void {
    const { text, language } = deps.errorText(code);
    reply({ t: "err", id, code, text, language });
  }

  /** A refusal only means anything while still awaiting the one hello frame (rule 3). */
  function refuseAuth(reason: AuthFailure, code: number): void {
    if (state.phase !== "awaiting-hello") return;
    state = { phase: "closed", device: undefined };
    clearHandshakeTimer();
    deps.onAuthFailed(reason);
    socket.close(code, "");
  }

  function handleHello(text: string): void {
    const message = parseClientMessage(text);
    if (message.t !== "hello") {
      refuseAuth("bad-frame", CLOSE.badFrame);
      return;
    }
    const authenticated = deps.authenticate(message.deviceId, message.token);
    if (authenticated === undefined) {
      refuseAuth("bad-credentials", CLOSE.unauthorized);
      return;
    }
    if (message.v !== PROTOCOL_VERSION) {
      // Ruling 16: a version mismatch closes 4426 without ever counting as
      // an auth failure — the credentials were fine, the dialect wasn't.
      state = { phase: "closed", device: undefined };
      clearHandshakeTimer();
      socket.close(CLOSE.versionMismatch, "");
      return;
    }

    clearHandshakeTimer();
    state = { phase: "open", device: authenticated };
    // The outbox is created the instant this connection becomes open, so
    // even a hub `onOpen` that closes it right back out (below) always has
    // one to dispose.
    outbox = createOutbox({
      socket,
      policies: deps.policies,
      now: deps.now,
      timers: deps.timers,
      log: deps.log,
      onCongested(reason) {
        deps.log(`connection: congested (${reason})`);
        close(CLOSE.congested, "");
        armCongestionTerminateTimer();
      },
    });
    // Controller ruling P8: `onOpen` runs before `welcome` is ever sent, not
    // after. The hub's `onOpen` is what enforces the 8-open-client cap, and
    // it can close this connection right back out (4503) before returning —
    // if it did, nothing past this point should reach the wire.
    deps.onOpen(connection);
    if (state.phase !== "open") return;
    send({ t: "welcome", v: PROTOCOL_VERSION, capabilities: [...deps.policies.keys()].sort() });
    armHeartbeat();
  }

  function withRateLimit(id: number, whenAllowed: () => void): void {
    if (!limiter.take()) {
      sendErr(id, "rate-limited");
      return;
    }
    whenAllowed();
  }

  function handleReq(message: ReqMessage, device: AuthenticatedDevice): void {
    let result: Promise<RequestOutcome>;
    try {
      result = deps.handle(message.ch, message.a, device);
    } catch (error) {
      deps.log(`connection: handle(${message.ch}) threw: ${describeError(error)}`);
      recordRemoteCallAudit(device, message.ch, message.a, "error");
      if (state.phase !== "open") return;
      sendErr(message.id, "internal");
      return;
    }
    result.then(
      (outcome) => {
        recordRemoteCallAudit(device, message.ch, message.a, auditOutcomeOf(outcome));
        if (state.phase !== "open") return;
        deliverOutcome(message.id, outcome);
      },
      (error: unknown) => {
        deps.log(`connection: handle(${message.ch}) rejected: ${describeError(error)}`);
        recordRemoteCallAudit(device, message.ch, message.a, "error");
        if (state.phase !== "open") return;
        sendErr(message.id, "internal");
      },
    );
  }

  function deliverOutcome(id: number, outcome: RequestOutcome): void {
    if (outcome.kind !== "value") {
      sendErr(id, outcome.kind);
      return;
    }
    // M4 rule kept: an encode failure (a BigInt in the value, say) answers
    // `id` with `err internal` rather than leaving the request unanswered —
    // `reply()`'s own silent drop-and-log is for a `res`/`err` that already
    // encoded, not for this fallback.
    let text: string;
    try {
      text = encodeMessage({ t: "res", id, v: outcome.value ?? null });
    } catch (error) {
      deps.log(`connection: encoding res ${id} failed: ${describeError(error)}`);
      sendErr(id, "internal");
      return;
    }
    outbox?.reply(text);
  }

  /**
   * A `blob` header frame while open (rule 3), checked in the order the
   * brief pins down: phase must be `none`, the declared shape must be
   * internally consistent, then the rate limiter, then the channel's own
   * limit — a refusal past the shape check still consumes the declared
   * frames (silently, via `discarding`) rather than desynchronising the
   * stream, so the connection stays open for whatever the client sends
   * next.
   */
  function handleBlobHeader(message: BlobMessage): void {
    if (blobPhase.kind !== "none") {
      close(CLOSE.badFrame, "");
      return;
    }
    if (!isValidBlobShape(message.bytes, message.chunks)) {
      close(CLOSE.badFrame, "");
      return;
    }

    const { id, ch, a, bytes, chunks } = message;

    function discardAfterRefusal(code: RemoteErrorCode, outcome: string): void {
      // `sendErr` can synchronously run the outbox congestion callback, which
      // closes this connection. Establishing the phase first lets close()
      // clear this timer instead of leaving a new one behind after close.
      blobPhase = { kind: "discarding", id, declared: bytes, received: 0, chunksLeft: chunks };
      armBlobIdleTimer();
      sendErr(id, code);
      logBlob(ch, bytes, chunks, outcome);
    }

    if (!limiter.take()) {
      discardAfterRefusal("rate-limited", "refused:rate-limited");
      return;
    }

    let limit: number | undefined;
    try {
      limit = deps.blobLimit(ch);
    } catch (_error) {
      deps.log(`connection: blobLimit(${ch}) failed`);
      limit = undefined;
    }

    // `deps.blobLimit` is laptop-side code, not phone input, but a caller
    // returning NaN/Infinity/a negative or non-integer value must not
    // silently become "accept anything up to MAX_BLOB_BYTES" (`bytes >
    // limit` is false for every finite `bytes` when `limit` is NaN or
    // +Infinity). Treated exactly like `undefined` — refused
    // unknown-channel, logged the same way.
    if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 1)) {
      deps.log(`connection: blobLimit(${ch}) returned an invalid limit`);
      limit = undefined;
    }

    if (limit === undefined) {
      discardAfterRefusal("unknown-channel", "refused:unknown-channel");
      return;
    }

    if (bytes > limit) {
      discardAfterRefusal("bad-request", "refused:bad-request");
      return;
    }

    logBlob(ch, bytes, chunks, "accepted");
    blobPhase = {
      kind: "receiving",
      id,
      ch,
      a,
      declared: bytes,
      chunks,
      received: 0,
      chunksLeft: chunks,
      parts: [],
    };
    armBlobIdleTimer();
  }

  /**
   * A finished, fully-received blob: delivered exactly as `handleReq`
   * delivers a `req` (`deliverOutcome`; a thrown or rejected handler
   * answers `err internal`; a result arriving after the connection has
   * since closed is dropped) — the only difference is the 4th argument.
   */
  function completeBlob(
    finished: Extract<BlobPhase, { kind: "receiving" }>,
    device: AuthenticatedDevice,
  ): void {
    const bytes = concatParts(finished.parts, finished.declared);
    let result: Promise<RequestOutcome>;
    try {
      result = deps.handle(finished.ch, finished.a, device, bytes);
    } catch (_error) {
      deps.log(`connection: blob handler(${finished.ch}) failed`);
      recordRemoteCallAudit(device, finished.ch, finished.a, "error");
      if (state.phase !== "open") return;
      sendErr(finished.id, "internal");
      return;
    }
    result.then(
      (outcome) => {
        recordRemoteCallAudit(device, finished.ch, finished.a, auditOutcomeOf(outcome));
        if (state.phase !== "open") return;
        deliverOutcome(finished.id, outcome);
      },
      (_error: unknown) => {
        deps.log(`connection: blob handler(${finished.ch}) failed`);
        recordRemoteCallAudit(device, finished.ch, finished.a, "error");
        if (state.phase !== "open") return;
        sendErr(finished.id, "internal");
      },
    );
  }

  function addUnkeyedTarget(channel: string): void {
    const policy = deps.policies.get(channel);
    if (policy === undefined || isKeyedPolicy(policy)) return;
    subscribed.add(channel);
  }

  function addKeyedTarget(channel: string, key: string, device: AuthenticatedDevice): void {
    const policy = deps.policies.get(channel);
    if (policy === undefined || !isKeyedPolicy(policy)) return;
    const id = keyedTargetId(channel, key);
    if (keyedSubscribed.has(id)) return; // already held: re-adding is a no-op, never a new slot
    if (keyedSubscribed.size >= MAX_KEYED_SUBSCRIPTIONS) return;
    let authorized: boolean;
    try {
      authorized = deps.authorizeKey(channel, key, device);
    } catch (error) {
      deps.log(`connection: authorizeKey(${channel}) threw: ${describeError(error)}`);
      return;
    }
    if (!authorized) return;
    keyedSubscribed.add(id);
  }

  function dropTarget(target: SubTarget): void {
    if (typeof target === "string") {
      subscribed.delete(target);
      outbox?.purge(target, undefined);
      return;
    }
    keyedSubscribed.delete(keyedTargetId(target.ch, target.key));
    outbox?.purge(target.ch, target.key);
  }

  function handleSub(message: SubMessage, device: AuthenticatedDevice): void {
    for (const target of message.add ?? []) {
      if (typeof target === "string") addUnkeyedTarget(target);
      else addKeyedTarget(target.ch, target.key, device);
    }
    for (const target of message.drop ?? []) {
      dropTarget(target);
    }
  }

  /**
   * A forced close from our side — a protocol violation while open, or the
   * hub aborting a still-pending handshake (e.g. on shutdown). Unlike
   * `refuseAuth`, this is not itself a refusal reason: it never calls
   * `onAuthFailed`, and it disarms whichever timer this connection actually
   * has armed for its current phase, so a hub that closes a pending socket
   * this way never leaves its 5s handshake timer ticking behind it.
   */
  function close(code: number, reason: string): void {
    // Task 6 fix round 1 (review minor): the congestion-terminate timer is
    // only ever armed from *outside* this function (the outbox's
    // `onCongested` callback, right after this very call returns) — never
    // by anything `close()` itself does. Clearing it had to move below the
    // "already closed" guard for exactly that reason: a redundant second
    // `close()` call within the 2 s terminate window (state already
    // "closed", nothing left to do) used to still reach a clear at the top
    // of this function, unconditionally, and silently disarm the safety
    // net that same congestion just armed — the connection would then
    // never be force-terminated if the real close event never arrived.
    // Past this guard, a *real* transition clears it defensively (below,
    // alongside the other per-phase timers) for symmetry, even though the
    // congestion path's own timer is armed only after this function
    // returns and so is never actually live yet at this point.
    if (state.phase === "closed") return;
    if (state.phase === "awaiting-hello") {
      state = { phase: "closed", device: undefined };
      clearHandshakeTimer();
      socket.close(code, reason);
      return;
    }
    // Rule 7: `handle` is never called for an unfinished blob — closing
    // drops whatever parts a receiving blob had accumulated rather than
    // finishing it, and a receiving blob (the only phase with a channel to
    // name) gets one last log line saying so.
    if (blobPhase.kind === "receiving") {
      logBlob(blobPhase.ch, blobPhase.declared, blobPhase.chunks, "aborted:closed");
    }
    const { device } = state;
    state = { phase: "closed", device };
    clearHeartbeatTimer();
    clearCongestionTerminateTimer();
    clearBlobIdleTimer();
    blobPhase = { kind: "none" };
    auditedInputKeys.clear();
    outbox?.dispose();
    socket.close(code, reason);
  }

  /**
   * Every frame once open, dispatched by `t` (rule 6). Reached only past
   * the `state.phase !== "open"` guard below, which is also what narrows
   * `state.device` to a real `AuthenticatedDevice` for `handleReq` — there
   * is no second check standing behind it.
   */
  function onText(text: string): void {
    if (state.phase === "awaiting-hello") {
      handleHello(text);
      return;
    }
    if (state.phase !== "open") return; // closed: nothing dispatches further
    const { device } = state;

    const message = parseClientMessage(text);
    switch (message.t) {
      case "hello":
        close(CLOSE.badFrame, "");
        return;
      case "req":
        withRateLimit(message.id, () => handleReq(message, device));
        return;
      case "sub":
        // A sub frame takes one limiter token too — refused, the whole
        // frame is silently ignored (there is no `id` to answer an err to).
        if (!limiter.take()) return;
        handleSub(message, device);
        return;
      case "pong":
        missedPongs = 0;
        return;
      case "blob":
        handleBlobHeader(message);
        return;
      case "bye":
        close(CLOSE.normal, "bye");
        return;
      case "invalid":
        if (message.malformedBlob === true) {
          close(CLOSE.badFrame, "");
          return;
        }
        if (message.id !== undefined) {
          const id = message.id;
          withRateLimit(id, () => sendErr(id, "bad-request"));
        } else {
          close(CLOSE.badFrame, "");
        }
        return;
    }
  }

  /**
   * A binary WebSocket frame while open (rule 4). With no blob in flight
   * this is M4's unchanged behaviour: `close(unsupportedData)`. Mid-blob,
   * every per-chunk bound is checked before a single byte is kept —
   * `receiving` alone accumulates `data`; `discarding` counts it and drops
   * it. Reaching the declared chunk count either finishes the blob
   * (`receiving`) or ends the discard (`discarding`) — both close if the
   * bytes actually received never matched what the header declared.
   */
  function onBinary(data: Uint8Array): void {
    if (state.phase === "awaiting-hello") {
      refuseAuth("bad-frame", CLOSE.badFrame);
      return;
    }
    if (state.phase !== "open") return;
    const { device } = state;

    if (blobPhase.kind === "none") {
      close(CLOSE.unsupportedData, "");
      return;
    }

    // M8 final M2 (Task 6): a binary frame is only ever reachable past the
    // check above while a blob is actually in flight for this connection —
    // real evidence of life on the wire, same as a `pong`, for a phone that
    // may be too busy streaming a large upload to also answer a `ping` on
    // time. An idle connection's stray binary frame never reaches this
    // point (closed just above), so this can never substitute for a real
    // pong outside an actual upload — text `pong` handling is unchanged.
    missedPongs = 0;

    // `blobPhase.chunksLeft === 0` is not checked here: the moment it
    // reaches 0 below, the phase is reset to `none` (or the connection is
    // closed), so a *later* binary frame always meets the `kind === "none"`
    // check above first — a `chunksLeft === 0` blob phase never reaches
    // this point to check.
    if (
      data.length === 0 ||
      data.length > MAX_BLOB_CHUNK_BYTES ||
      blobPhase.received + data.length > blobPhase.declared
    ) {
      close(CLOSE.badFrame, "");
      return;
    }

    armBlobIdleTimer();
    const received = blobPhase.received + data.length;
    const chunksLeft = blobPhase.chunksLeft - 1;
    blobPhase =
      blobPhase.kind === "receiving"
        ? { ...blobPhase, received, chunksLeft, parts: [...blobPhase.parts, data] }
        : { ...blobPhase, received, chunksLeft };

    if (chunksLeft > 0) return;

    if (received !== blobPhase.declared) {
      close(CLOSE.badFrame, "");
      return;
    }
    clearBlobIdleTimer();
    const finished = blobPhase;
    blobPhase = { kind: "none" };
    if (finished.kind === "receiving") {
      logBlob(finished.ch, finished.declared, finished.chunks, "complete");
      completeBlob(finished, device);
    }
    // `discarding` sends nothing more (rule 4).
  }

  function onSocketClosed(code: number): void {
    if (closedHandled) return;
    closedHandled = true;
    const device = state.phase === "awaiting-hello" ? undefined : state.device;
    clearHandshakeTimer();
    clearHeartbeatTimer();
    clearCongestionTerminateTimer();
    clearBlobIdleTimer();
    blobPhase = { kind: "none" };
    auditedInputKeys.clear();
    outbox?.dispose();
    state = { phase: "closed", device };
    // Rule 9: onClosed fires once, only for a connection that was ever
    // authenticated — whatever it was that closed the socket.
    if (device !== undefined) deps.onClosed(connection, code);
  }

  function push(channel: string, payload: unknown, key: string | undefined): void {
    if (state.phase !== "open") return;
    const policy = deps.policies.get(channel);
    if (policy === undefined) return;
    if (isKeyedPolicy(policy)) {
      if (key === undefined) return;
      if (!keyedSubscribed.has(keyedTargetId(channel, key))) return;
      // Fix round 1 (Important 1): the subscribe-time authorizeKey check
      // (addKeyedTarget, above) is not enough on its own — ownership can
      // move to a different device after the subscription was accepted
      // (docker:unfollow, then another device follows the same tab id), and
      // the subscription itself is never dropped when that happens. So
      // every keyed push is re-authorised here too, right before delivery —
      // a push whose key the authoriser now refuses is silently skipped for
      // this connection (fail-closed; no error frame). Re-running is cheap:
      // every real AuthorizeKey (followerOwner, shells.has, sessions.get)
      // is a Map lookup, not a network or disk call.
      let authorized: boolean;
      try {
        authorized = deps.authorizeKey(channel, key, state.device);
      } catch (error) {
        deps.log(`connection: authorizeKey(${channel}) threw: ${describeError(error)}`);
        return;
      }
      if (!authorized) return;
    } else {
      if (!subscribed.has(channel)) return;
    }
    outbox?.push(channel, payload, key);
  }

  const connection: Connection = {
    get device() {
      return state.phase === "awaiting-hello" ? undefined : state.device;
    },
    onText,
    onBinary,
    onSocketClosed,
    push,
    subscribes: (channel, key) =>
      key === undefined
        ? subscribed.has(channel)
        : keyedSubscribed.has(keyedTargetId(channel, key)),
    close,
  };

  return connection;
}
