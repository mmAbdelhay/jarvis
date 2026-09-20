// The one request gate and push-sink lifecycle wiring the desktop app to
// `@jarvis/remote`'s bridge.
//
// `remoteRequestHandler` is the single place a phone's request is checked
// against the fail-closed policy (`isRemoteAllowed`, spec "Capability
// policy") before it ever reaches the dispatch table: a denied channel never
// touches the table at all, and the `Origin` every handler sees comes only
// from the bridge's own authenticated `device` argument — nothing in the
// request's own payload can widen or rename it.
//
// `createRemoteAccess` composes the bridge's lifecycle: before `start` there
// is no bridge yet, so every control answers its closed default rather than
// throwing or reaching for one; `start` and `apply` share one lazily-created
// bridge (a promise gate, `ensureBridge`) so a concurrent call never creates
// a second one; `apply` additionally waits for `start` itself (a second
// gate, `started`) so an `apply` that runs ahead of — or concurrently
// with — the first `start` always lands *after* `start`'s own initial
// `apply`, never racing it; `stop` sets a `stopped` flag first and awaits
// any bridge creation already in flight, so a `start`/`apply` that is still
// on its way to the bridge always finds `stopped` true once it gets there
// and returns without ever touching it; and the one push sink toward
// `broadcast` is added exactly once while `status().listening` is defined
// and removed the moment it is not — including on `stop()`, the M1
// carry-over that keeps a restart from ever double-sending a push.
import {
  createPushSender,
  type AuthenticatedDevice,
  type Bridge,
  type BridgeConfig,
  type BridgeDeps,
  type ExpoPushMessage,
  type FetchLike,
  type PairingResult,
  type PushSender,
  type RemoteStatus,
  type RequestHandler,
} from "@jarvis/remote";
import type { PushRegisterResult, PushRegistration } from "@jarvis/wire";
import type { Broadcaster } from "./broadcast.js";
import type { RemoteConfig } from "./config.js";
import type { DispatchTable, Handler, RemoteControls, SidecarPublisher } from "./dispatch.js";
import { MESSAGES } from "./messages.js";
import type { PushTarget } from "./notify.js";
import { blobLimitOf, type BlobTable } from "./remote-blob.js";
import {
  remoteKeyAuthorizer,
  remotePushPolicies,
  type StreamOwners,
} from "./remote-push-policy.js";
import { auditPolicyFor, CHANNEL_POLICY, isRemoteAllowed } from "./remote-policy.js";

const CLOSED_STATUS: RemoteStatus = {
  enabled: false,
  listening: undefined,
  pairing: { kind: "closed" },
  devices: [],
  problem: undefined,
  // M11 Task 2 minimal compile fix: the real gate value is Task 4's to
  // wire; "off" is the correct closed-bridge default regardless.
  sidecarProxy: "off",
};

/**
 * The one gate. `Object.hasOwn` throughout — against `CHANNEL_POLICY`, the
 * dispatch table and the blob table alike — so a channel named
 * "constructor" or "__proto__" can never read a value off a prototype
 * either way, and a policy-allowed channel that somehow has no table entry
 * answers "unknown-channel" rather than throwing.
 *
 * `blob` (M8 Task 4) is `undefined` for every ordinary `req` and defined
 * only for a completed upload (connection.ts's own byte-length check
 * already ran before `blobLimit` ever let the bytes accumulate — the
 * `blob.length <= maxBytes` check here is belt-and-braces, not the only
 * gate). A blob for a channel the blob table does not know, or one that
 * somehow arrives without a blob at all for a channel the blob table
 * *does* know, is always `forbidden` — a blob channel is never reachable
 * through the M4 `req` path, and a `req` (no blob) is never reachable
 * through the blob one.
 */
