// The `/pair` exchange (Task 5, task-5-brief.md behaviour rules 1-4): opens
// a socket to `/pair` — pinned by IP, or (M11, rulings.md 1) system-trust
// by DNS `name` when the link carries one — sends exactly one `pair`
// frame, and maps the first (and only) reply frame or the socket's close
// code to a `PairOutcome`. The secret is copied out of `link.secret` once,
// into a local that is blanked right after the one frame that needs it is
// sent — never assigned to any field of the returned outcome, never
// logged (this module takes no `log` dependency at all). The `onEvent`
// closure itself stays reachable for as long as the transport holds the
// listener, so this bounds how long the secret is retrievable, not that
// nothing retains it at all.

import {
  type AuthTokens,
  CLOSE,
  DEVICE_ID_PATTERN,
  HANDSHAKE_TIMEOUT_MS,
  type PairClientMessage,
  type PairJoinMessage,
  type PairingLink,
  PROTOCOL_VERSION,
  SECRET_PATTERN,
  canonicalAddress,
  encodeMessage,
  isUnspecifiedAddress,
} from "@jarvis/wire";
import { parseTokens } from "./auth-session";
import type { ClientPlatform } from "./client-platform";
import type { Clock } from "./clock";
import type { PairingRecord } from "./pairing-record";
import type { Credential } from "./rpc-client";
import type { Transport, TransportEvent, TransportSocket, Trust } from "./transport";
import { socketUrl } from "./transport";

export type PairOutcome =
  | { ok: true; record: PairingRecord; credential: Credential }
  | {
      ok: false;
      reason:
        | "invalid-link"
        | "host-needed"
        | "fingerprint"
        | "unreachable"
        | "denied"
        | "expired"
        | "busy"
        | "timeout"
        | "protocol"
        | "web-needs-certificate";
    };

export type PairDeps = {
  transport: Transport;
  clock: Clock;
  client: string;
  platform: ClientPlatform;
};

// The laptop's own confirmation dialog times out at 60s (M4); this gives
// the phone's wait UI margin beyond that (global-constraints.md).
export const PAIR_WAIT_MS = 75_000;

/**
 * `0.0.0.0` / `::` — an unspecified bind the phone cannot dial (ruling 12).
 * M11 rulings.md 1: never true when `link.name` is set — a system-trust
 * link is dialled by name, so its (possibly unspecified) bind address is
 * irrelevant.
 */
export function needsHost(link: PairingLink): boolean {
  if (link.name !== undefined) return false;
  return isUnspecifiedAddress(link.host);
}

/**
 * Substitutes `host`, validated (and normalised) as a canonical IP literal;
 * `undefined` for anything else, including a hostname or an unspecified
 * address (`0.0.0.0`/`::`) — typing the same "dial anything" value the
 * pairing link itself wasn't dialable with doesn't become dialable just
 * because a user typed it.
 */
export function withHost(link: PairingLink, host: string): PairingLink | undefined {
  const canonical = canonicalAddress(host);
  if (canonical === undefined) return undefined;
  if (isUnspecifiedAddress(canonical)) return undefined;
  return { ...link, host: canonical };
}

/**
 * Task 13: the browser build cannot pin a certificate — a browser
 * WebSocket only trusts the OS store — so a fingerprint-only link (no DNS
 * `name`, the pinned-by-IP path) is refused on web. Browser access needs
 * Tailscale with a real certificate.
 */
export function linkRefusedOn(link: PairingLink, platform: ClientPlatform): boolean {
  return platform === "web" && link.name === undefined;
}

/** Only ever closing it: a socket already gone says so by throwing, and that
 *  must not stop the answer the screen is waiting for. */
function closeQuietly(socket: TransportSocket | undefined, reason: string): void {
  try {
    socket?.close(CLOSE.normal, reason);
  } catch {
    // Gone already.
  }
}

function closeReason(code: number): "denied" | "expired" | "timeout" | "protocol" {
  switch (code) {
    case CLOSE.pairingDenied:
      return "denied";
    case CLOSE.unauthorized:
      return "expired";
    case CLOSE.handshakeTimeout:
      return "timeout";
    default:
      return "protocol";
  }
}

