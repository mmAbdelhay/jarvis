import { describe, expect, it, vi } from "vitest";
import {
  createMachineViews,
  isMachineTarget,
  type MachineContentsLike,
  type MachineSessionLike,
  type MachineViewHandle,
  type MachineViewOptions,
  type MachineViewState,
  type MachineViewsDeps,
} from "./machine-views.js";

const VERSION = 2;
const TARGET = { name: "studio.tail1234.ts.net", webPort: 7718, v: VERSION };
const ORIGIN = "https://studio.tail1234.ts.net:7718";

type Listener = (...args: unknown[]) => void;

type FakeSession = MachineSessionLike & {
  requestHandler?: Parameters<MachineSessionLike["setPermissionRequestHandler"]>[0];
  checkHandler?: Parameters<MachineSessionLike["setPermissionCheckHandler"]>[0];
  userAgent?: string;
};

type FakeContents = MachineContentsLike & {
  listeners: Map<string, Listener[]>;
  openHandler?: Parameters<MachineContentsLike["setWindowOpenHandler"]>[0];
  loaded: string[];
  userAgent: string;
  fire(event: string, ...args: unknown[]): void;
};

type FakeView = MachineViewHandle & {
  options: MachineViewOptions;
  contents: FakeContents;
  visible: boolean;
  destroyed: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
};