export function remoteRequestHandler(
  table: () => DispatchTable,
  blobs: () => BlobTable,
): RequestHandler {
  return async (channel, args, device: AuthenticatedDevice, blob?: Uint8Array) => {
    const remoteOrigin = { kind: "remote" as const, deviceId: device.id, deviceName: device.name };
    const blobTable = blobs();

    if (blob !== undefined) {
      if (Object.hasOwn(blobTable, channel)) {
        // Object.hasOwn just proved this key exists — the cast only strips
        // the `| undefined` noUncheckedIndexedAccess adds for an arbitrary
        // string index.
        const entry = blobTable[channel] as BlobTable[string];
        if (blob.length > entry.maxBytes) return { kind: "forbidden" as const };
        const value = await entry.handler(args, blob, remoteOrigin);
        return { kind: "value" as const, value };
      }
      return Object.hasOwn(CHANNEL_POLICY, channel)
        ? { kind: "forbidden" as const }
        : { kind: "unknown-channel" as const };
    }

    if (Object.hasOwn(blobTable, channel)) return { kind: "forbidden" as const };

    if (!isRemoteAllowed(channel)) {
      return Object.hasOwn(CHANNEL_POLICY, channel)
        ? { kind: "forbidden" as const }
        : { kind: "unknown-channel" as const };
    }
    const current = table();
    if (!Object.hasOwn(current, channel)) return { kind: "unknown-channel" as const };
    const handler = (current as Record<string, Handler>)[channel] as Handler;
    // The origin comes only from the bridge's own authenticated device —
    // never from `args`, however it happens to be shaped.
    const value = await handler(args, remoteOrigin);
    return { kind: "value" as const, value };
  };
}

export type RemoteAccessDeps = {
  table(): DispatchTable;
  blobs(): BlobTable;
  broadcast: Pick<Broadcaster, "addSink" | "local">;
  language: "ar" | "en";
  createBridge(deps: BridgeDeps): Promise<Bridge>;
  io: Omit<
    BridgeDeps,
    | "handle"
    | "policies"
    | "authorizeKey"
    | "blobLimit"
    | "errorText"
    | "auditPolicy"
    | "onStatus"
    | "onDeviceDisconnected"
    | "onIdleDisabled"
  >;
  // Backs remoteKeyAuthorizer's pane/session/docker-follower checks — real
  // ShellManager/SessionManager/DockerFollowers methods in main.ts.
  streams: StreamOwners;
  // Task 7 fills this in (DockerFollowers' own cleanup); a no-op here would
  // leave a disconnected phone's followers running forever, but wiring that
  // up is this dep's caller's job, not this file's.
  onDeviceDisconnected(deviceId: string): void;
  // M9 Task 3: fired only after `revoke()` below has actually revoked the
  // device (never on a plain disconnect, which is what onDeviceDisconnected
  // above is for) — file-upload.ts's UploadStore.revoke reclaims that
  // device's staged files and in-flight quota reservation on exactly this
  // signal. A device that merely drops its connection keeps its files for
  // their own TTL, so an explicit retry after a dropped socket still finds
  // them.
  onDeviceRevoked(deviceId: string): void;
  // M12 Task 2: fired from the bridge's own idle timer, never from a
  // phone's request and never through settings:save — main.ts's own
  // callback writes `remote.enabled = false` to jarvis.yaml through the
  // same serialized write queue Settings uses (remote-idle.ts). Required
  // here (unlike the bridge's own optional BridgeDeps.onIdleDisabled,
  // which packages/remote leaves optional for its own callers) because the
  // desktop always has a disk to write this to.
  onIdleDisabled(): void;
  // M10 Task 4: the Expo push sender's own outbound HTTP client — injected
  // exactly like `io`, so a test drives the whole send lifecycle with a
  // fake `fetch` and never a real socket.
  fetch: FetchLike;
};

