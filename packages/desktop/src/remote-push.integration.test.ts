// M10 Task 7's laptop-side end-to-end scenario: a real `createConnection`
// (@jarvis/remote) over an injected `SocketLike` double, wired to a real
// `createDispatchTable`, a real `createRemoteAccess` and a real
// `createNotifier` — the same "everything real but the socket, the
// third-party HTTP boundary and the bridge's own persistence" scope
// remote-voice.integration.test.ts and remote-workspace.integration.test.ts
// already established for their own pieces.
//
// `createRemoteAccess`'s own `createBridge` dependency is a fake here
// (implementer's choice, per the brief) rather than the real
// `@jarvis/remote` `createBridge` over `fs-double`/`socket-double`: those
// two test doubles are internal to `packages/remote/src` and are not
// re-exported from its package root (only `createConnection` itself is, for
// exactly this file's own reason — see index.ts's comment on that export),
// so reaching them from `packages/desktop` would mean reimplementing them
// rather than reusing the real ones. The fake bridge below reproduces only
// the exact surface `createRemoteAccess`/the push scenario actually touches
// (`setPushToken`/`clearPushToken`/`pushTargets`, a self-authored
// push-registered/push-cleared audit trail, and `watchingDevices` — which
// answers from the *real* `Connection.subscribes()` state of every device
// connected through this file's own `createConnection` calls, not a second,
// disconnected bookkeeping structure) — everything else about a phone's
// request (policy gating, dispatch, the wire's req/res/err/sub frames) is
// the real, unmodified production path.
import type { AuthenticatedDevice, Bridge, BridgeDeps, SocketLike } from "@jarvis/remote";
import {
  createConnection,
  EXPO_PUSH_URL,
  PROTOCOL_VERSION,
  PUSH_FLUSH_MS,
  PUSH_TTL_SECONDS,
} from "@jarvis/remote";
import type { Session } from "@jarvis/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBroadcaster } from "./broadcast.js";
import type { RemoteConfig } from "./config.js";
import { createDispatchTable } from "./dispatch.js";
import { fakeDeps } from "./dispatch.test.js";
import { MESSAGES } from "./messages.js";
import { createNotifier, NOTIFY_COALESCE_MS, type NotifierDeps } from "./notify.js";
import { createRemoteAccess, remoteRequestHandler } from "./remote-access.js";
import type { BlobTable } from "./remote-blob.js";
import {
  remoteKeyAuthorizer,
  remotePushPolicies,
  type StreamOwners,
} from "./remote-push-policy.js";

const D1: AuthenticatedDevice = { id: "d".repeat(32), name: "Phone" };
const D1_TOKEN = "T".repeat(43);
const EXPO_TOKEN = `ExponentPushToken[${"a".repeat(20)}]`;
// A second paired device, used only in step 5 to prove a DeviceNotRegistered
// ticket clears exactly the one dead token, never every registered device.
const D2: AuthenticatedDevice = { id: "e".repeat(32), name: "Phone 2" };
const D2_TOKEN = "U".repeat(43);
const EXPO_TOKEN_2 = `ExponentPushToken[${"b".repeat(20)}]`;

/** Mirrors packages/remote/src/socket-double.ts (not exported from
 *  @jarvis/remote's package root) — the same pattern
 *  remote-voice.integration.test.ts already uses for a piece of the bridge
 *  internals a desktop test needs. */
class FakeSocket implements SocketLike {
  sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | undefined;
  terminated = false;
  bufferedAmount = 0;
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  terminate(): void {
    this.terminated = true;
  }
}

function reqFrame(id: number, ch: string, a: unknown[] = []): string {
  return JSON.stringify({ t: "req", id, ch, a });
}
function helloFrame(deviceId: string, token: string): string {
  return JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, deviceId, token, client: "test/1.0" });
}
function subFrame(add: { ch: string; key: string }[]): string {
  return JSON.stringify({ t: "sub", add });
}
function resFor(socket: FakeSocket, id: number): Record<string, unknown> | undefined {
  return socket.sent.find((m) => m.t === "res" && m.id === id);
}
function errFor(socket: FakeSocket, id: number): Record<string, unknown> | undefined {
  return socket.sent.find((m) => m.t === "err" && m.id === id);
}