function fakeContents(session: FakeSession): FakeContents {
  const listeners = new Map<string, Listener[]>();
  const contents: FakeContents = {
    listeners,
    loaded: [],
    userAgent: "Mozilla/5.0 Chrome/140.0 Electron/44.1.0 Safari/537.36",
    session,
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    setWindowOpenHandler(handler) {
      contents.openHandler = handler;
    },
    loadURL(url: string) {
      contents.loaded.push(url);
      return Promise.resolve();
    },
    getUserAgent: () => contents.userAgent,
    setUserAgent(agent: string) {
      contents.userAgent = agent;
    },
    fire(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  } as FakeContents;
  return contents;
}

function setup(overrides: Partial<MachineViewsDeps> = {}) {
  const sessions = new Map<string, FakeSession>();
  const views: FakeView[] = [];
  const opened: string[] = [];
  const sessionFor = (partition: string): FakeSession => {
    let found = sessions.get(partition);
    if (found === undefined) {
      found = {
        setPermissionRequestHandler: vi.fn((handler) => {
          found!.requestHandler = handler;
        }),
        setPermissionCheckHandler: vi.fn((handler) => {
          found!.checkHandler = handler;
        }),
        setUserAgent: vi.fn((agent: string) => {
          found!.userAgent = agent;
        }),
      } as FakeSession;
      sessions.set(partition, found);
    }
    return found;
  };
  const deps: MachineViewsDeps = {
    createView: vi.fn((options: MachineViewOptions) => {
      const contents = fakeContents(sessionFor(options.webPreferences.partition));
      const view: FakeView = {
        options,
        contents,
        visible: false,
        destroyed: false,
        webContents: contents,
        setVisible(visible) {
          view.visible = visible;
        },
        setBounds(rect) {
          view.bounds = rect;
        },
        destroy() {
          view.destroyed = true;
        },
      };
      views.push(view);
      return view;
    }),
    session: sessionFor,
    protocolVersion: VERSION,
    openExternal: (url) => opened.push(url),
    ...overrides,
  };
  const machines = createMachineViews(deps);
  const states: MachineViewState[] = [];
  machines.onState((state) => states.push(state));
  return { deps, machines, views, sessions, opened, states };
}

function event() {
  return { preventDefault: vi.fn() };
}

describe("createMachineViews", () => {
  it("shows a machine view only once its page has loaded, and hides it on a failed load", () => {
    const { machines, views } = setup();
    machines.show(TARGET);
    expect(views[0]!.visible).toBe(false);
    views[0]!.contents.fire("did-finish-load");
    expect(views[0]!.visible).toBe(true);
    views[0]!.contents.fire("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", `${ORIGIN}/`, true);
    expect(views[0]!.visible).toBe(false);
  });

  it("a load finishing for a machine that is not the shown one stays hidden", () => {
    const { machines, views } = setup();
    machines.show(TARGET);
    machines.showLocal();
    views[0]!.contents.fire("did-finish-load");
    expect(views[0]!.visible).toBe(false);
  });

  it("choosing an offline or certificate-failed machine again reloads it", () => {
    const { machines, views, states } = setup();
    machines.show(TARGET);
    views[0]!.contents.fire("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", `${ORIGIN}/`, true);
    machines.show(TARGET);
    expect(views[0]!.contents.loaded).toHaveLength(2);
    expect(states.map((s) => s.phase)).toEqual(["loading", "offline", "loading"]);
    views[0]!.contents.fire(
      "did-fail-load",
      {},
      -202,
      "ERR_CERT_AUTHORITY_INVALID",
      `${ORIGIN}/`,
      true,
    );
    machines.show(TARGET);
    expect(views[0]!.contents.loaded).toHaveLength(3);
    // A ready machine is not reloaded.
    views[0]!.contents.fire("did-finish-load");
    machines.show(TARGET);
    expect(views[0]!.contents.loaded).toHaveLength(3);
  });

  it("opens the system browser at most once per second per view", () => {
    let t = 10_000;
    const { machines, views, opened } = setup({ now: () => t });
    machines.show(TARGET);
    const handler = views[0]!.contents.openHandler!;
    handler({ url: "https://a.example/" });
    t += 999;
    handler({ url: "https://b.example/" });
    t += 1;
    handler({ url: "https://c.example/" });
    expect(opened).toEqual(["https://a.example/", "https://c.example/"]);
  });

  it("allows a clipboard write from its own origin only; reading stays denied", () => {
    const { machines, sessions } = setup();
    machines.show(TARGET);
    const session = [...sessions.values()][0]!;
    const ask = (permission: string, url: string) => {
      let granted: boolean | undefined;
      session.requestHandler!({}, permission, (g) => (granted = g), { requestingUrl: url });
      return granted;
    };
    expect(ask("clipboard-sanitized-write", `${ORIGIN}/`)).toBe(true);
    expect(ask("clipboard-sanitized-write", "https://evil.example/")).toBe(false);
    expect(ask("clipboard-read", `${ORIGIN}/`)).toBe(false);
    expect(session.checkHandler!({}, "clipboard-sanitized-write", ORIGIN, {})).toBe(true);
    expect(session.checkHandler!({}, "clipboard-sanitized-write", "https://evil.example", {})).toBe(
      false,
    );
    expect(session.checkHandler!({}, "clipboard-read", ORIGIN, {})).toBe(false);
  });

  it("creates a hardened view in the machine's own partition and loads its origin", () => {
    const { machines, views, states } = setup();
    machines.show(TARGET);
    expect(views).toHaveLength(1);
    expect(views[0]!.options).toEqual({
      webPreferences: {
        partition: "persist:machine:studio.tail1234.ts.net",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    expect("preload" in views[0]!.options.webPreferences).toBe(false);
    expect(views[0]!.contents.loaded).toEqual([`${ORIGIN}/`]);
    expect(views[0]!.visible).toBe(false); // not before its page has loaded
    expect(states).toEqual([{ name: TARGET.name, phase: "loading" }]);
  });

  it("reuses the view on a second show and hides, never destroys, when switching away", () => {
    const { machines, views } = setup();
    machines.show(TARGET);
    views[0]!.contents.fire("did-finish-load");
    machines.show({ ...TARGET, name: "other.tail1234.ts.net" });
    views[1]!.contents.fire("did-finish-load");
    expect(views).toHaveLength(2);
    expect(views[0]!.visible).toBe(false);
    expect(views[0]!.destroyed).toBe(false);
    expect(views[1]!.visible).toBe(true);
    machines.show(TARGET);
    expect(views).toHaveLength(2);
    expect(views[0]!.visible).toBe(true);
    expect(views[1]!.visible).toBe(false);
    expect(views[0]!.contents.loaded).toHaveLength(1);
  });

  it("showLocal hides every machine view; close destroys only that one", () => {
    const { machines, views } = setup();
    machines.show(TARGET);
    machines.showLocal();
    expect(views[0]!.visible).toBe(false);
    expect(views[0]!.destroyed).toBe(false);
    machines.close(TARGET.name);
    expect(views[0]!.destroyed).toBe(true);
    machines.show(TARGET);
    expect(views).toHaveLength(2);
  });

  it("applies the bounds to the views", () => {
    const { machines, views } = setup();
    const rect = { x: 1, y: 2, width: 300, height: 400 };
    machines.setBounds(rect);
    machines.show(TARGET);
    expect(views[0]!.bounds).toEqual(rect);
    const next = { x: 0, y: 0, width: 10, height: 10 };
    machines.setBounds(next);
    expect(views[0]!.bounds).toEqual(next);
  });

  it.each([
    null,
    "studio",
    { name: "studio", webPort: 0, v: VERSION },
    { name: "studio", webPort: 65536, v: VERSION },
    { name: "studio", webPort: 7718.5, v: VERSION },
    { name: "studio", webPort: "7718", v: VERSION },
    { name: "evil.com/path", webPort: 7718, v: VERSION },
    { name: "evil.com:443", webPort: 7718, v: VERSION },
    { name: "user@evil.com", webPort: 7718, v: VERSION },
    { name: "", webPort: 7718, v: VERSION },
    { name: "a..b", webPort: 7718, v: VERSION },
    { name: "studio", webPort: 7718 },
  ])("ignores a bad show argument %j", (target) => {
    const { machines, views, states } = setup();
    machines.show(target as never);
    expect(views).toHaveLength(0);
    expect(states).toEqual([]);
    expect(isMachineTarget(target)).toBe(false);
  });

  it("does not load a machine whose protocol version differs", () => {
    const { machines, views, states } = setup();
    machines.show({ ...TARGET, v: VERSION + 1 });
    expect(views).toHaveLength(0);
    expect(states).toEqual([{ name: TARGET.name, phase: "version" }]);
  });

  it("reports ready, a certificate failure and an offline machine", () => {
    const { machines, views, states } = setup();
    machines.show(TARGET);
    const contents = views[0]!.contents;
    contents.fire("did-finish-load");
    contents.fire("did-fail-load", {}, -202, "ERR_CERT_AUTHORITY_INVALID", `${ORIGIN}/`, true);
    contents.fire("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", `${ORIGIN}/`, true);
    // A subframe failing, or an aborted load, changes nothing.
    contents.fire("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", `${ORIGIN}/x`, false);
    contents.fire("did-fail-load", {}, -3, "ERR_ABORTED", `${ORIGIN}/`, true);
    expect(states.map((s) => s.phase)).toEqual(["loading", "ready", "certificate", "offline"]);
  });

  it("never overrides a certificate error", () => {
    const { machines, views } = setup();
    machines.show(TARGET);
    expect(views[0]!.contents.listeners.has("certificate-error")).toBe(false);
  });

  it("marks its user agent and drops the Electron token", () => {
    const { machines, views, sessions } = setup();
    machines.show(TARGET);
    const agent = views[0]!.contents.userAgent;
    expect(agent.endsWith(" JarvisMachineView/1")).toBe(true);
    expect(agent).not.toContain("Electron/");
    expect(sessions.get("persist:machine:studio.tail1234.ts.net")!.userAgent).toBe(agent);
  });

  describe("navigation", () => {
    it("allows its own origin", () => {
      const { machines, views, opened } = setup();
      machines.show(TARGET);
      const e = event();
      views[0]!.contents.fire("will-navigate", e, `${ORIGIN}/sessions`);
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(opened).toEqual([]);
    });

    it("prevents another origin and opens an https link in the system browser", () => {
      const { machines, views, opened } = setup();
      machines.show(TARGET);
      const contents = views[0]!.contents;
      const link = event();
      contents.fire("will-navigate", link, "https://github.com/x/y/pull/1");
      expect(link.preventDefault).toHaveBeenCalled();
      expect(opened).toEqual(["https://github.com/x/y/pull/1"]);

      // Same host, another port is another origin.
      const port = event();
      contents.fire("will-navigate", port, "https://studio.tail1234.ts.net:7717/");
      expect(port.preventDefault).toHaveBeenCalled();
    });

    it("prevents but never opens a non-https URL", () => {
      const { machines, views, opened } = setup();
      machines.show(TARGET);
      const contents = views[0]!.contents;
      for (const url of [
        "http://example.com/",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "jarvis://x",
      ]) {
        const e = event();
        contents.fire("will-navigate", e, url);
        expect(e.preventDefault).toHaveBeenCalled();
      }
      expect(opened).toEqual([]);
    });

    it("prevents redirects and frame navigations to another origin", () => {
      const { machines, views, opened } = setup();
      machines.show(TARGET);
      const contents = views[0]!.contents;
      const redirect = { preventDefault: vi.fn(), url: "https://evil.example/", isMainFrame: true };
      contents.fire("will-redirect", redirect);
      expect(redirect.preventDefault).toHaveBeenCalled();
      const frame = { preventDefault: vi.fn(), url: "https://evil.example/", isMainFrame: false };
      contents.fire("will-frame-navigate", frame);
      expect(frame.preventDefault).toHaveBeenCalled();
      const own = { preventDefault: vi.fn(), url: `${ORIGIN}/x`, isMainFrame: false };
      contents.fire("will-frame-navigate", own);
      expect(own.preventDefault).not.toHaveBeenCalled();
      // A main-frame redirect away opens externally; a subframe never does.
      expect(opened).toEqual(["https://evil.example/"]);
    });

    it("denies every popup, opening an https one in the system browser", () => {
      let t = 0;
      const { machines, views, opened } = setup({ now: () => (t += 2000) });
      machines.show(TARGET);
      const handler = views[0]!.contents.openHandler!;
      expect(handler({ url: "https://github.com/" })).toEqual({ action: "deny" });
      expect(handler({ url: `${ORIGIN}/other` })).toEqual({ action: "deny" });
      expect(handler({ url: "about:blank" })).toEqual({ action: "deny" });
      expect(handler({ url: "file:///x" })).toEqual({ action: "deny" });
      expect(opened).toEqual(["https://github.com/", `${ORIGIN}/other`]);
    });
  });

  describe("permissions", () => {
    function handlers() {
      const { machines, sessions } = setup();
      machines.show(TARGET);
      const session = sessions.get("persist:machine:studio.tail1234.ts.net")!;
      const request = (permission: string, details: Record<string, unknown>): boolean => {
        let granted: boolean | undefined;
        session.requestHandler!(
          {} as never,
          permission as never,
          (value) => {
            granted = value;
          },
          details as never,
        );
        return granted!;
      };
      const check = (permission: string, origin: string, details: Record<string, unknown>) =>
        session.checkHandler!(null, permission as never, origin, details as never);
      return { machines, session, request, check };
    }

    it("allows the machine's own microphone", () => {
      const { request, check } = handlers();
      expect(
        request("media", {
          requestingUrl: `${ORIGIN}/voice`,
          securityOrigin: `${ORIGIN}/`,
          mediaTypes: ["audio"],
          isMainFrame: true,
        }),
      ).toBe(true);
      expect(check("media", ORIGIN, { mediaType: "audio", isMainFrame: true })).toBe(true);
    });

    it("denies video, other origins and every other permission", () => {
      const { request, check } = handlers();
      const own = { requestingUrl: `${ORIGIN}/`, isMainFrame: true };
      expect(request("media", { ...own, mediaTypes: ["audio", "video"] })).toBe(false);
      expect(request("media", { ...own, mediaTypes: ["video"] })).toBe(false);
      expect(request("media", { ...own, mediaTypes: [] })).toBe(false);
      expect(request("media", { ...own })).toBe(false);
      expect(
        request("media", {
          requestingUrl: "https://evil.example/",
          mediaTypes: ["audio"],
          isMainFrame: false,
        }),
      ).toBe(false);
      expect(
        request("media", {
          requestingUrl: `${ORIGIN}/`,
          securityOrigin: "https://evil.example",
          mediaTypes: ["audio"],
          isMainFrame: false,
        }),
      ).toBe(false);
      for (const permission of ["geolocation", "notifications", "clipboard-read", "openExternal"]) {
        expect(request(permission, own)).toBe(false);
        expect(check(permission, ORIGIN, { isMainFrame: true })).toBe(false);
      }
      expect(check("media", ORIGIN, { mediaType: "video", isMainFrame: true })).toBe(false);
      expect(check("media", ORIGIN, { mediaType: "unknown", isMainFrame: true })).toBe(false);
      expect(
        check("media", "https://evil.example", { mediaType: "audio", isMainFrame: true }),
      ).toBe(false);
    });

    it("sets the handlers once per session", () => {
      const { machines, session } = handlers();
      machines.close(TARGET.name);
      machines.show(TARGET);
      expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
      expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    });
  });
});