export type RemoteAccess = RemoteControls & {
  start(config: RemoteConfig): Promise<void>;
  apply(config: RemoteConfig): Promise<void>;
  stop(): Promise<void>;
  /** Whether any connection currently subscribes to `channel` — main.ts's
   *  isAwake uses this to wake the metrics/changes ticks for a subscribed
   *  phone even while the window itself is hidden. False before the bridge
   *  has ever started (bridge is undefined — the same closed default every
   *  other control answers pre-start). */
  hasSubscriber(channel: string): boolean;
  /** dispatch.ts's SidecarPublisher — see publishSidecar's own comment,
   *  below, for what it does with the manager's loopback URL. */
  publishSidecar: SidecarPublisher["publish"];
  /** The last applied `RemoteConfig.push` — `{enabled:false,
   *  includeProjectNames:false}` before the first `apply`. */
  pushSettings(): { enabled: boolean; includeProjectNames: boolean };
  /** Every device with a registered token — empty before the bridge
   *  exists. */
  pushTargets(): PushTarget[];
  /** "Who is watching" a channel/key right now — empty before the bridge
   *  exists. */
  watchingDevices(channel: string, key?: string): ReadonlySet<string>;
  /** Enqueues `messages` on the Expo sender, or drops them (with a log
   *  line) when push is off or no sender exists yet. */
  sendPush(messages: ExpoPushMessage[]): void;
  /** M12 Task 3: records a queued push in the audit log — a no-op before
   *  the bridge exists (nothing was queued if there is nowhere to queue
   *  it). */
  recordPushQueued(deviceId: string, pushKind: string): void;
};

function toBridgeConfig(config: RemoteConfig): BridgeConfig {
  return {
    enabled: config.enabled,
    bindAddress: config.bindAddress,
    port: config.port,
    sidecarProxy: config.sidecarProxy,
    idleDisableMinutes: config.idleDisableMinutes,
    tls: {
      ...(config.tls.certPath !== undefined ? { certPath: config.tls.certPath } : {}),
      ...(config.tls.keyPath !== undefined ? { keyPath: config.tls.keyPath } : {}),
    },
  };
}

const DEFAULT_PUSH_SETTINGS = { enabled: false, includeProjectNames: false };