/** Defensive, field-by-field parse of the one expected `paired` reply — never throws, never spreads. */
function parsePairedFrame(text: string): { deviceId: string; token: string } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.t !== "paired") return undefined;
  if (obj.v !== PROTOCOL_VERSION) return undefined;
  if (typeof obj.deviceId !== "string" || !DEVICE_ID_PATTERN.test(obj.deviceId)) return undefined;
  if (typeof obj.token !== "string" || !SECRET_PATTERN.test(obj.token)) return undefined;
  return { deviceId: obj.deviceId, token: obj.token };
}

export function pair(deps: PairDeps, link: PairingLink, deviceName: string): Promise<PairOutcome> {
  if (linkRefusedOn(link, deps.platform)) {
    return Promise.resolve({ ok: false, reason: "web-needs-certificate" });
  }
  // Copied out of `link` up front: everything past this point (including
  // every closure below) reads from these locals, never from `link` or
  // `link.secret` again — `secret` itself is blanked the moment the one
  // frame that needs it has been sent, so nothing keeps it reachable for
  // longer than that.
  const { host, port, fingerprint, name } = link;
  let secret: string | undefined = link.secret;
  // M11 rulings.md 1: a `name` (a configured, DNS-SAN-carrying certificate)
  // dials that name with the OS trust store; otherwise the leaf is pinned
  // by IP, exactly as M6.
  const url = socketUrl(name ?? host, port, "/pair");
  const trust: Trust = name === undefined ? { kind: "pin", fingerprint } : { kind: "system" };

  return new Promise((resolve) => {
    let settled = false;
    let opened = false;
    let timeoutTimer: unknown;

    function settle(outcome: PairOutcome): void {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) {
        deps.clock.clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      resolve(outcome);
    }

    // `undefined` until `deps.transport.open()` returns — every use below
    // is through `socket?.`, because a transport that ever delivered
    // `open` synchronously (none of ours does today) would run `onEvent`
    // before this variable is assigned.
    let socket: TransportSocket | undefined;
    try {
      socket = deps.transport.open(url, trust, onEvent);
    } catch {
      settle({ ok: false, reason: "unreachable" });
      return;
    }
    // Answered during the open itself: there was no socket to close yet.
    if (settled) {
      closeQuietly(socket, "settled");
      return;
    }

    // A deadline on the connect itself: if the transport never delivers an
    // `open` (a hung TLS connect, a silently dropped SYN), nothing else in
    // this function would ever settle the promise. Replaced by the longer
    // `PAIR_WAIT_MS` deadline once `open` actually fires — guarded by
    // `!opened` so a transport that already delivered `open` synchronously
    // during the `deps.transport.open()` call above (and so already armed
    // its own `PAIR_WAIT_MS` timer) never has that timer silently
    // replaced by this shorter one.
    if (!opened) {
      timeoutTimer = deps.clock.setTimeout(() => {
        timeoutTimer = undefined;
        closeQuietly(socket, "connect timeout");
        settle({ ok: false, reason: "unreachable" });
      }, HANDSHAKE_TIMEOUT_MS);
    }

    function onEvent(event: TransportEvent): void {
      if (settled) {
        // React Native on Android drops a close made before the upgrade
        // finishes, then opens anyway. Left open, the server's handshake timer
        // counts it as a failed sign-in against this phone.
        if (event.kind === "open") closeQuietly(socket, "settled");
        return;
      }
      switch (event.kind) {
        case "open": {
          opened = true;
          if (timeoutTimer !== undefined) {
            deps.clock.clearTimeout(timeoutTimer);
          }
          timeoutTimer = deps.clock.setTimeout(() => {
            timeoutTimer = undefined;
            closeQuietly(socket, "timeout");
            settle({ ok: false, reason: "timeout" });
          }, PAIR_WAIT_MS);
          if (secret === undefined) {
            // Nothing left to send — a second `open` after the one frame
            // this exchange ever sends already went out (a transport
            // re-firing `open`, which none of ours does today) must not
            // resend, and must not send an empty secret either.
            return;
          }
          const frame: PairClientMessage = {
            t: "pair",
            v: PROTOCOL_VERSION,
            secret,
            deviceName,
            client: deps.client,
          };
          socket?.send(encodeMessage(frame));
          secret = undefined;
          return;
        }
        case "message": {
          const parsed = parsePairedFrame(event.text);
          if (parsed === undefined) {
            closeQuietly(socket, "protocol violation");
            settle({ ok: false, reason: "protocol" });
            return;
          }
          const record: PairingRecord = {
            deviceId: parsed.deviceId,
            host,
            port,
            fingerprint,
            pairedAt: deps.clock.now(),
          };
          if (name !== undefined) {
            record.name = name;
          }
          const credential: Credential = { deviceId: parsed.deviceId, token: parsed.token };
          closeQuietly(socket, "paired");
          settle({ ok: true, record, credential });
          return;
        }
        case "close": {
          // The pinned socket signals a fingerprint mismatch through the
          // close's `reason`, not through the free-form `error` message
          // that precedes it (transport.ts's contract) — checked first, so
          // it takes priority whether or not `open` ever fired.
          if (event.reason === "fingerprint") {
            settle({ ok: false, reason: "fingerprint" });
            return;
          }
          if (!opened) {
            settle({ ok: false, reason: "unreachable" });
            return;
          }
          settle({ ok: false, reason: closeReason(event.code) });
          return;
        }
        case "error":
          // Diagnostic only (transport.ts): the close that always follows
          // carries the real code/reason this function acts on.
          return;
      }
    }
  });
}

