// The `/rpc` and `/pair` listener's single point of admission control:
// caps of 8 open, authenticated connections and 16 sockets still mid
// handshake, per-source auth backoff consulted before a socket is even
// handed to `createConnection`, fan-out to every open connection, and
// immediate revocation. Task 7 (the bridge) is the only caller — it wires
// a real `ws` server's `connection` event to `accept()` and this file never
// touches a socket directly.

import type { AuditLog } from "./audit.js";
import type {
  AuditPolicy,
  AuthorizeKey,
  Connection,
  ConnectionDeps,
  RequestHandler,
} from "./connection.js";
import { createConnection } from "./connection.js";
import { describeError } from "./io.js";
import type { SessionHandlers, SocketLike } from "./io.js";
import { type AuthBackoff, createAuthBackoff } from "./limits.js";
import type { ChannelPolicies, ChannelPolicy } from "./policy.js";
import { isKeyedPolicy, isSubscriptionKey } from "./policy.js";
import { CLOSE } from "./protocol.js";

export const MAX_CLIENTS = 8;
export const MAX_PENDING = 16;

export type HubDeps = {
  now: ConnectionDeps["now"];
  timers: ConnectionDeps["timers"];
  authenticate: ConnectionDeps["authenticate"];
  handle: RequestHandler;
  policies: ChannelPolicies;
  authorizeKey: AuthorizeKey;
  blobLimit: ConnectionDeps["blobLimit"];
  errorText: ConnectionDeps["errorText"];
  log(line: string): void;
  audit: Pick<AuditLog, "record">;
  /** M12 Task 3: pass-through to `ConnectionDeps.auditPolicy` — the hub
   *  never classifies a channel itself, it only forwards. */
  auditPolicy(channel: string): AuditPolicy;
  backoff?: AuthBackoff;
  touch(deviceId: string): void;
  onConnectionsChanged(): void;
  onDeviceDisconnected(deviceId: string): void;
  pairSession(socket: SocketLike, source: string, onFailure: () => void): SessionHandlers;
};

export type Hub = {
  accept(kind: "rpc" | "pair", socket: SocketLike, source: string): SessionHandlers;
  push(channel: string, payload: unknown): void;
  hasSubscriber(channel: string): boolean;
  /** M10: "who is watching" — every device id with at least one open
   *  connection subscribed to `channel`/`key` (unkeyed when `key` is
   *  omitted, same convention as `Connection.subscribes`). */
  watchingDevices(channel: string, key?: string): ReadonlySet<string>;
  closeDevice(deviceId: string, code: number): number;
  closeAll(code: number): void;
  connectedDeviceIds(): ReadonlySet<string>;
};

/** The payload's key for a keyed policy — `undefined` for `latest` and for `reliable` without a `keyOf`, which `isKeyedPolicy` already excludes from ever calling this. */
function keyOfPolicy(policy: ChannelPolicy, payload: unknown): unknown {
  if (policy.kind === "stream") return policy.keyOf(payload);
  if (policy.kind === "reliable" && policy.keyOf !== undefined) return policy.keyOf(payload);
  return undefined;
}

const NOOP_HANDLERS: SessionHandlers = {
  onText() {},
  onBinary(_data) {},
  onClose() {},
};

