// jarvisd's core behind its control socket.
//
// `handlers` is what createControlServer serves; `bind` connects the core
// once it exists. The server has to start first — it is the single-instance
// lock, and a second daemon must exit before it builds a second core — so a
// request that arrives in between waits for `bind` rather than failing.
//
// Every dispatch-table request runs with DESKTOP_ORIGIN: the control socket
// is the desktop's own door (0600 in a 0700 dir, mutually authenticated),
// and the only place desktop-only channels are reachable besides the app's
// in-process adapter. The `daemon:` channels (protocol.ts) are the socket
// adapter's side of CoreClient: the workspace mirror, the host hooks, the
// lifecycle calls — and daemon:stop.
//
// Ordering. Everything the daemon sends a client — relayed pushes, tab
// state, view requests, host hooks, replies — goes out on the one socket in
// the order it was produced. A handler runs synchronously once the core is
// bound, so a push the core emits while handling a request is written
// before that request's reply: the app's push listeners see it before the
// invoke settles (socket-core-client.test.ts pins this).
//
// No electron here (core/no-electron.test.ts).
import { randomBytes } from "node:crypto";
import type { PushChannels } from "../channels.js";
import type { Core } from "../core/compose.js";
import { DESKTOP_ORIGIN, type TableChannel } from "../dispatch.js";
import type { PageFact } from "../core/tab-host.js";
import type { TabKind } from "@jarvis/core";
import { ControlRequestError } from "./control/messages.js";
import type { ControlConnection, ControlHandlers } from "./control/server.js";
import { createDaemonHost, type DaemonHost } from "./daemon-host.js";
import {
  DAEMON_PUSHES,
  DAEMON_REQUESTS,
  type DaemonSnapshot,
  HOST_BROADCAST_CHANNELS,
  isHostWindowState,
  type VersionedTabs,
} from "./protocol.js";

/** How often the daemon checks whether hostConfig changed under it (a
 *  Settings save from any client, or a phone's) and pushes the new value. */
export const HOST_CONFIG_POLL_MS = 2_000;

export type DaemonBinding = {
  readonly handlers: ControlHandlers;
  readonly daemonHost: DaemonHost;
  /** Connects `core` to `server`: its pushes, tab state and host hooks.
   *  Returns the unbind. */
  bind(
    core: Core,
    server: {
      push(channel: string, payload: unknown): void;
      pushTo(connectionId: number, channel: string, payload: unknown): void;
    },
  ): () => void;
};

export type DaemonBindingDeps = {
  /** Starts the graceful stop. Called after daemon:stop has been answered. */
  requestStop(): void;
  /** Starts the graceful stop with DAEMON_EXIT.restart, for a service
   *  manager to start the daemon again. Absent when none runs it. Called
   *  after the request that asked for it has been answered. */
  requestRestart?(): void;
  log(line: string): void;
  now(): number;
  timers: {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    /** Runs `callback` after the current I/O — daemon:stop's reply first. */
    defer(callback: () => void): void;
  };
  /** Marks this daemon run in VersionedTabs. Random by default. */
  instance?: string;
};

const refuse = (text: string): never => {
  throw new ControlRequestError("bad-request", text);
};
const text = (value: unknown, name: string): string =>
  typeof value === "string" ? value : refuse(`${name} must be a string`);