/** The record of a joined machine (decision 16): with `name` set, neither of
 *  these is read for dialling. Every display of either must prefer the name. */
export const JOINED_HOST = "0.0.0.0";
export const JOINED_FINGERPRINT = "0".repeat(64);
/** Past the open: the target's password check can wait behind others. */
export const JOIN_WAIT_MS = 30_000;
/** What a socket reports when no close frame arrived: the connection went. */
const ABNORMAL_CLOSE = 1006;

export type JoinOutcome =
  | { ok: true; record: PairingRecord; credential: Credential; tokens: AuthTokens }
  | {
      ok: false;
      reason: "refused" | "rate-limited" | "unreachable" | "timeout" | "protocol" | "abandoned";
    };

function joinCloseReason(code: number): "refused" | "rate-limited" | "unreachable" | "protocol" {
  switch (code) {
    case CLOSE.unauthorized:
      return "refused";
    case CLOSE.tooManyRequests:
      return "rate-limited";
    // The machine is there and cannot take this now, or the connection went:
    // nothing an update would change.
    case ABNORMAL_CLOSE:
    case CLOSE.overCapacity:
    case CLOSE.goingAway:
    case CLOSE.internalError:
      return "unreachable";
    default:
      return "protocol";
  }
}

function parseJoinedFrame(
  text: string,
): { deviceId: string; token: string; tokens: AuthTokens } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.t !== "joined") return undefined;
  if (obj.v !== PROTOCOL_VERSION) return undefined;
  if (typeof obj.deviceId !== "string" || !DEVICE_ID_PATTERN.test(obj.deviceId)) return undefined;
  if (typeof obj.token !== "string" || !SECRET_PATTERN.test(obj.token)) return undefined;
  const tokens = parseTokens(obj.tokens);
  if (tokens === undefined) return undefined;
  return { deviceId: obj.deviceId, token: obj.token, tokens };
}

/**
 * The owner password in place of a pairing secret, over the same socket. As in
 * `pair()`: this module keeps it in one local, drops that reference the moment
 * its one frame has gone or the exchange has ended, never puts it in an outcome,
 * and has no log. Nothing an error says is kept, as a send's error could name
 * what it was sending. A string cannot be wiped: the engine's copies, and the
 * encoded frame handed to the socket, last until they are collected.
 *
 * `cancel` is the screen going. Before the frame has gone the password stays
 * here: the socket closes and the answer is `abandoned`. After, it is too late
 * to take back, so the answer comes as usual.
 */
