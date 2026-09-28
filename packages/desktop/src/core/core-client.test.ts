import { describe, expect, it, vi } from "vitest";
import type { FaviconStore } from "@jarvis/platform";
import type { HostedView, HostedViewEvent } from "../browser-host.js";
import { createBroadcaster } from "../broadcast.js";
import { INVOKE_CHANNELS } from "../channels.js";
import { ELECTRON_BOUND_CHANNELS } from "../desktop-only.js";
import { DESKTOP_ORIGIN, type DispatchTable, type Handler, type Origin } from "../dispatch.js";
import { ViewReconciler } from "../view-reconciler.js";
import type { Core } from "./compose.js";
import {
  inProcessCoreClient,
  throughJson,
  type CoreClient,
  type DesktopHost,
} from "./core-client.js";
import { faviconIntake } from "./favicon-intake.js";
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
  const favicons = faviconIntake({
    put: async (...args) => {
      stored.push(["put", ...args]);
      return { ok: true, value: undefined };
    },
    putMiss: async (...args) => {
      stored.push(["putMiss", ...args]);
      return { ok: true, value: undefined };
    },
  } satisfies Pick<FaviconStore, "put" | "putMiss">);
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

  it("stores the host's favicon fetches in the core's cache, sent as base64", async () => {
    const { core, stored } = fakeCore();
    const client = inProcessCoreClient(core, { roundTrip: true });
    const bytes = new Uint8Array([1, 2, 3]);
    await client.favicons.put(
      "https://example.com/",
      Buffer.from(bytes).toString("base64"),
      "image/png",
    );
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

// The contract is JSON values only (core-client.ts). In round-trip mode the
// adapter puts every argument and result through JSON, as the socket will,
// so a non-JSON value — a Uint8Array above all — fails here, now.
describe("inProcessCoreClient: round-trip mode", () => {
  /** Calls every member of the client and every hook of the host at least
   *  once, with the shapes the app really sends. Returns what it called. */
  async function exerciseEverything(client: CoreClient, fake: ReturnType<typeof fakeCore>) {
    const called = new Set<string>();
    const note = (name: string) => called.add(name);
    const pushes: unknown[] = [];
    client.onPush((channel, payload) => pushes.push([channel, payload]));
    note("onPush");
    const states: unknown[] = [];
    client.workspace.onChange((state) => states.push(state));
    note("workspace.onChange");
    client.workspace.onViewRequest((request) => states.push(request));
    note("workspace.onViewRequest");

    fake.answers.set("settings:read", async () => ({ ok: true, value: { projects: { a: "/a" } } }));
    await client.invoke("settings:read", ["x", 1, true, null, { nested: ["y"] }]);
    note("invoke");
    fake.tabs.onChange((state) => fake.core.broadcast.send("workspace:update", state));
    client.broadcast("turn:new", { role: "assistant", text: "hi", language: "en", at: 1 });
    note("broadcast");
    client.workspace.open("acme", "a.com");
    client.workspace.open("acme", "b.com");
    note("workspace.open");
    const id = client.workspace.state().tabs[0]!.id;
    note("workspace.state");
    client.workspace.reportPage(id, {
      kind: "navigated",
      url: "https://a.com/x",
      canGoBack: true,
      canGoForward: false,
    });
    note("workspace.reportPage");
    client.workspace.suspend(id);
    note("workspace.suspend");
    await client.favicons.put(
      "https://a.com/",
      Buffer.from([1, 2]).toString("base64"),
      "image/png",
    );
    note("favicons.put");
    await client.favicons.putMiss("https://b.com/");
    note("favicons.putMiss");
    client.hostConfig();
    note("hostConfig");
    void client.firstRun;
    note("firstRun");
    await client.dbgateCredentialFor(5000);
    note("dbgateCredentialFor");
    client.voice.start();
    client.voice.stop();
    note("voice.start");
    note("voice.stop");
    client.startRemote();
    note("startRemote");
    await client.announceStartup();
    note("announceStartup");

    const host = recordingHost();
    const detach = client.attachHost(host.host);
    note("attachHost");
    fake.link.host.isFocused();
    fake.link.host.isAwake();
    fake.link.host.requestFavicon("acme", "https://a.com/");
    fake.link.host.sweepIdleViews();
    fake.link.host.showNotification("title", "body");
    await fake.link.host.openExternal("https://web.example/");
    fake.link.host.restart();
    fake.link.host.destroyViews();
    detach();
    client.stop();
    note("stop");
    return { called, pushes, states, hostSeen: host.seen };
  }

  /** Every callable or value on the client, nested groups flattened. */
  function members(client: CoreClient): string[] {
    const names: string[] = [];
    for (const [key, value] of Object.entries(client)) {
      if (value !== null && typeof value === "object") {
        for (const inner of Object.keys(value)) names.push(`${key}.${inner}`);
      } else names.push(key);
    }
    return names.sort();
  }

  it("carries every member's arguments and results as JSON, with nothing lost", async () => {
    const fake = fakeCore();
    const client = inProcessCoreClient(fake.core, { roundTrip: true });
    const { called, pushes, states, hostSeen } = await exerciseEverything(client, fake);

    expect([...called].sort()).toEqual(members(client));
    expect(fake.calls[0]?.args).toEqual(["x", 1, true, null, { nested: ["y"] }]);
    expect(pushes.map((push) => (push as unknown[])[0])).toContain("turn:new");
    expect(states.length).toBeGreaterThan(0);
    expect(hostSeen.map((entry) => entry[0])).toEqual([
      "requestFavicon",
      "sweepIdleViews",
      "showNotification",
      "openExternal",
      "restart",
      "destroyViews",
    ]);
    expect(fake.stored[0]?.[2]).toEqual(new Uint8Array([1, 2]));
  });

  it("refuses a Uint8Array anywhere it would cross, as a socket frame would", async () => {
    const fake = fakeCore();
    const client = inProcessCoreClient(fake.core, { roundTrip: true });
    // Raw bytes where base64 belongs: the mistake the contract exists for.
    expect(() =>
      client.favicons.put("https://a/", new Uint8Array([1]) as unknown as string, "image/png"),
    ).toThrow(/favicons\.put.*Uint8Array/);
    await expect(client.invoke("settings:read", [new Uint8Array([1])])).rejects.toThrow(
      /Uint8Array/,
    );
    fake.answers.set("settings:read", () => new Map());
    await expect(client.invoke("settings:read", [])).rejects.toThrow(/Map is not JSON/);
    // A push is refused per listener and logged, like any failed delivery.
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const seen: unknown[] = [];
      client.onPush((_channel, payload) => seen.push(payload));
      fake.link.toClients("terminal:data", new Uint8Array([1]));
      expect(seen).toEqual([]);
      expect(String(errors.mock.calls[0]?.[0])).toMatch(/terminal:data.*Uint8Array/);
    } finally {
      errors.mockRestore();
    }
  });

  it("names what breaks the contract, and passes what keeps it", () => {
    expect(() => throughJson({ at: new Date(0) }, "x")).toThrow("x.at: a Date is not JSON");
    expect(() => throughJson([1, undefined], "x")).toThrow("x[1]: undefined in an array");
    expect(() => throughJson({ n: Number.NaN }, "x")).toThrow("x.n: NaN is not JSON");
    expect(() => throughJson({ f: () => 1 }, "x")).toThrow("x.f: a function is not JSON");
    expect(() => throughJson(new Set([1]), "x")).toThrow("x: a Set is not JSON");
    expect(throughJson({ a: [1, "b", null, { c: true }], gone: undefined }, "x")).toEqual({
      a: [1, "b", null, { c: true }],
    });
    expect(throughJson(undefined, "x")).toBeUndefined();
  });

  it("turns a rejection into a message-only error, as an error frame would carry", async () => {
    const fake = fakeCore();
    fake.answers.set("settings:read", async () => {
      throw Object.assign(new TypeError("boom"), { secret: "x" });
    });
    const client = inProcessCoreClient(fake.core, { roundTrip: true });
    const error = await client.invoke("settings:read", []).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("boom");
    expect(error).not.toHaveProperty("secret");
  });
});
