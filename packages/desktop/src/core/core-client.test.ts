import { describe, expect, it, vi } from "vitest";
import type { FaviconStore } from "@jarvis/platform";
import type { HostedView, HostedViewEvent } from "../browser-host.js";
import { createBroadcaster } from "../broadcast.js";
import { INVOKE_CHANNELS } from "../channels.js";
import { ELECTRON_BOUND_CHANNELS } from "../desktop-only.js";
import { DESKTOP_ORIGIN, type DispatchTable, type Handler, type Origin } from "../dispatch.js";
import { ViewReconciler } from "../view-reconciler.js";
import type { Core } from "./compose.js";
import { inProcessCoreClient, type DesktopHost } from "./core-client.js";
import { createHostLink } from "./host-link.js";
import { TabHost } from "./tab-host.js";

// The in-process adapter is the CoreClient main.ts talks to today, and the
// contract a socket adapter must meet tomorrow: requests reach the table as
// sent with the desktop's origin, pushes keep their order, and every host
// hook round-trips.

type Call = { channel: string; args: readonly unknown[]; origin: Origin };

function fakeCore() {
  const calls: Call[] = [];
  const answers = new Map<string, Handler>();
  const table: Record<string, Handler> = {};
  const bound: ReadonlySet<string> = new Set(ELECTRON_BOUND_CHANNELS);
  for (const channel of Object.values(INVOKE_CHANNELS)) {
    if (bound.has(channel)) continue;
    table[channel] = (args, origin) => {
      calls.push({ channel, args, origin });
      return answers.get(channel)?.(args, origin);
    };
  }

  const link = createHostLink();
  const broadcast = createBroadcaster({ toRenderer: link.toClients });
  const tabs = new TabHost();
  const stored: unknown[][] = [];
  const favicons = {
    put: async (...args: unknown[]) => {
      stored.push(["put", ...args]);
      return { ok: true };
    },
    putMiss: async (...args: unknown[]) => {
      stored.push(["putMiss", ...args]);
      return { ok: true };
    },
  } as unknown as FaviconStore;
  const config = { allowPopups: true, suspendTabsAfterMs: 900_000 };
  const lifecycle: string[] = [];

  const core: Core = {
    firstRun: true,
    hostConfig: () => ({ ...config }),
    dispatch: table as DispatchTable,
    broadcast,
    tabs,
    favicons,
    attachHost: (desktop) => link.attach(desktop),
    onPush: (listener) => link.onPush(listener),
    voiceControl: {
      start: () => lifecycle.push("voice:start"),
      stop: () => lifecycle.push("voice:stop"),
    },
    dbgateCredentialFor: (port) =>
      port === 5000 ? { login: "jarvis", password: "pw" } : undefined,
    startRemote: () => lifecycle.push("startRemote"),
    announceStartup: async () => {
      lifecycle.push("announceStartup");
    },
    stop: () => lifecycle.push("stop"),
  };
  return { core, calls, answers, link, tabs, stored, config, lifecycle };
}

function recordingHost(): { host: DesktopHost; seen: unknown[][]; state: { focused: boolean } } {
  const seen: unknown[][] = [];
  const state = { focused: true };
  return {
    seen,
    state,
    host: {
      isFocused: () => state.focused,
      isAwake: () => true,
      requestFavicon: (...args) => seen.push(["requestFavicon", ...args]),
      sweepIdleViews: () => seen.push(["sweepIdleViews"]),
      destroyViews: () => seen.push(["destroyViews"]),
      showNotification: (...args) => seen.push(["showNotification", ...args]),
      openExternal: async (url) => {
        seen.push(["openExternal", url]);
      },
      restart: () => seen.push(["restart"]),
    },
  };
}

describe("inProcessCoreClient: invoke", () => {
  it("hands the table the caller's own argument array and the desktop origin, unchanged", async () => {
    const { core, calls, answers } = fakeCore();
    answers.set("workspace:open", () => "opened");
    const client = inProcessCoreClient(core);
    const args = ["acme", "https://example.com", { nested: [1, 2] }];

    await expect(client.invoke("workspace:open", args)).resolves.toBe("opened");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.channel).toBe("workspace:open");
    expect(calls[0]?.args).toBe(args);
    expect(calls[0]?.args).toEqual(["acme", "https://example.com", { nested: [1, 2] }]);
    expect(calls[0]?.origin).toBe(DESKTOP_ORIGIN);
  });

  it("runs the handler in the same tick, as a direct ipcMain registration did", () => {
    const { core, calls } = fakeCore();
    void inProcessCoreClient(core).invoke("settings:read", []);
    expect(calls.map((call) => call.channel)).toEqual(["settings:read"]);
  });

  it("passes a handler's promise through and turns a synchronous throw into a rejection", async () => {
    const { core, answers } = fakeCore();
    answers.set("settings:read", async () => ({ ok: true }));
    answers.set("workspace:close", () => {
      throw new Error("bad tab");
    });
    const client = inProcessCoreClient(core);
    await expect(client.invoke("settings:read", [])).resolves.toEqual({ ok: true });
    await expect(client.invoke("workspace:close", ["t"])).rejects.toThrow("bad tab");
  });

  it("refuses a channel the table does not own, without reading Object.prototype", async () => {
    const { core, calls } = fakeCore();
    const client = inProcessCoreClient(core);
    for (const channel of ["constructor", "__proto__", "workspace:back"]) {
      await expect(client.invoke(channel as "settings:read", [])).rejects.toThrow("No handler");
    }
    expect(calls).toEqual([]);
  });
});