export function joinMachine(
  deps: PairDeps,
  address: { name: string; port: number },
  password: string,
  deviceName: string,
  cancel?: AbortSignal,
): Promise<JoinOutcome> {
  const { name, port } = address;
  let secret: string | undefined = password;

  return new Promise((resolve) => {
    let settled = false;
    let opened = false;
    let timeoutTimer: unknown;
    let socket: TransportSocket | undefined;

    function settle(outcome: JoinOutcome): void {
      if (settled) return;
      settled = true;
      secret = undefined;
      cancel?.removeEventListener("abort", onCancel);
      if (timeoutTimer !== undefined) {
        deps.clock.clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      resolve(outcome);
    }

    function onCancel(): void {
      if (secret === undefined) return;
      closeQuietly(socket, "cancelled");
      settle({ ok: false, reason: "abandoned" });
    }

    if (cancel?.aborted === true) {
      settle({ ok: false, reason: "abandoned" });
      return;
    }
    cancel?.addEventListener("abort", onCancel);

    try {
      socket = deps.transport.open(
        socketUrl(name, port, "/pair"),
        { kind: "system" } satisfies Trust,
        onEvent,
      );
    } catch {
      settle({ ok: false, reason: "unreachable" });
      return;
    }
    // Answered during the open itself: there was no socket to close yet.
    if (settled) {
      closeQuietly(socket, "settled");
      return;
    }

    if (!opened) {
      timeoutTimer = deps.clock.setTimeout(() => {
        timeoutTimer = undefined;
        closeQuietly(socket, "connect timeout");
        settle({ ok: false, reason: "unreachable" });
      }, HANDSHAKE_TIMEOUT_MS);
    }

    function onOpen(): void {
      // The one frame has gone: a second `open` sends nothing, and leaves the
      // wait where it is.
      if (opened || secret === undefined) return;
      opened = true;
      if (timeoutTimer !== undefined) deps.clock.clearTimeout(timeoutTimer);
      timeoutTimer = deps.clock.setTimeout(() => {
        timeoutTimer = undefined;
        closeQuietly(socket, "timeout");
        settle({ ok: false, reason: "timeout" });
      }, JOIN_WAIT_MS);
      const frame: PairJoinMessage = {
        t: "join",
        v: PROTOCOL_VERSION,
        password: secret,
        deviceName,
        client: deps.client,
      };
      try {
        socket?.send(encodeMessage(frame));
      } catch {
        closeQuietly(socket, "send failed");
        settle({ ok: false, reason: "unreachable" });
        return;
      }
      secret = undefined;
    }

    function onEvent(event: TransportEvent): void {
      if (settled) {
        // As in `pair()`: a close made before the upgrade finished may have been
        // dropped, and an open left standing counts against this phone.
        if (event.kind === "open") closeQuietly(socket, "settled");
        return;
      }
      switch (event.kind) {
        case "open":
          onOpen();
          return;
        case "message": {
          const parsed = parseJoinedFrame(event.text);
          if (parsed === undefined) {
            closeQuietly(socket, "protocol violation");
            settle({ ok: false, reason: "protocol" });
            return;
          }
          const record: PairingRecord = {
            deviceId: parsed.deviceId,
            host: JOINED_HOST,
            port,
            fingerprint: JOINED_FINGERPRINT,
            name,
            pairedAt: deps.clock.now(),
            laptopName: name.split(".")[0],
          };
          const credential: Credential = { deviceId: parsed.deviceId, token: parsed.token };
          closeQuietly(socket, "joined");
          settle({ ok: true, record, credential, tokens: parsed.tokens });
          return;
        }
        case "close":
          settle({
            ok: false,
            reason: opened ? joinCloseReason(event.code) : "unreachable",
          });
          return;
        case "error":
          // Diagnostic only (transport.ts): the close that follows decides.
          return;
      }
    }
  });
}
