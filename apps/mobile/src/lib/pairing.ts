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
  CLOSE,
  DEVICE_ID_PATTERN,
  type PairClientMessage,
  type PairingLink,
  PROTOCOL_VERSION,
  SECRET_PATTERN,
  canonicalAddress,
  encodeMessage,
  isUnspecifiedAddress,
} from "@jarvis/wire";
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
        | "protocol";
      /** The transport's last raw error message before the failure, when
       * one was emitted — shown small under the friendly copy so a device
       * that can't be debugged any other way (a sideloaded iPhone with no
       * Xcode attached) still says WHY. Never carries the secret: transport
       * error text comes from the OS socket layer, which never sees it. */
      detail?: string;
    };

export type PairDeps = {
  transport: Transport;
  clock: Clock;
  client: string;
};

// The laptop's own confirmation dialog times out at 60s (M4); this gives
// the phone's wait UI margin beyond that (global-constraints.md).
const PAIR_WAIT_MS = 75_000;

// Connect deadline for the pairing dial specifically — NOT wire's shared
// HANDSHAKE_TIMEOUT_MS (5s), which the desktop also uses for its own
// post-TLS handshake budget. A phone's first dial of a Tailscale peer can
// spend seconds on MagicDNS plus a cold tunnel path (a real iPad trace
// showed 2.6s before TCP even connected) before TLS starts; 5s cut real
// attempts short. Pairing is interactive and rare — a longer spinner
// beats a false "unreachable".
export const PAIR_CONNECT_TIMEOUT_MS = 15_000;

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
    // Kept for PairOutcome.detail (see its doc): the transport's error
    // events are otherwise diagnostic-only, but on a failure the last one
    // is the only clue a device without a debugger ever surfaces.
    let lastErrorMessage: string | undefined;

    function settle(outcome: PairOutcome): void {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) {
        deps.clock.clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (!outcome.ok && lastErrorMessage !== undefined && outcome.detail === undefined) {
        outcome = { ...outcome, detail: lastErrorMessage };
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
        socket?.close(CLOSE.normal, "connect timeout");
        // Fixed detail: this path has no transport error event to keep,
        // and "hung until the deadline" vs "died with an OS error" is
        // exactly the distinction a screenshot of the pair screen needs
        // to carry.
        settle({
          ok: false,
          reason: "unreachable",
          detail: `no connection within ${PAIR_CONNECT_TIMEOUT_MS / 1000}s`,
        });
      }, PAIR_CONNECT_TIMEOUT_MS);
    }

    function onEvent(event: TransportEvent): void {
      if (settled) return;
      switch (event.kind) {
        case "open": {
          opened = true;
          if (timeoutTimer !== undefined) {
            deps.clock.clearTimeout(timeoutTimer);
          }
          timeoutTimer = deps.clock.setTimeout(() => {
            timeoutTimer = undefined;
            socket?.close(CLOSE.normal, "timeout");
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
            socket?.close(CLOSE.normal, "protocol violation");
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
          socket?.close(CLOSE.normal, "paired");
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
          // carries the real code/reason this function acts on. The text
          // is kept for PairOutcome.detail, nothing more.
          if (event.message !== "") {
            lastErrorMessage = event.message;
          }
          return;
      }
    }
  });
}

/**
 * `pair()`, with the pinned-IP fallback (first hit on a sideloaded iPad:
 * the OS WebSocket's system-trust dial of the DNS `name` failed where the
 * pinned native socket to the same box works). A system-trust link always
 * carries the fingerprint too, so when the by-name dial dies without the
 * server ever answering — reason "unreachable", the socket never opened,
 * the secret never sent — the same link is retried once, pinned by IP,
 * name dropped. A success on that path stores a record WITHOUT `name`, so
 * every later session socket takes the pinned path too instead of
 * re-failing by name on each reconnect.
 *
 * Only "unreachable" falls back: every other failure means the server was
 * reached (denied/expired/busy consumed the one-shot secret; "fingerprint"
 * means the wrong box or an interceptor — retrying would be wrong twice).
 * A fallback failure reports the original by-name failure (its detail
 * included), except a fingerprint mismatch, which always surfaces.
 */
export async function pairWithFallback(
  deps: PairDeps,
  link: PairingLink,
  deviceName: string,
): Promise<PairOutcome> {
  const byName = await pair(deps, link, deviceName);
  if (byName.ok || link.name === undefined) return byName;
  if (byName.reason !== "unreachable") return byName;
  if (isUnspecifiedAddress(link.host)) return byName;
  const { name: _dropped, ...pinnedOnly } = link;
  const pinned = await pair(deps, pinnedOnly, deviceName);
  if (pinned.ok) return pinned;
  return pinned.reason === "fingerprint" ? pinned : byName;
}