function isPageFact(value: unknown): value is PageFact {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

export function createDaemonBinding(deps: DaemonBindingDeps): DaemonBinding {
  const instance = deps.instance ?? randomBytes(8).toString("hex");
  let version = 0;
  let push: (channel: string, payload: unknown) => void = () => {};
  let pushTo: (id: number, channel: string, payload: unknown) => void = () => {};
  /** The connection whose request the core is running synchronously now. */
  let initiator: number | undefined;
  const { requestRestart } = deps;
  const daemonHost = createDaemonHost({
    push: (channel, payload) => push(channel, payload),
    pushTo: (id, channel, payload) => pushTo(id, channel, payload),
    initiator: () => initiator,
    ...(requestRestart === undefined
      ? {}
      : { restartDaemon: () => deps.timers.defer(requestRestart) }),
    log: deps.log,
    now: deps.now,
  });
  let bindCore!: (core: Core) => void;
  const bound = new Promise<Core>((resolve) => {
    bindCore = resolve;
  });
  let checkHostConfig: () => void = () => {};
  const watchedConnections = new Set<number>();

  const versioned = (core: Core): VersionedTabs => ({
    instance,
    version,
    state: core.tabs.state(),
  });

  function attachHost(connection: ControlConnection, state: unknown): null {
    if (!isHostWindowState(state)) refuse("host state must be {focused, awake}");
    if (!watchedConnections.has(connection.id)) {
      watchedConnections.add(connection.id);
      connection.onClose(() => {
        watchedConnections.delete(connection.id);
        daemonHost.detach(connection.id);
      });
    }
    daemonHost.attach(connection.id, state as { focused: boolean; awake: boolean });
    return null;
  }

  async function internal(
    core: Core,
    channel: string,
    args: unknown[],
    connection: ControlConnection,
  ): Promise<unknown> {
    switch (channel) {
      case DAEMON_REQUESTS.snapshot: {
        const snapshot: DaemonSnapshot = {
          firstRun: core.firstRun,
          hostConfig: core.hostConfig(),
          tabs: versioned(core),
        };
        return snapshot;
      }
      case DAEMON_REQUESTS.attachHost:
        return attachHost(connection, args[0]);
      case DAEMON_REQUESTS.detachHost:
        daemonHost.detach(connection.id);
        return null;
      case DAEMON_REQUESTS.hostState:
        if (!isHostWindowState(args[0])) refuse("host state must be {focused, awake}");
        daemonHost.report(connection.id, args[0] as { focused: boolean; awake: boolean });
        return null;
      case DAEMON_REQUESTS.reportPage: {
        const id = text(args[0], "tab id");
        if (!isPageFact(args[1])) refuse("page fact must have a kind");
        core.tabs.reportPage(id, args[1] as PageFact);
        return null;
      }
      case DAEMON_REQUESTS.suspend:
        core.tabs.suspend(text(args[0], "tab id"));
        return null;
      case DAEMON_REQUESTS.open: {
        const [project, input, kind, detail] = args;
        core.tabs.open(
          text(project, "project"),
          text(input, "input"),
          kind === undefined || kind === null ? undefined : (text(kind, "kind") as TabKind),
          detail === undefined || detail === null ? undefined : text(detail, "detail"),
        );
        return null;
      }
      case DAEMON_REQUESTS.faviconPut:
        return core.favicons.put(
          text(args[0], "page url"),
          text(args[1], "icon"),
          text(args[2], "content type"),
        );
      case DAEMON_REQUESTS.faviconMiss:
        return core.favicons.putMiss(text(args[0], "page url"));
      case DAEMON_REQUESTS.voiceStart:
        core.voiceControl.start();
        return null;
      case DAEMON_REQUESTS.voiceStop:
        core.voiceControl.stop();
        return null;
      case DAEMON_REQUESTS.dbgateCredential: {
        const port = args[0];
        if (typeof port !== "number" || !Number.isInteger(port)) refuse("port must be an integer");
        return (await core.dbgateCredentialFor(port as number)) ?? null;
      }
      case DAEMON_REQUESTS.announceStartup:
        await core.announceStartup();
        return null;
      case DAEMON_REQUESTS.broadcast: {
        const pushChannel = text(args[0], "channel");
        if (!HOST_BROADCAST_CHANNELS.has(pushChannel)) refuse("not a host broadcast channel");
        core.broadcast.send(
          pushChannel as keyof PushChannels,
          args[1] as PushChannels[keyof PushChannels],
        );
        return null;
      }
      case DAEMON_REQUESTS.stop:
        deps.log("stop requested over the control socket");
        deps.timers.defer(deps.requestStop);
        return { stopping: true };
      default:
        throw new ControlRequestError("unknown-channel", `No handler for ${channel}`);
    }
  }

  const handlers: ControlHandlers = {
    async invoke(channel, args, connection) {
      const core = await bound;
      if (channel.startsWith("daemon:")) return internal(core, channel, args, connection);
      // Own properties only: "constructor" must not find Object.prototype's.
      if (!Object.hasOwn(core.dispatch, channel)) {
        throw new ControlRequestError("unknown-channel", `No handler for ${channel}`);
      }
      try {
        let pending: unknown;
        // The handler's synchronous part runs with its caller known, so a
        // host hook it calls (restart) can answer that one app.
        initiator = connection.id;
        try {
          pending = core.dispatch[channel as TableChannel](args, DESKTOP_ORIGIN);
        } finally {
          initiator = undefined;
        }
        return await pending;
      } finally {
        checkHostConfig();
      }
    },
    async upload() {
      throw new ControlRequestError("unsupported", "No upload channel is served here");
    },
  };

  return {
    handlers,
    daemonHost,
    bind(core, server) {
      push = (channel, payload) => server.push(channel, payload);
      pushTo = (id, channel, payload) => server.pushTo(id, channel, payload);
      const detachHost = core.attachHost(daemonHost.host);
      const offPush = core.onPush((channel, payload) => server.push(channel, payload));
      const offTabs = core.tabs.onChange((state) => {
        version += 1;
        server.push(DAEMON_PUSHES.tabs, { instance, version, state } satisfies VersionedTabs);
      });
      const offViews = core.tabs.onViewRequest((request) =>
        server.push(DAEMON_PUSHES.viewRequest, request),
      );
      let lastHostConfig = JSON.stringify(core.hostConfig());
      checkHostConfig = () => {
        const current = core.hostConfig();
        const serialised = JSON.stringify(current);
        if (serialised === lastHostConfig) return;
        lastHostConfig = serialised;
        server.push(DAEMON_PUSHES.hostConfig, current);
      };
      const poll = deps.timers.setInterval(() => checkHostConfig(), HOST_CONFIG_POLL_MS);
      bindCore(core);
      return () => {
        deps.timers.clearInterval(poll);
        checkHostConfig = () => {};
        offViews();
        offTabs();
        offPush();
        detachHost();
        push = () => {};
        pushTo = () => {};
      };
    },
  };
}
