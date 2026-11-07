// The test double for many machines (no tests live in this file itself): the
// real machine store, clients, connection stores and auth sessions over fake
// keychains, a fake transport and a fake clock, so a test sees what really
// lands under each machine's keys. Three machines: A in the legacy slot, B and
// C with keys of their own, each with a stored refresh token.

import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { createFakeClock } from "./clock";
import { type FakeSocket, createFakeTransport } from "./fake-transport";
import { MACHINE_INDEX_KEY, type MachineId } from "./machine-index";
import {
  type MachineScope,
  type MachineSessions,
  createMachineScopeBuilder,
  createMachineSessions,
  unpairedHandlerFor,
} from "./machine-sessions";
import { type MachineStore, createMachineStore } from "./machine-store";
import type { PairingRecord } from "./pairing-record";
import type { PrefsStore } from "./prefs";
import type { SecureStore } from "./secure-store";

export const A_ID = "192.168.1.5_4317";
export const B_ID = "mac.tail.ts.net_7717";
export const C_ID = "other.tail.ts.net_7717";
export const IDLE_MS = 15 * 60_000;
export const ACCESS_TTL_MS = 15 * 60_000;

const HOSTS: Record<string, string> = {
  [A_ID]: "192.168.1.5",
  [B_ID]: "mac.tail.ts.net",
  [C_ID]: "other.tail.ts.net",
};

export class FakeKeychain implements SecureStore {
  values = new Map<string, string>();
  sets: string[] = [];
  failGet?: (key: string) => boolean;
  failSet?: (key: string) => boolean;
  failDelete?: (key: string) => boolean;

  get(key: string): Promise<string | undefined> {
    if (this.failGet?.(key) === true) return Promise.reject(new Error("keychain read failed"));
    return Promise.resolve(this.values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    if (this.failSet?.(key) === true) return Promise.reject(new Error("keychain write failed"));
    this.sets.push(key);
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    if (this.failDelete?.(key) === true) return Promise.reject(new Error("keychain delete failed"));
    this.values.delete(key);
    return Promise.resolve();
  }
}

export class FakePrefsFile implements PrefsStore {
  constructor(public text?: string) {}
  read(): Promise<string | undefined> {
    return Promise.resolve(this.text);
  }
  write(text: string): Promise<void> {
    this.text = text;
    return Promise.resolve();
  }
}

export function recordOf(id: MachineId): PairingRecord {
  if (id === A_ID) {
    return {
      deviceId: "a".repeat(32),
      host: "192.168.1.5",
      port: 4317,
      fingerprint: "f".repeat(64),
      pairedAt: 1_700_000_000_000,
    };
  }
  return {
    deviceId: (id === B_ID ? "b" : "c").repeat(32),
    host: "0.0.0.0",
    port: 7717,
    fingerprint: "0".repeat(64),
    name: HOSTS[id] as string,
    pairedAt: 1_700_000_000_000,
  };
}

function tokenOf(id: MachineId): string {
  return (id === A_ID ? "A" : id === B_ID ? "B" : "C").repeat(43);
}

function prefixOf(id: MachineId): string {
  return id === A_ID ? "jarvis" : `jarvis.m.${id}`;
}

export function refreshKeyOf(id: MachineId): string {
  return `${prefixOf(id)}.refresh`;
}

export function refreshTokenOf(id: MachineId): string {
  return `stored-${id}`;
}

/** The keychains and prefs of a phone holding `ids`, with `active` active. */
export function seedPhone(ids: MachineId[] = [A_ID, B_ID, C_ID], active?: MachineId) {
  const secure = new FakeKeychain();
  const refresh = new FakeKeychain();
  const machineFlags: Record<string, object> = {};
  for (const id of ids) {
    const record = JSON.stringify(recordOf(id));
    const prefix = prefixOf(id);
    secure.values.set(`${prefix}.pairing`, record);
    secure.values.set(`${prefix}.token`, tokenOf(id));
    refresh.values.set(refreshKeyOf(id), refreshTokenOf(id));
    if (id !== A_ID) machineFlags[id] = { refreshTokenStored: true, pushRegistered: false };
  }
  if (ids.length > 0) {
    secure.values.set(
      MACHINE_INDEX_KEY,
      JSON.stringify({
        v: 1,
        ids,
        active: active ?? ids[0],
        ...(ids.includes(A_ID) ? { legacy: A_ID } : {}),
      }),
    );
  }
  const prefs = new FakePrefsFile(
    JSON.stringify({ refreshTokenStored: ids.includes(A_ID), machineFlags }),
  );
  return { secure, refresh, prefs };
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets everything already queued run: keychain fakes, the store's queue. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function frames(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
}

export function requestsOn(socket: FakeSocket, channel: string): Array<Record<string, unknown>> {
  return frames(socket).filter((frame) => frame.t === "req" && frame.ch === channel);
}

export function welcome(socket: FakeSocket): void {
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: [] }),
  });
}