export function createRemoteAccess(deps: RemoteAccessDeps): RemoteAccess {
  let bridge: Bridge | undefined;
  // The promise gate: whichever of start()/apply() calls ensureBridge()
  // first sets this, every other caller awaits the same promise — so two
  // overlapping calls never create a second bridge.
  let creating: Promise<Bridge> | undefined;
  let removeSink: (() => void) | undefined;
  let stopped = false;
  // The last applied RemoteConfig.push — what pushSettings()/sendPush()
  // read, and what registerPush()'s laptopEnabled answers with.
  let currentPush: { enabled: boolean; includeProjectNames: boolean } = DEFAULT_PUSH_SETTINGS;
  // Built once, inside ensureBridge()'s own `.then` — a sender has nothing
  // to send until a bridge (and so a device store) exists.
  let sender: PushSender | undefined;

  // Resolves once start() has both obtained the bridge and applied its own
  // config to it. apply() awaits this before doing anything else, so it
  // always lands after start()'s own initial apply — never racing ahead of
  // it, and never calling ensureBridge() itself while start() might still
  // be the one creating the bridge. stop() also resolves this (if start()
  // never got there itself) so an apply() stuck waiting on a start() that
  // never finished — because stop() cut it off first — wakes up and sees
  // `stopped` rather than hanging forever.
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  function onStatus(status: RemoteStatus): void {
    // Always local (ruling 36): this window's renderer alone, never a
    // broadcast push — a paired phone has no channel that carries a
    // RemoteStatus at all ("remote:update" is desktop-only in
    // REMOTE_PUSH_POLICY, remote-push-policy.ts).
    deps.broadcast.local("remote:update", status);
    if (status.listening !== undefined && removeSink === undefined) {
      removeSink = deps.broadcast.addSink((channel, payload) => bridge?.push(channel, payload));
    } else if (status.listening === undefined && removeSink !== undefined) {
      removeSink();
      removeSink = undefined;
    }
  }

  function ensureBridge(): Promise<Bridge> {
    if (creating === undefined) {
      creating = deps
        .createBridge({
          ...deps.io,
          handle: remoteRequestHandler(deps.table, deps.blobs),
          policies: remotePushPolicies(),
          authorizeKey: remoteKeyAuthorizer(deps.streams),
          blobLimit: (channel) => blobLimitOf(deps.blobs(), channel),
          errorText: (code) => ({
            text: MESSAGES.remoteErrorText(code, deps.language),
            language: deps.language,
          }),
          // M12 Task 3, rule 9: the desktop's own classifier, over the
          // *current* blob table — `deps.blobs()` is read fresh on every
          // call, the same as `blobLimit` above.
          auditPolicy: (channel) => auditPolicyFor(channel, (c) => Object.hasOwn(deps.blobs(), c)),
          onStatus,
          onDeviceDisconnected: deps.onDeviceDisconnected,
          onIdleDisabled: deps.onIdleDisabled,
        })
        .then((created) => {
          bridge = created;
          // M10 Task 4: onUnregistered gets only the dead token — it looks
          // up which device that was itself, and a miss (the device was
          // already cleared, or revoked, since this token last sent)
          // is a no-op with a log line carrying no token.
          sender = createPushSender({
            fetch: deps.fetch,
            now: deps.io.now,
            timers: deps.io.timers,
            log: deps.io.log,
            onUnregistered: (token) => {
              const target = created.pushTargets().find((candidate) => candidate.token === token);
              if (target === undefined) {
                deps.io.log("push: onUnregistered for an already-cleared token");
                return;
              }
              void created.clearPushToken(target.deviceId, "not-registered");
            },
          });
          return created;
        });
    }
    return creating;
  }

  async function start(config: RemoteConfig): Promise<void> {
    if (stopped) return;
    // I6: `finally`, not a trailing call after `await` — a rejected
    // ensureBridge()/apply() (a bad certificate, a bind failure) must still
    // resolve `started`, or every apply() queued behind it (this call and
    // every later one) would hang forever rather than ever retrying.
    try {
      const b = await ensureBridge();
      if (stopped) return;
      currentPush = config.push;
      await b.apply(toBridgeConfig(config));
    } finally {
      resolveStarted?.();
    }
  }

  async function applyConfig(config: RemoteConfig): Promise<void> {
    if (stopped) return;
    await started;
    if (stopped) return;
    const b = await ensureBridge();
    if (stopped) return;
    currentPush = config.push;
    await b.apply(toBridgeConfig(config));
  }

  // Task 4 rule 1: parses the manager's own loopback URL, forwards only
  // `{ kind, port, basicAuth }` to the bridge — never the path or query,
  // which stay on this side of the wire and are recombined with the
  // bridge's fixed `/s/<handle>/?k=<key>` answer below (ruling 7) — and
  // turns that path-only answer into the absolute https URL the phone
  // actually loads. `bridge.publishSidecar` already guarantees a
  // successful `{ url }` only when `listening.certificate.hostname` is
  // defined (bridge.ts's own gate), so the `needs-certificate` fallback
  // here is defence in depth, never the path a correctly wired bridge
  // takes.
  const publishSidecar: SidecarPublisher["publish"] = (deviceId, target) => {
    let parsed: URL;
    try {
      parsed = new URL(target.url);
    } catch {
      return { ok: false, reason: "bad-target" };
    }
    // `URL.port` is `""` for the scheme's default port (e.g.
    // `http://127.0.0.1:80/`), and `Number("")` is `0` — already caught by
    // `port < 1` below. Deliberate: every manager here (code-server,
    // dbgate-serve, headlamp-server) always spawns on an ephemeral port, so
    // a manager URL that omits the port is not a shape this code ever
    // expects to see, not something worth a default for.
    const port = Number(parsed.port);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      return { ok: false, reason: "bad-target" };
    }
    if (bridge === undefined) return { ok: false, reason: "not-listening" };

    const published = bridge.publishSidecar(deviceId, {
      kind: target.kind,
      port,
      ...(target.basicAuth !== undefined ? { basicAuth: target.basicAuth } : {}),
    });
    if ("unavailable" in published) return { ok: false, reason: published.unavailable };

    const listening = bridge.status().listening;
    if (listening === undefined || listening.certificate.hostname === undefined) {
      return { ok: false, reason: "needs-certificate" };
    }

    // `published.url` is always exactly `/s/<handle>/?k=<key>`
    // (sidecar-registry.ts's own publish()) — parsed rather than
    // string-sliced so a change to that shape fails loudly here (an empty
    // `handle`/`key` refuses the publish below) instead of silently
    // composing `https://host:port/s//…?k=` for the phone.
    const registryUrl = new URL(published.url, "http://sidecar.invalid");
    const handle = registryUrl.pathname.split("/")[2];
    const key = registryUrl.searchParams.get("k");
    if (handle === undefined || handle === "" || key === null || key === "") {
      return { ok: false, reason: "not-listening" };
    }

    // Ruling 7: the sidecar's own pathname replaces the registry URL's
    // trailing "/", `k` is appended to the sidecar's own query (or becomes
    // the whole query, if it had none), and the sidecar's own fragment
    // rides along last, untouched.
    const query = parsed.search === "" ? `?k=${key}` : `${parsed.search}&k=${key}`;
    const url = `https://${listening.certificate.hostname}:${listening.port}/s/${handle}${parsed.pathname}${query}${parsed.hash}`;
    return { ok: true, url };
  };

  return {
    status: () => bridge?.status() ?? CLOSED_STATUS,
    async openPairing(): Promise<PairingResult> {
      return bridge === undefined ? "unavailable" : bridge.openPairing();
    },
    cancelPairing(): void {
      bridge?.cancelPairing();
    },
    decidePairing(requestId: string, approve: boolean): boolean {
      return bridge?.decidePairing(requestId, approve) ?? false;
    },
    async revoke(deviceId: string): Promise<boolean> {
      if (bridge === undefined) return false;
      const ok = await bridge.revoke(deviceId);
      // Only a real revoke fires this — never a disconnect, and never a
      // revoke() call that found no bridge or no such device to revoke.
      if (ok) deps.onDeviceRevoked(deviceId);
      return ok;
    },
    hasSubscriber(channel: string): boolean {
      return bridge?.hasSubscriber(channel) ?? false;
    },
    publishSidecar,
    pushSettings: () => currentPush,
    pushTargets: () => bridge?.pushTargets() ?? [],
    watchingDevices: (channel, key) => bridge?.watchingDevices(channel, key) ?? new Set(),
    sendPush(messages: ExpoPushMessage[]): void {
      if (!currentPush.enabled || sender === undefined) {
        deps.io.log(`push: dropped n=${messages.length} (disabled or not listening)`);
        return;
      }
      for (const message of messages) sender.enqueue(message);
    },
    recordPushQueued(deviceId: string, pushKind: string): void {
      bridge?.recordPushQueued(deviceId, pushKind);
    },
    async registerPush(
      deviceId: string,
      registration: PushRegistration,
    ): Promise<PushRegisterResult> {
      if (bridge === undefined) {
        return {
          registered: false,
          text: MESSAGES.pushRegisterInvalid(deps.language),
          language: deps.language,
        };
      }
      const result = await bridge.setPushToken(deviceId, registration);
      if (result === "ok") return { registered: true, laptopEnabled: currentPush.enabled };
      return {
        registered: false,
        text: MESSAGES.pushRegisterInvalid(deps.language),
        language: deps.language,
      };
    },
    async unregisterPush(deviceId: string): Promise<void> {
      if (bridge === undefined) return;
      await bridge.clearPushToken(deviceId, "unregistered");
    },
    start,
    apply: applyConfig,
    async stop(): Promise<void> {
      stopped = true;
      // Unblocks any apply() still waiting on start(): whether or not
      // start() itself ever got there, apply() wakes up, sees `stopped`,
      // and returns without ever touching the bridge.
      resolveStarted?.();
      if (creating !== undefined) {
        // start()/apply() may already be on their way to a bridge that
        // hasn't finished creating yet — wait for it so it can be stopped
        // properly rather than left dangling. A createBridge() that itself
        // rejects leaves nothing to stop.
        try {
          await creating;
        } catch {
          // Nothing to stop.
        }
      }
      // Before the bridge itself: a queued or in-flight send must not
      // outlive stop() (rule: "sender.stop() observable as no fetch after
      // a queued message").
      sender?.stop();
      if (bridge !== undefined) await bridge.stop();
      // Idempotent, and a belt-and-braces removal even though a listener
      // shutdown already drives `onStatus` with `listening: undefined`
      // above — nothing here may leave the sink attached after `stop()`.
      if (removeSink !== undefined) {
        removeSink();
        removeSink = undefined;
      }
    },
  };
}