/** vitest's fake timers also flush the microtask queue between steps, which
 *  is what lets a plain `await tick()` settle the async chain a `req`
 *  triggers inside connection.ts even though no real timer is involved. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Same fixture shape as notify.test.ts's own `fakeSessions()` — a minimal
 *  SessionManager double whose `setState` drives `onChange` synchronously,
 *  which is all `createNotifier` needs. */
function fakeSessions(): { api: NotifierDeps["sessions"]; setState(next: Session): void } {
  let changeListeners: ((list: Session[]) => void)[] = [];
  const byId = new Map<string, Session>();
  const api: NotifierDeps["sessions"] = {
    onChange(listener) {
      changeListeners.push(listener);
      return () => {
        changeListeners = changeListeners.filter((l) => l !== listener);
      };
    },
    onOutput() {
      return () => {};
    },
    get(id) {
      return byId.get(id);
    },
    log() {
      return "";
    },
    list() {
      return [...byId.values()];
    },
  };
  function setState(next: Session): void {
    byId.set(next.id, next);
    for (const listener of [...changeListeners]) listener([...byId.values()]);
  }
  return { api, setState };
}

function session(
  id: string,
  state: Session["state"],
  project: string | null,
  summary: string,
  exitCode?: number,
): Session {
  return {
    id,
    project,
    projectPath: "/p",
    agentId: "a",
    state,
    summary,
    startedAt: 0,
    lastActivityAt: 0,
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

/** The fake bridge's own push-registration store: a plain map plus a
 *  self-authored audit trail (this file never touches the real bridge's own
 *  `audit.log` — see the header comment on why the real `createBridge` over
 *  `fs-double` is out of reach from `packages/desktop`). */
function createFakePushBridge(): {
  bridge: Bridge;
  auditLines: string[];
  connections: Map<string, ReturnType<typeof createConnection>>;
} {
  type Registered = { token: string; platform: "ios" | "android"; language: "ar" | "en" };
  const registered = new Map<string, Registered>();
  const auditLines: string[] = [];
  const connections = new Map<string, ReturnType<typeof createConnection>>();

  const bridge: Bridge = {
    apply: async () => {},
    openPairing: async () => "opened" as const,
    cancelPairing: () => {},
    decidePairing: () => true,
    revoke: async () => true,
    publishSidecar: () => ({ unavailable: "off" as const }),
    async setPushToken(deviceId, push) {
      registered.set(deviceId, push);
      auditLines.push(`push-registered device=${deviceId} platform=${push.platform}`);
      return "ok" as const;
    },
    async clearPushToken(deviceId, reason) {
      const had = registered.delete(deviceId);
      if (had) auditLines.push(`push-cleared device=${deviceId} reason=${reason}`);
      return had;
    },
    pushTargets() {
      return [...registered.entries()].map(([deviceId, p]) => ({ deviceId, ...p }));
    },
    recordPushQueued(deviceId, pushKind) {
      auditLines.push(`push-queued device=${deviceId} kind=${pushKind}`);
    },
    watchingDevices(channel, key) {
      const result = new Set<string>();
      for (const [deviceId, connection] of connections) {
        if (connection.device !== undefined && connection.subscribes(channel, key)) {
          result.add(deviceId);
        }
      }
      return result;
    },
    push() {},
    hasSubscriber: () => false,
    status: () => ({
      enabled: false,
      listening: undefined,
      pairing: { kind: "closed" },
      devices: [],
      problem: undefined,
      sidecarProxy: "off",
    }),
    stop: async () => {},
  };

  return { bridge, auditLines, connections };
}

function remoteConfig(push: { enabled: boolean; includeProjectNames: boolean }): RemoteConfig {
  return {
    enabled: true,
    bindAddress: "127.0.0.1",
    port: 7717,
    sidecarProxy: false,
    tls: {},
    push,
    idleDisableMinutes: 0,
  };
}

describe("remote-push.integration: laptop, everything real but the socket, the Expo HTTP boundary and the bridge's own persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("authenticates, registers, pushes generic payloads only while unwatched/unfocused/enabled, clears on DeviceNotRegistered, and gates every desktop-only channel", async () => {
    vi.useFakeTimers();

    const connectionLogLines: string[] = [];
    const ioLogLines: string[] = [];
    const notifyLogLines: string[] = [];
    const fetchCalls: { url: string; body: string }[] = [];
    // Each override sees the actual messages in that call's own batch (not
    // just a fixed shape), so step 5 can answer per-token — DeviceNotRegistered
    // for exactly one device's message, ok for the other's, regardless of
    // which order the sender happened to batch them in.
    const fetchOverrides: ((messages: { to: string }[]) => {
      status: number;
      json(): Promise<unknown>;
    })[] = [];

    const fetchLike = vi.fn(async (url: string, init: { body: string }) => {
      fetchCalls.push({ url, body: init.body });
      const messages = JSON.parse(init.body) as { to: string }[];
      const override = fetchOverrides.shift();
      if (override !== undefined) return override(messages);
      return {
        status: 200,
        async json() {
          return {
            data: messages.map((_m, i) => ({
              status: "ok",
              id: `ticket-${fetchCalls.length}-${i}`,
            })),
          };
        },
      };
    });

    const { bridge: fakeBridge, auditLines, connections } = createFakePushBridge();
    const broadcast = createBroadcaster({ toRenderer: vi.fn() });

    const sessionsFixture = fakeSessions();
    let focused = false;

    // Assigned once createRemoteAccess exists below; read only from
    // table()'s closure, which nothing calls before then.
    let remoteAccess!: ReturnType<typeof createRemoteAccess>;

    const table = () =>
      createDispatchTable(
        fakeDeps({
          remote: remoteAccess,
          notifier: { commandFinished: notifier.commandFinished },
          language: "en",
        }),
      );
    const blobs = () => ({}) as BlobTable;

    const streams: StreamOwners = {
      hasPane: () => false,
      hasSession: (id) => id === "s1",
      followerOwner: () => undefined,
    };

    remoteAccess = createRemoteAccess({
      table,
      blobs,
      broadcast,
      language: "en",
      createBridge: async (_deps: BridgeDeps) => fakeBridge,
      io: {
        dir: "/tmp/remote",
        fs: {} as never,
        random: (() => Buffer.alloc(0)) as never,
        now: () => Date.now(),
        timers: {
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
        listen: (async () => ({ port: 0, close: async () => {} })) as never,
        loadCertificate: async () => ({
          cert: "",
          key: "",
          fingerprint: "",
          source: "self-signed" as const,
          dnsNames: [],
        }),
        createProxy: () => undefined,
        enforceFileModes: false,
        log: (line: string) => ioLogLines.push(line),
      },
      streams,
      onDeviceDisconnected: vi.fn(),
      onDeviceRevoked: vi.fn(),
      onIdleDisabled: vi.fn(),
      fetch: fetchLike,
    });

    const notifier = createNotifier({
      sessions: sessionsFixture.api,
      onTurn: () => () => {},
      context: () => ({
        ...remoteAccess.pushSettings(),
        focused,
        targets: remoteAccess.pushTargets(),
        watching: remoteAccess.watchingDevices,
      }),
      send: (messages) => remoteAccess.sendPush(messages),
      // Same wiring as main.ts: every queued push gets one audit line via
      // the bridge's own recordPushQueued — never the token, title, body or
      // project. This asserts only the (deviceId, pushKind) arguments the
      // desktop passes; audit.ts rendering is covered by remote's own tests.
      audit: (entries) => {
        for (const e of entries) remoteAccess.recordPushQueued(e.deviceId, e.kind);
      },
      now: () => Date.now(),
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      log: (line) => notifyLogLines.push(line),
    });

    // Bridge on, push off — this is what registerPush's laptopEnabled below
    // must answer.
    await remoteAccess.start(remoteConfig({ enabled: false, includeProjectNames: false }));

    const handle = remoteRequestHandler(table, blobs);

    // One real socket+connection per paired device — D2 (step 5 only) uses
    // this too, so its own hello/req traffic is exactly as real as D1's.
    function connectDevice(
      device: AuthenticatedDevice,
      token: string,
    ): {
      socket: FakeSocket;
      connection: ReturnType<typeof createConnection>;
      sendReq(ch: string, a?: unknown[]): number;
    } {
      const deviceSocket = new FakeSocket();
      const deviceConnection = createConnection(deviceSocket, {
        source: "10.0.0.5:1",
        now: () => Date.now(),
        timers: {
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
        authenticate: (deviceId, presented) =>
          deviceId === device.id && presented === token ? device : undefined,
        handle,
        policies: remotePushPolicies(),
        authorizeKey: remoteKeyAuthorizer(streams),
        blobLimit: () => undefined,
        errorText: (code) => ({
          text: MESSAGES.remoteErrorText(code, "en"),
          language: "en" as const,
        }),
        audit: { record: () => {} },
        auditPolicy: () => "never",
        log: (line) => connectionLogLines.push(line),
        onOpen: () => {},
        onAuthFailed: () => {},
        onClosed: () => {},
      });
      connections.set(device.id, deviceConnection);
      let nextId = 1;
      function sendReq(ch: string, a: unknown[] = []): number {
        const id = nextId++;
        deviceConnection.onText(reqFrame(id, ch, a));
        return id;
      }
      return { socket: deviceSocket, connection: deviceConnection, sendReq };
    }

    const { socket, connection, sendReq } = connectDevice(D1, D1_TOKEN);
    // fetchCalls.length this scenario expects *after* each step below —
    // tracked explicitly rather than hardcoded, since step 5 now inserts a
    // batch that carries two devices' messages in one call.
    let sent = 0;

    // 1. d1 authenticates, then registers its push token.
    connection.onText(helloFrame(D1.id, D1_TOKEN));
    expect(connection.device).toEqual(D1);
    expect(socket.sent[0]).toMatchObject({ t: "welcome", v: PROTOCOL_VERSION });
    socket.sent = [];

    const regId = sendReq("remote:registerPush", [
      { token: EXPO_TOKEN, platform: "ios", language: "ar" },
    ]);
    await tick();
    expect(resFor(socket, regId)).toEqual({
      t: "res",
      id: regId,
      v: { registered: true, laptopEnabled: false },
    });
    expect(JSON.stringify(socket.sent)).not.toContain(EXPO_TOKEN);
    expect(remoteAccess.pushTargets()).toEqual([
      { deviceId: D1.id, token: EXPO_TOKEN, platform: "ios", language: "ar" },
    ]);

    // 2. push.enabled:true — s1 (acme, "rm -rf build") running -> done,
    // unfocused, unwatched -> exactly one fetch after PUSH_FLUSH_MS, with a
    // generic body that names neither the project nor the summary.
    await remoteAccess.apply(remoteConfig({ enabled: true, includeProjectNames: false }));

    sessionsFixture.setState(session("s1", "running", "acme", "rm -rf build"));
    sessionsFixture.setState(session("s1", "done", "acme", "rm -rf build"));
    expect(fetchCalls).toHaveLength(sent);
    await vi.advanceTimersByTimeAsync(PUSH_FLUSH_MS);
    sent += 1;
    expect(fetchCalls).toHaveLength(sent);
    expect(fetchCalls[0]?.url).toBe(EXPO_PUSH_URL);
    const body1 = JSON.parse(fetchCalls[0]?.body ?? "[]");
    expect(body1).toEqual([
      {
        to: EXPO_TOKEN,
        title: MESSAGES.pushTitle("ar"),
        body: MESSAGES.pushBody("session-done", undefined, "ar"),
        data: { kind: "session-done", sessionId: "s1" },
        sound: "default",
        priority: "high",
        channelId: "jarvis",
        ttl: PUSH_TTL_SECONDS,
      },
    ]);
    expect(fetchCalls[0]?.body).not.toContain("acme");
    expect(fetchCalls[0]?.body).not.toContain("rm -rf build");
    // M12 Task 3's deferred step: the queued push itself (before Expo is
    // ever called) got one audit line, carrying only deviceId and the push
    // kind — never the project, the summary, or anything else this
    // scenario's own body1 assertions above just proved never left the
    // laptop.
    expect(auditLines).toContainEqual(`push-queued device=${D1.id} kind=session-done`);

    // 3. d1 subscribes to session:output/s1 only. s2 (unwatched) done -> a
    // push. A second s1-scoped event (session-failed, via a fake done->dead
    // transition this test double doesn't otherwise enforce as legal — it
    // exists purely to exercise the "watched -> suppressed" rule for a
    // second event on the same key) -> none, because d1 is watching. A
    // third session done while the window is focused -> none either.
    connection.onText(subFrame([{ ch: "session:output", key: "s1" }]));
    await tick();

    sessionsFixture.setState(session("s2", "running", null, ""));
    sessionsFixture.setState(session("s2", "done", null, ""));
    await vi.advanceTimersByTimeAsync(PUSH_FLUSH_MS);
    sent += 1;
    expect(fetchCalls).toHaveLength(sent);

    sessionsFixture.setState(session("s1", "dead", "acme", "rm -rf build", 1));
    await vi.advanceTimersByTimeAsync(PUSH_FLUSH_MS);
    expect(fetchCalls).toHaveLength(sent); // suppressed: d1 is watching session:output/s1

    focused = true;
    sessionsFixture.setState(session("s3", "running", null, ""));
    sessionsFixture.setState(session("s3", "done", null, ""));
    await vi.advanceTimersByTimeAsync(PUSH_FLUSH_MS);
    expect(fetchCalls).toHaveLength(sent); // suppressed: focused
    focused = false;

    // Minor: coalescing (shouldNotify rule 2, NOTIFY_COALESCE_MS). A second
    // real session-done transition on the *same* session id, sent again
    // inside the coalescing window, produces nothing more; once the window
    // has fully elapsed, the same (device, kind, key) sends again. The
    // "done -> running -> done" round trip below is this fake
    // SessionManager's only way to fire session-done twice for one id
    // (a real session never re-enters "running" after "done") — same
    // liberty step 3's own done->dead transition above already takes.
    sessionsFixture.setState(session("s8", "running", null, ""));
    sessionsFixture.setState(session("s8", "done", null, ""));
    await vi.advanceTimersByTimeAsync(PUSH_FLUSH_MS);
    sent += 1;
    expect(fetchCalls).toHaveLength(sent);

    sessionsFixture.setState(session("s8", "running", null, ""));
    sessionsFixture.setState(session("s8", "done", null, ""));
    await vi.advanceTimersByTimeAsync(PUSH_FLUSH_MS);
    expect(fetchCalls).toHaveLength(sent); // coalesced: repeated inside NOTIFY_COALESCE_MS

    await vi.advanceTimersByTimeAsync(NOTIFY_COALESCE_MS);
    sessionsFixture.setState(session("s8", "running", null, ""));
    sessionsFixture.setState(session("s8", "done", null, ""));
    await vi.advanceTimersByTimeAsync(PUSH_FLUSH_MS);
    sent += 1;
    expect(fetchCalls).toHaveLength(sent); // the coalescing window has fully elapsed

    // 4. push.enabled:false -> no fetch. push.enabled:true +
    // includeProjectNames:true -> the body names the project.
    await remoteAccess.apply(remoteConfig({ enabled: false, includeProjectNames: false }));
    sessionsFixture.setState(session("s4", "running", null, ""));
    sessionsFixture.setState(session("s4", "done", null, ""));
    await vi.advanceTimersByTimeAsync(PUSH_FLUSH_MS);
    expect(fetchCalls).toHaveLength(sent);

    await remoteAccess.apply(remoteConfig({ enabled: true, includeProjectNames: true }));
    sessionsFixture.setState(session("s5", "running", "acme", "ls"));
    sessionsFixture.setState(session("s5", "done", "acme", "ls"));
    await vi.advanceTimersByTimeAsync(PUSH_FLUSH_MS);
    sent += 1;
    expect(fetchCalls).toHaveLength(sent);
    expect(fetchCalls.at(-1)?.body).toContain("acme");
    const body3 = JSON.parse(fetchCalls.at(-1)?.body ?? "[]");
    expect(body3[0].data.project).toBe("acme");

    // 5. A second device (d2) registers too. Expo answers DeviceNotRegistered
    // for d1's own token only -> exactly one device's record is cleared,
    // never both; the audit trail carries push-cleared/not-registered for
    // d1 alone. d1 then re-registers over the wire and is a target again;
    // d2 unregisters over the wire and its own target is gone
    // [bite-proof: make remote:unregisterPush's wire handler a no-op — see
    // the report for the reverted-and-restored run].
    const d2 = connectDevice(D2, D2_TOKEN);
    d2.connection.onText(helloFrame(D2.id, D2_TOKEN));
    d2.socket.sent = [];
    const reg2Id = d2.sendReq("remote:registerPush", [
      { token: EXPO_TOKEN_2, platform: "android", language: "en" },
    ]);
    await tick();
    expect(resFor(d2.socket, reg2Id)).toMatchObject({ v: { registered: true } });
    expect(remoteAccess.pushTargets()).toHaveLength(2);

    fetchOverrides.push((messages) => ({
      status: 200,
      async json() {
        return {
          data: messages.map((m) =>
            m.to === EXPO_TOKEN
              ? { status: "error", details: { error: "DeviceNotRegistered" } }
              : { status: "ok", id: `ticket-cleared-${m.to}` },
          ),
        };
      },
    }));
    sessionsFixture.setState(session("s6", "running", null, ""));
    sessionsFixture.setState(session("s6", "done", null, ""));
    await vi.advanceTimersByTimeAsync(PUSH_FLUSH_MS);
    sent += 1;
    expect(fetchCalls).toHaveLength(sent);
    expect(remoteAccess.pushTargets()).toEqual([
      { deviceId: D2.id, token: EXPO_TOKEN_2, platform: "android", language: "en" },
    ]);
    expect(auditLines.some((l) => l.includes("push-cleared") && l.includes("not-registered"))).toBe(
      true,
    );

    const reRegId = sendReq("remote:registerPush", [
      { token: EXPO_TOKEN, platform: "ios", language: "ar" },
    ]);
    await tick();
    expect(resFor(socket, reRegId)).toMatchObject({ v: { registered: true } });
    expect(remoteAccess.pushTargets()).toEqual(
      expect.arrayContaining([
        { deviceId: D1.id, token: EXPO_TOKEN, platform: "ios", language: "ar" },
      ]),
    );
    expect(remoteAccess.pushTargets()).toHaveLength(2);

    const unreg2Id = d2.sendReq("remote:unregisterPush", []);
    await tick();
    expect(resFor(d2.socket, unreg2Id)).toBeDefined();
    expect(remoteAccess.pushTargets()).toEqual([
      { deviceId: D1.id, token: EXPO_TOKEN, platform: "ios", language: "ar" },
    ]);

    // 6. remote:unregisterPush from d1 -> pushTargets() is empty
    // [bite-proof, continued: this is the assertion a no-op unregister
    // would fail]. remote:revoke and terminal:commandFinished from a
    // remote origin -> forbidden, desktop-only.
    const unregId = sendReq("remote:unregisterPush", []);
    await tick();
    expect(resFor(socket, unregId)).toBeDefined();
    expect(remoteAccess.pushTargets()).toEqual([]);

    const revokeId = sendReq("remote:revoke", [D1.id]);
    await tick();
    expect(errFor(socket, revokeId)?.code).toBe("forbidden");

    const cmdId = sendReq("terminal:commandFinished", ["k1", 90, true]);
    await tick();
    expect(errFor(socket, cmdId)?.code).toBe("forbidden");

    // 7. Neither the push token nor anything that could carry it ever
    // reaches a log line.
    const allLogs = [...connectionLogLines, ...ioLogLines, ...notifyLogLines].join("\n");
    expect(allLogs).not.toContain(EXPO_TOKEN);
    expect(allLogs).not.toContain(EXPO_TOKEN_2);

    await remoteAccess.stop();
  });
});