export function answer(socket: FakeSocket, channel: string, value: unknown): void {
  const requests = requestsOn(socket, channel);
  const id = requests[requests.length - 1]?.id as number;
  socket.emit({ kind: "message", text: encodeMessage({ t: "res", id, v: value }) });
}

export function tokenReply(fill: string, expiresAt: number) {
  return {
    accessToken: fill.repeat(64),
    refreshToken: `${fill.repeat(63)}f`,
    accessExpiresAt: expiresAt,
  };
}

export type MachinesHarness = ReturnType<typeof machinesHarness>;

export function machinesHarness(options: { ids?: MachineId[]; active?: MachineId } = {}) {
  const { secure, refresh, prefs } = seedPhone(options.ids, options.active);
  const transport = createFakeTransport();
  const clock = createFakeClock();
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  /** The switch's steps, as they happen. */
  const events: string[] = [];
  const device = {
    passcode: true,
    prompts: 0,
    answer: Promise.resolve(true) as Promise<boolean>,
  };
  const routes: string[] = [];
  const built: Array<MachineId | null> = [];
  let prepareSwitch: () => void = () => {
    events.push("prepare");
  };

  const realStore = createMachineStore({
    secure,
    refresh,
    prefs,
    localeTag: "en-US",
    singleSlot: false,
    log,
  });
  const store: MachineStore = {
    ...realStore,
    setActive(id) {
      events.push(`setActive ${id}`);
      return realStore.setActive(id);
    },
  };

  const build = createMachineScopeBuilder({
    store,
    refreshStore: refresh,
    transport,
    clock,
    random: () => 0.5,
    client: "jarvis-mobile/1.0.0/ios",
    deviceAuth: {
      hasPasscode: async () => device.passcode,
      authenticate: () => {
        device.prompts += 1;
        return device.answer;
      },
    },
    idleMs: IDLE_MS,
    onUnpaired: (id) =>
      unpairedHandlerFor({
        id,
        sessions,
        navigateToPair: () => routes.push("/pair"),
        log,
      })(),
    log,
  });

  const sessions: MachineSessions = createMachineSessions({
    store,
    buildScope(id) {
      built.push(id);
      const scope = build(id);
      const { client, authSession } = scope;
      const { connect, disconnect } = client;
      client.connect = (endpoint, credential) => {
        events.push(`connect ${id}`);
        connect(endpoint, credential);
      };
      client.disconnect = () => {
        events.push(`disconnect ${id}`);
        disconnect();
      };
      const { quiesce } = authSession;
      authSession.quiesce = (ms) => {
        events.push(`quiesce ${id}`);
        return quiesce(ms);
      };
      return scope;
    },
    prepareSwitch: () => prepareSwitch(),
    log,
  });
  const published: MachineScope[] = [];
  sessions.subscribe((scope) => {
    events.push(`publish ${scope.id}`);
    published.push(scope);
  });

  function socketsOf(id: MachineId): FakeSocket[] {
    return transport.sockets.filter((socket) => socket.url.includes(HOSTS[id] as string));
  }

  /** The newest socket `id` opened. */
  function socketOf(id: MachineId): FakeSocket {
    const sockets = socketsOf(id);
    return sockets[sockets.length - 1] as FakeSocket;
  }

  /** The active machine, unlocked with a password over its welcomed socket. */
  async function unlockCurrent(fill = "1"): Promise<MachineScope> {
    const scope = sessions.current();
    const socket = socketOf(scope.id as MachineId);
    welcome(socket);
    const unlocking = scope.authSession.unlockWithPassword("pw");
    await settle();
    answer(socket, "auth:login", tokenReply(fill, clock.now() + ACCESS_TTL_MS));
    await unlocking;
    await settle();
    return scope;
  }

  /** Started on `active`, with the launch's steps forgotten. */
  async function start(): Promise<MachineScope> {
    await sessions.start();
    events.length = 0;
    return sessions.current();
  }

  return {
    secure,
    refresh,
    prefs,
    store,
    realStore,
    transport,
    clock,
    logs,
    events,
    device,
    routes,
    built,
    sessions,
    published,
    socketsOf,
    socketOf,
    unlockCurrent,
    start,
    setPrepareSwitch(fn: () => void) {
      prepareSwitch = fn;
    },
  };
}

export async function flagsOf(prefs: FakePrefsFile) {
  const parsed = JSON.parse(prefs.text ?? "{}") as {
    refreshTokenStored?: boolean;
    machineFlags?: Record<string, { refreshTokenStored: boolean }>;
  };
  return parsed;
}
