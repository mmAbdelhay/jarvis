// The Jarvis phone bridge inside Rafiq's jarvisd (design §3.3, contracts §5.9): the same
// @jarvis/remote bridge as the Jarvis app — TLS 1.3 with pinning, owner
// login, pairing — composed with the OS phone policy (phone-policy.ts) and
// the OS channel router. Pairing is answered from a shell card
// (pairing:pending → pairing:answer). The phone settings channels
// (remote:*, pairing:open/cancel) are local-only.
//
// No electron here (core/no-electron.test.ts).
import { CONTROL_TEXT, type Lang } from "@jarvis/core";
import type { Bridge, BridgeDeps, RemoteStatus } from "@jarvis/remote";
import {
  OS_CONTROL_PUSHES,
  type OsRemoteStatus,
  type OwnerPasswordRequest,
  type OwnerPasswordResult,
  type PairingAnswer,
  type PairingOpenResult,
  type PairingPending,
  type RemoteConfigureRequest,
} from "@jarvis/wire";
import { OsAgentError } from "./agent-service.js";
import { type OsRouter, phoneDeviceName } from "./os-binding.js";
import {
  createPhoneRequestHandler,
  PHONE_BLOBS,
  PHONE_PUSHES,
  phoneAuditPolicy,
  phoneErrorText,
} from "./phone-policy.js";
import { DEFAULT_OS_REMOTE, type OsRemoteConfig, toBridgeConfig } from "./remote-config.js";

export type OsRemoteControls = {
  status(): OsRemoteStatus;
  configure(request: RemoteConfigureRequest): Promise<OsRemoteStatus>;
  setOwnerPassword(request: OwnerPasswordRequest): Promise<OwnerPasswordResult>;
  openPairing(): Promise<PairingOpenResult>;
  cancelPairing(): null;
  answerPairing(answer: PairingAnswer): null;
  revoke(deviceId: string): Promise<{ revoked: boolean }>;
};

export type OsRemote = OsRemoteControls & {
  start(): Promise<void>;
  forward(channel: string, payload: unknown): void;
  resync(): void;
  stop(): Promise<void>;
};

export type OsRemoteDeps = {
  language(): Lang;
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
    | "notifyDesktop"
  >;
  router(): OsRouter;
  readConfig(): Promise<OsRemoteConfig>;
  writeConfig(patch: RemoteConfigureRequest): Promise<void>;
  push(channel: string, payload: unknown): void;
  log(line: string): void;
};

const CLOSED: OsRemoteStatus = {
  enabled: false,
  listening: null,
  pairing: "closed",
  devices: [],
  hasOwnerPassword: false,
  problem: null,
};

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function toOsRemoteStatus(status: RemoteStatus, hasOwnerPassword: boolean): OsRemoteStatus {
  return {
    enabled: status.enabled,
    listening:
      status.listening === undefined
        ? null
        : {
            host: status.listening.host,
            port: status.listening.port,
            fingerprint: status.listening.fingerprint,
          },
    pairing: status.pairing.kind,
    devices: status.devices.map((device) => ({
      id: device.id,
      name: phoneDeviceName(device.name),
      connected: device.connected,
      lastSeenAt: device.lastSeenAt ?? null,
    })),
    hasOwnerPassword,
    problem: status.problem ?? null,
  };
}

function pendingOf(
  pairing: Extract<RemoteStatus["pairing"], { kind: "confirming" }>,
): PairingPending {
  return {
    deviceName: phoneDeviceName(pairing.deviceName),
    requestId: pairing.requestId,
    address: pairing.address,
    expiresAt: pairing.expiresAt,
  };
}