describe("inProcessCoreClient: pushes", () => {
  it("delivers every push to every listener in the order the core sent it", () => {
    const { core, tabs } = fakeCore();
    const client = inProcessCoreClient(core);
    const first: unknown[] = [];
    const second: unknown[] = [];
    client.onPush((channel, payload) => first.push([channel, payload]));
    client.onPush((channel) => second.push(channel));
    // What the core's wiring does with every tab change.
    tabs.onChange((state) => core.broadcast.send("workspace:update", state));

    core.broadcast.send("voice:listening", true);
    core.broadcast.local("setup:output", "installing");
    tabs.openTerminal("acme");
    core.broadcast.send("voice:listening", false);

    // A terminal tab is opened, then labelled: two changes, two updates.
    const channels = [
      "voice:listening",
      "setup:output",
      "workspace:update",
      "workspace:update",
      "voice:listening",
    ];
    expect(first.map((entry) => (entry as unknown[])[0])).toEqual(channels);
    expect(first[0]).toEqual(["voice:listening", true]);
    expect(first[4]).toEqual(["voice:listening", false]);
    expect(second).toEqual(channels);
  });

  it("keeps delivering to the others when one listener throws, and stops after unsubscribe", () => {
    const { core } = fakeCore();
    const client = inProcessCoreClient(core);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const seen: string[] = [];
      client.onPush(() => {
        throw new Error("window gone");
      });
      const off = client.onPush((channel) => seen.push(channel));
      core.broadcast.send("voice:speaking", true);
      off();
      core.broadcast.send("voice:speaking", false);
      expect(seen).toEqual(["voice:speaking"]);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("sends the host's own broadcast to every client, not only this window", () => {
    const { core } = fakeCore();
    const client = inProcessCoreClient(core);
    const window: string[] = [];
    const phone: string[] = [];
    client.onPush((channel) => window.push(channel));
    core.broadcast.addSink((channel) => phone.push(channel));
    client.broadcast("voice:hotkeys", { start: "Alt+Space", stop: "Alt+Shift+Space" });
    expect(window).toEqual(["voice:hotkeys"]);
    expect(phone).toEqual(["voice:hotkeys"]);
  });

  it("orders a new tab's state ahead of its reveal on the workspace stream", () => {
    const { core } = fakeCore();
    const client = inProcessCoreClient(core);
    const seen: string[] = [];
    client.workspace.onChange((state) => seen.push(`state:${state.tabs.length}`));
    client.workspace.onViewRequest((request) => seen.push(request.kind));
    core.tabs.open("acme", "example.com");
    expect(seen).toEqual(["state:1", "reveal"]);
  });
});

describe("inProcessCoreClient: host hooks", () => {
  it("reaches the attached host for every call the core makes, and stops at detach", async () => {
    const { core, link } = fakeCore();
    const client = inProcessCoreClient(core);
    const { host, seen, state } = recordingHost();
    const detach = client.attachHost(host);

    expect(link.host.isFocused()).toBe(true);
    state.focused = false;
    expect(link.host.isFocused()).toBe(false); // read live, per call
    expect(link.host.isAwake()).toBe(true);
    link.host.requestFavicon("acme", "https://example.com/a");
    link.host.sweepIdleViews();
    link.host.showNotification("Locked out", "Too many attempts");
    await link.host.openExternal("https://web.example/");
    link.host.restart();
    link.host.destroyViews();
    expect(seen).toEqual([
      ["requestFavicon", "acme", "https://example.com/a"],
      ["sweepIdleViews"],
      ["showNotification", "Locked out", "Too many attempts"],
      ["openExternal", "https://web.example/"],
      ["restart"],
      ["destroyViews"],
    ]);

    detach();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      seen.length = 0;
      expect(link.host.isFocused()).toBe(false);
      expect(link.host.isAwake()).toBe(false);
      link.host.sweepIdleViews();
      link.host.destroyViews();
      link.host.requestFavicon("acme", "https://example.com/");
      link.host.showNotification("Locked out", "body");
      link.host.restart();
      await expect(link.host.openExternal("https://web.example/")).rejects.toThrow(
        "No desktop app",
      );
      expect(seen).toEqual([]);
      // Logged, not lost silently — and the body stays out of the log.
      expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
        "desktop notification not shown, no app attached: Locked out",
        "restart not done: no desktop app is attached",
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps a newer host attached when an older one detaches", () => {
    const { core, link } = fakeCore();
    const client = inProcessCoreClient(core);
    const older = recordingHost();
    const newer = recordingHost();
    const detachOlder = client.attachHost(older.host);
    client.attachHost(newer.host);
    detachOlder();
    link.host.sweepIdleViews();
    expect(older.seen).toEqual([]);
    expect(newer.seen).toEqual([["sweepIdleViews"]]);
  });

  it("takes the host's page reports into the core's tab state", () => {
    const { core, tabs } = fakeCore();
    const client = inProcessCoreClient(core);
    client.workspace.open("acme", "a.com");
    const id = tabs.state().tabs[0]!.id;
    client.workspace.reportPage(id, { kind: "title", title: "A" });
    client.workspace.open("acme", "b.com");
    client.workspace.suspend(id);
    expect(tabs.state().tabs).toMatchObject([
      { id, title: "A", suspended: true },
      { url: "https://b.com" },
    ]);
    expect(client.workspace.state()).toEqual(tabs.state());
  });

  it("round-trips the idle sweep: core asks, the host's pages answer, the page goes", () => {
    const { core, link } = fakeCore();
    const client = inProcessCoreClient(core);
    let now = 0;
    const views: { url: string; destroyed: boolean }[] = [];
    const reconciler = new ViewReconciler(
      () => {
        const entry = { url: "", destroyed: false };
        views.push(entry);
        return {
          loadURL: (url: string) => {
            entry.url = url;
          },
          destroy: () => {
            entry.destroyed = true;
          },
          onEvent: (_listener: (event: HostedViewEvent) => void) => undefined,
          setBounds: () => undefined,
          setVisible: () => undefined,
          setDevToolsBounds: () => undefined,
          setDevToolsDock: () => undefined,
        } as unknown as HostedView;
      },
      client.workspace,
      { suspendAfterMs: 1000, now: () => now },
    );
    reconciler.setVisible(true);
    reconciler.follow(client.workspace);
    client.attachHost({
      ...recordingHost().host,
      sweepIdleViews: () => reconciler.sweepIdle(),
      destroyViews: () => reconciler.destroy(),
    });

    client.workspace.open("acme", "a.com");
    client.workspace.open("acme", "b.com");
    now = 5000;
    link.host.sweepIdleViews();
    expect(core.tabs.state().tabs.map((tab) => tab.suspended)).toEqual([true, false]);
    expect(views.map((view) => view.destroyed)).toEqual([true, false]);

    link.host.destroyViews();
    expect(views.map((view) => view.destroyed)).toEqual([true, true]);
  });

  it("stores the host's favicon fetches in the core's cache", async () => {
    const { core, stored } = fakeCore();
    const client = inProcessCoreClient(core);
    const bytes = new Uint8Array([1, 2, 3]);
    await client.favicons.put("https://example.com/", bytes, "image/png");
    await client.favicons.putMiss("https://nothing.example/");
    expect(stored).toEqual([
      ["put", "https://example.com/", bytes, "image/png"],
      ["putMiss", "https://nothing.example/"],
    ]);
  });

  it("answers DbGate's credential, voice, host config and the lifecycle calls", async () => {
    const { core, config, lifecycle } = fakeCore();
    const client = inProcessCoreClient(core);
    await expect(client.dbgateCredentialFor(5000)).resolves.toEqual({
      login: "jarvis",
      password: "pw",
    });
    await expect(client.dbgateCredentialFor(5001)).resolves.toBeUndefined();

    expect(client.firstRun).toBe(true);
    expect(client.hostConfig()).toEqual({ allowPopups: true, suspendTabsAfterMs: 900_000 });
    config.allowPopups = false; // a Settings save, merged in place
    expect(client.hostConfig().allowPopups).toBe(false);

    client.voice.start();
    client.voice.stop();
    client.startRemote();
    await client.announceStartup();
    client.stop();
    expect(lifecycle).toEqual([
      "voice:start",
      "voice:stop",
      "startRemote",
      "announceStartup",
      "stop",
    ]);
  });
});