export function createHub(deps: HubDeps): Hub {
  const backoff = deps.backoff ?? createAuthBackoff(deps.now);

  // Every socket the hub has accepted but not yet resolved to either an
  // open connection or a closed one — both `pair` sessions and `/rpc`
  // sockets still mid-handshake count against the same 16-slot cap. Each
  // entry's value is how to abort *that* socket properly: closing the raw
  // socket alone would leave its handshake timer armed (a `Connection`'s or
  // a pair session's own 5s timeout), so `closeAll` needs a way to disarm
  // it too, not just sever the wire.
  const pending = new Map<SocketLike, (code: number) => void>();

  const open = new Set<Connection>();
  const byDevice = new Map<string, Set<Connection>>();

  function accept(kind: "rpc" | "pair", socket: SocketLike, source: string): SessionHandlers {
    if (backoff.isBlocked(source)) {
      // I4: a source hammering a blocked window would otherwise get one
      // `auth-failed backoff` audit line per attempt. `shouldLogBlocked`
      // (limits.ts) answers true at most once per source per block period
      // — its own bookkeeping lives on AuthBackoff's already-capped,
      // already-evicted per-source entry, not a second unbounded
      // structure here.
      if (backoff.shouldLogBlocked(source)) {
        deps.audit.record({ kind: "auth-failed", source, reason: "backoff" });
      }
      socket.close(CLOSE.tooManyRequests, "");
      return NOOP_HANDLERS;
    }
    if (pending.size >= MAX_PENDING) {
      deps.audit.record({ kind: "refused", source, reason: "capacity" });
      socket.close(CLOSE.overCapacity, "");
      return NOOP_HANDLERS;
    }

    let freed = false;
    function freeSlot(): void {
      if (freed) return;
      freed = true;
      pending.delete(socket);
    }

    if (kind === "pair") {
      const inner = deps.pairSession(socket, source, () => backoff.fail(source));
      // Aborting a pending pair session closes the wire, then runs the
      // session's own `onClose` so it disarms its handshake timer and
      // settles — exactly what happens when the real socket's close event
      // eventually arrives, just driven synchronously instead of waited on.
      pending.set(socket, (code) => {
        socket.close(code, "");
        inner.onClose(code);
      });
      return {
        onText: inner.onText,
        onBinary: inner.onBinary,
        onClose(code) {
          freeSlot();
          inner.onClose(code);
        },
      };
    }

    const connection = createConnection(socket, {
      source,
      now: deps.now,
      timers: deps.timers,
      authenticate: deps.authenticate,
      handle: deps.handle,
      policies: deps.policies,
      authorizeKey: deps.authorizeKey,
      blobLimit: deps.blobLimit,
      errorText: deps.errorText,
      log: deps.log,
      audit: deps.audit,
      auditPolicy: deps.auditPolicy,

      onOpen(c) {
        freeSlot();
        const device = c.device;
        if (device === undefined) return; // unreachable: onOpen only fires once authenticated
        if (open.size >= MAX_CLIENTS) {
          deps.audit.record({ kind: "refused", source, reason: "capacity" });
          c.close(CLOSE.overCapacity, "");
          return;
        }
        open.add(c);
        addToDevice(device.id, c);
        backoff.succeed(source);
        deps.audit.record({ kind: "connected", source, deviceId: device.id });
        deps.touch(device.id);
        deps.onConnectionsChanged();
      },

      onAuthFailed(reason) {
        freeSlot();
        // A real failed attempt (not a blocked one refused above) always
        // (re-)sets or extends the block — resetting `logged` inside
        // fail() itself means the next shouldLogBlocked() hit is a new
        // period, and gets its own audit line.
        backoff.fail(source);
        deps.audit.record({ kind: "auth-failed", source, reason });
      },

      onClosed(c, code) {
        if (!open.has(c)) return; // already removed (e.g. by closeDevice) — never double-count
        const device = c.device;
        if (device === undefined) return; // unreachable: onClosed only ever fires once authenticated
        open.delete(c);
        removeFromDevice(device.id, c);
        deps.audit.record({ kind: "disconnected", deviceId: device.id, code });
        // Fires only on the transition from >=1 open connection for this
        // device to zero — removeFromDevice above already deleted the
        // per-device set once its last connection left it.
        if (!byDevice.has(device.id)) fireDeviceDisconnected(device.id);
        deps.onConnectionsChanged();
      },
    });
    // `connection.close()` clears whichever timer it has armed for its
    // current phase — the handshake timer while still pending, the
    // heartbeat once open — so aborting it is safe regardless of how far
    // the handshake got.
    pending.set(socket, (code) => connection.close(code, ""));

    return {
      onText: connection.onText,
      onBinary: connection.onBinary,
      onClose(code) {
        freeSlot();
        connection.onSocketClosed(code);
      },
    };
  }

  function addToDevice(deviceId: string, c: Connection): void {
    let set = byDevice.get(deviceId);
    if (set === undefined) {
      set = new Set();
      byDevice.set(deviceId, set);
    }
    set.add(c);
  }

  function removeFromDevice(deviceId: string, c: Connection): void {
    const set = byDevice.get(deviceId);
    if (set === undefined) return;
    set.delete(c);
    if (set.size === 0) byDevice.delete(deviceId);
  }

  /** Rule 7: fires at most once per transition, a throw logged rather than left to escape into caller code. */
  function fireDeviceDisconnected(deviceId: string): void {
    try {
      deps.onDeviceDisconnected(deviceId);
    } catch (error) {
      deps.log(`hub: onDeviceDisconnected(${deviceId}) threw: ${describeError(error)}`);
    }
  }

  return {
    accept,

    push(channel, payload) {
      const policy = deps.policies.get(channel);
      if (policy === undefined) return;
      let key: string | undefined;
      if (isKeyedPolicy(policy)) {
        let raw: unknown;
        try {
          raw = keyOfPolicy(policy, payload);
        } catch (error) {
          deps.log(`hub: keyOf(${channel}) threw: ${describeError(error)}`);
          return;
        }
        if (!isSubscriptionKey(raw)) return;
        key = raw;
      }
      for (const connection of open) connection.push(channel, payload, key);
    },

    hasSubscriber(channel) {
      for (const connection of open) {
        if (connection.subscribes(channel)) return true;
      }
      return false;
    },

    watchingDevices(channel, key) {
      const result = new Set<string>();
      for (const [deviceId, connections] of byDevice) {
        for (const connection of connections) {
          if (connection.subscribes(channel, key)) {
            result.add(deviceId);
            break;
          }
        }
      }
      return result;
    },

    closeDevice(deviceId, code) {
      const set = byDevice.get(deviceId);
      if (set === undefined || set.size === 0) return 0;
      const connections = [...set];
      // Removed from every tracking set *before* any `close()` call, so a
      // close callback firing later (the real socket's own close event)
      // finds the connection already gone and never double-counts it.
      byDevice.delete(deviceId);
      for (const connection of connections) open.delete(connection);
      for (const connection of connections) connection.close(code, "");
      fireDeviceDisconnected(deviceId);
      deps.onConnectionsChanged();
      return connections.length;
    },

    closeAll(code) {
      // `abort` (not a bare `socket.close`) so a still-pending handshake's
      // 5s timer is disarmed here too, not left ticking toward a spurious
      // `auth-failed` timeout after the wire is already gone.
      for (const abort of pending.values()) abort(code);
      for (const connection of open) connection.close(code, "");
    },

    connectedDeviceIds() {
      return new Set(byDevice.keys());
    },
  };
}