export function createOsRemote(deps: OsRemoteDeps): OsRemote {
  let bridge: Bridge | undefined;
  let lastStatus = "";
  let lastPending: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  /** One config change at a time, in order. */
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  function current(): OsRemoteStatus {
    return bridge === undefined
      ? CLOSED
      : toOsRemoteStatus(bridge.status(), bridge.ownerStatus().hasPassword);
  }

  function onStatus(status: RemoteStatus): void {
    const next = toOsRemoteStatus(status, bridge?.ownerStatus().hasPassword ?? false);
    const text = JSON.stringify(next);
    if (text !== lastStatus) {
      lastStatus = text;
      deps.push(OS_CONTROL_PUSHES.remoteStatus, next);
    }
    const pairing = status.pairing;
    if (pairing.kind !== "confirming") {
      lastPending = undefined;
      return;
    }
    if (pairing.requestId === lastPending) return;
    lastPending = pairing.requestId;
    deps.push(OS_CONTROL_PUSHES.pairingPending, pendingOf(pairing));
  }

  function need(): Bridge {
    if (bridge === undefined)
      throw new OsAgentError("unsupported", CONTROL_TEXT[deps.language()].remoteOff);
    return bridge;
  }

  async function applyFromDisk(target: Bridge): Promise<void> {
    let config: OsRemoteConfig;
    try {
      config = await deps.readConfig();
    } catch (error) {
      deps.log(
        `[phone] jarvis.yaml remote: is not usable, phone access stays off: ${describe(error)}`,
      );
      config = { ...DEFAULT_OS_REMOTE, tls: {} };
    }
    await target.apply(toBridgeConfig(config));
  }

  return {
    async start() {
      bridge = await deps.createBridge({
        ...deps.io,
        handle: createPhoneRequestHandler(deps.router, deps.log),
        policies: PHONE_PUSHES,
        // No keyed subscriptions exist on the OS surface.
        authorizeKey: () => false,
        blobLimit: (channel) => PHONE_BLOBS.get(channel),
        errorText: phoneErrorText,
        auditPolicy: phoneAuditPolicy,
        onStatus,
        onDeviceDisconnected: () => {},
        onIdleDisabled: () => {
          serial(() => deps.writeConfig({ enabled: false })).catch((error: unknown) => {
            deps.log(`[phone] could not record the idle auto-off: ${describe(error)}`);
          });
        },
      });
      await applyFromDisk(bridge);
      onStatus(bridge.status());
    },

    forward(channel, payload) {
      if (PHONE_PUSHES.has(channel)) bridge?.push(channel, payload);
    },

    status: current,

    configure(request) {
      return serial(async () => {
        const target = need();
        await deps.writeConfig(request);
        await applyFromDisk(target);
        return current();
      });
    },

    async setOwnerPassword(request) {
      const result = await need().setOwnerPassword(request.current, request.next);
      onStatus(need().status());
      return result.ok ? { ok: true } : { ok: false, code: result.code };
    },

    async openPairing() {
      const target = need();
      const opened = await target.openPairing();
      const pairing = target.status().pairing;
      if (opened !== "opened" || pairing.kind !== "open") {
        throw new OsAgentError("unsupported", CONTROL_TEXT[deps.language()].pairingUnavailable);
      }
      return { uri: pairing.uri, expiresAt: pairing.expiresAt };
    },

    cancelPairing() {
      bridge?.cancelPairing();
      return null;
    },

    answerPairing(answer) {
      const pairing = need().status().pairing;
      if (pairing.kind !== "confirming") {
        throw new OsAgentError("bad-request", CONTROL_TEXT[deps.language()].noPairingRequest);
      }
      if (answer.requestId !== pairing.requestId) {
        throw new OsAgentError("bad-request", CONTROL_TEXT[deps.language()].pairingChanged);
      }
      need().decidePairing(pairing.requestId, answer.approve);
      return null;
    },

    async revoke(deviceId) {
      return { revoked: await need().revoke(deviceId) };
    },

    resync() {
      deps.push(OS_CONTROL_PUSHES.remoteStatus, current());
      const pairing = bridge?.status().pairing;
      if (pairing?.kind === "confirming")
        deps.push(OS_CONTROL_PUSHES.pairingPending, pendingOf(pairing));
    },

    async stop() {
      await bridge?.stop();
    },
  };
}
