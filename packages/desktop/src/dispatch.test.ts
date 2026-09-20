import { readFileSync } from "node:fs";
import type { GitProvider, Session, WorkspaceState, WorkspaceTab } from "@jarvis/core";
import { describe, expect, it, vi } from "vitest";
import { INVOKE_CHANNELS } from "./channels.js";
import { ELECTRON_BOUND_CHANNELS } from "./desktop-only.js";
import { parseConfig, type JarvisConfig } from "./config.js";
import {
  createDispatchTable,
  DESKTOP_ORIGIN,
  invalidArgument,
  TURNS_LIST_MAX,
  type DispatchDeps,
  type Origin,
} from "./dispatch.js";
import { createDockerFollowers, DESKTOP_OWNER } from "./docker-followers.js";
import { createGitHandlers } from "./ipc.js";
import { MESSAGES } from "./messages.js";
import { CHANNEL_POLICY, isRemoteAllowed } from "./remote-policy.js";

/** Every dep a vi.fn; a test overrides only what it asserts on. */
export function fakeDeps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    setup: {
      check: vi.fn(async () => ({ ok: true, value: [] })),
      install: vi.fn(async () => ({ ok: true, value: undefined })),
    },
    orchestrator: { handle: vi.fn(async () => undefined), transcript: vi.fn(() => []) },
    sessionStore: { history: vi.fn(() => []) },
    sessions: {
      log: vi.fn(() => "backlog"),
      write: vi.fn(),
      resize: vi.fn(),
      snapshot: vi.fn(() => ({ text: "backlog", end: 7 })),
      list: vi.fn(() => []),
    },
    refreshSessions: vi.fn(async () => ({ jarvis: 0, external: 0, importedTranscripts: 0 })),
    sessionTranscript: vi.fn(async () => ({ ok: true, value: "" })),
    sessionResume: vi.fn(async () => ({ ok: true, value: undefined })),
    voice: { setTarget: vi.fn() },
    git: {
      changes: vi.fn(async () => ({ ok: true, value: [] })),
      fileDiff: vi.fn(async () => ({ ok: true, value: "" })),
      setStaged: vi.fn(async () => ({ ok: true, value: undefined })),
      commit: vi.fn(async () => ({ ok: true, value: undefined })),
    },
    workspace: {
      state: vi.fn(() => ({ tabs: [], activeTabId: undefined })),
      open: vi.fn(),
      close: vi.fn(),
      activate: vi.fn(),
      rename: vi.fn(),
      move: vi.fn(),
      navigate: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      reload: vi.fn(),
      setDevTools: vi.fn(),
      setDevToolsDock: vi.fn(),
      setVisible: vi.fn(),
      hideAll: vi.fn(),
      requestPictureInPicture: vi.fn(),
      openDocker: vi.fn(),
      openApi: vi.fn(),
    },
    terminal: {
      open: vi.fn(() => ({ ok: true, value: "" })),
      input: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      split: vi.fn(),
      closePane: vi.fn(),
      suggest: vi.fn(async () => []),
      history: vi.fn(async () => []),
      listDir: vi.fn(async () => []),
      openFile: vi.fn(async () => ({ ok: true, value: undefined })),
      settings: vi.fn(() => ({
        blocks: false,
        inputEditor: false,
        notifyAfterSeconds: 0,
        home: "",
        scrollback: 0,
      })),
      workflows: vi.fn(async () => []),
      terminalAi: vi.fn(async () => ""),
      chips: vi.fn(async () => undefined),
    },
    shells: {
      log: vi.fn(() => "backlog"),
      snapshot: vi.fn(() => ({ text: "backlog", end: 7 })),
      panes: vi.fn(() => []),
    },
    followers: {
      follow: vi.fn(() => "following" as const),
      unfollow: vi.fn(() => true),
      ownerOf: vi.fn(() => undefined),
      unfollowOwnedBy: vi.fn(() => 0),
      closeAll: vi.fn(),
    },
    editor: {
      open: vi.fn(async () => ({ ok: true, value: "" })),
      roots: vi.fn(async () => []),
    },
    database: {
      open: vi.fn(async () => ({ ok: true, value: { url: "", login: "", password: "" } })),
    },
    cluster: {
      names: vi.fn(async () => []),
      open: vi.fn(async () => ({ ok: true, value: "" })),
    },
    chat: {
      names: vi.fn(async () => []),
      open: vi.fn(async () => ({ ok: true, value: "" })),
    },
    docker: {
      view: vi.fn(async () => ({
        ok: true,
        value: { rows: [], composeProject: undefined, composeWorkingDir: undefined },
      })),
      start: vi.fn(async () => ({ ok: true, value: undefined })),
      stop: vi.fn(async () => ({ ok: true, value: undefined })),
      restart: vi.fn(async () => ({ ok: true, value: undefined })),
      composeUp: vi.fn(async () => ({ ok: true, value: undefined })),
      composeDown: vi.fn(async () => ({ ok: true, value: undefined })),
      shell: vi.fn(() => ({ ok: true, value: undefined })),
      names: vi.fn(() => ({ ok: true, value: [] })),
      containers: vi.fn(async () => ({ ok: true, value: [] })),
    },
    projects: { app: {} },
    dockerConfig: { app: [{ name: "Web", container: "web" }] },
    language: "en",
    api: {
      collections: vi.fn(async () => ({ ok: true, value: [] })),
      tree: vi.fn(async () => ({ ok: true, value: { items: [] } })),
      request: vi.fn(async () => ({ ok: true, value: {} })),
      save: vi.fn(async () => ({ ok: true, value: undefined })),
      send: vi.fn(async () => ({ ok: true, value: {} })),
      history: vi.fn(async () => ({ ok: true, value: [] })),
      clearHistory: vi.fn(async () => ({ ok: true, value: undefined })),
      cookies: vi.fn(async () => ({ ok: true, value: [] })),
      clearCookies: vi.fn(async () => ({ ok: true, value: [] })),
      removeCookie: vi.fn(async () => ({ ok: true, value: [] })),
      settings: vi.fn(async () => ({ ok: true, value: {} })),
      saveSettings: vi.fn(async () => ({ ok: true, value: {} })),
      curl: vi.fn(async () => ({ ok: true, value: "" })),
      createRequest: vi.fn(async () => ({ ok: true, value: "" })),
      createFolder: vi.fn(async () => ({ ok: true, value: "" })),
      renameEntry: vi.fn(async () => ({ ok: true, value: "" })),
      deleteEntry: vi.fn(async () => ({ ok: true, value: undefined })),
      createCollection: vi.fn(async () => ({ ok: true, value: "" })),
      saveEnvironment: vi.fn(async () => ({ ok: true, value: "" })),
      importPostman: vi.fn(async () => ({ ok: true, value: "" })),
    },
    voices: {
      list: vi.fn(async () => []),
      preview: vi.fn(),
    },
    bookmarks: {
      list: vi.fn(async () => ({ ok: true, value: [] })),
      add: vi.fn(async () => ({ ok: true, value: [] })),
      remove: vi.fn(async () => ({ ok: true, value: [] })),
      setPinned: vi.fn(async () => ({ ok: true, value: [] })),
      reorder: vi.fn(async () => ({ ok: true, value: [] })),
      rename: vi.fn(async () => ({ ok: true, value: [] })),
    },
    settings: {
      read: vi.fn(async () => ({}) as never),
      save: vi.fn(async () => ({ ok: true }) as never),
      testAgent: vi.fn(async () => ({}) as never),
      restart: vi.fn(),
    },
    providers: { refreshCapacity: vi.fn(async () => undefined) },
    voiceControl: { start: vi.fn(), stop: vi.fn() },
    readFile: vi.fn(async () => "{}"),
    uploads: { readJson: vi.fn(async () => ({ ok: true, value: {} })) },
    networkInterfaces: vi.fn(() => ({})),
    remote: {
      status: vi.fn(() => ({
        enabled: false,
        listening: undefined,
        pairing: { kind: "closed" },
        devices: [],
        problem: undefined,
      })),
      openPairing: vi.fn(async () => "opened"),
      cancelPairing: vi.fn(),
      decidePairing: vi.fn(() => true),
      revoke: vi.fn(async () => true),
      registerPush: vi.fn(async () => ({ registered: true as const, laptopEnabled: false })),
      unregisterPush: vi.fn(async () => undefined),
    },
    sidecars: {
      publish: vi.fn(() => ({ ok: true as const, url: "" })),
    },
    notifier: { commandFinished: vi.fn() },
    tailscaleCert: {
      obtain: vi.fn(async () => ({
        ok: true as const,
        certPath: "/x/.config/jarvis/tls/m.crt",
        keyPath: "/x/.config/jarvis/tls/m.key",
        name: "m.tailnet.ts.net",
      })),
    },
    writeConfig: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  } as DispatchDeps;
}

const call = (table: ReturnType<typeof createDispatchTable>, channel: string, ...args: unknown[]) =>
  callAs(table, DESKTOP_ORIGIN, channel, ...args);

const REMOTE_ORIGIN: Origin = { kind: "remote", deviceId: "d1", deviceName: "Phone" };

const callAs = (
  table: ReturnType<typeof createDispatchTable>,
  origin: Origin,
  channel: string,
  ...args: unknown[]
) =>
  (table as Record<string, (a: readonly unknown[], o: Origin) => unknown>)[channel]!(args, origin);

describe("dispatch table: guarded remote API", () => {
  it("binds api:send to the authenticated remote device, never a caller argument", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    const request = {
      http: { method: "get", url: "https://api.test", body: "none", auth: "none" },
    };

    await callAs(table, REMOTE_ORIGIN, "api:send", "app", request, {}, { deviceId: "attacker" });

    expect(deps.api.send).toHaveBeenCalledWith("app", request, {}, { deviceId: "d1" });
  });

  it("does not attach remote context to an existing desktop api:send call", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    const request = {
      http: { method: "get", url: "https://api.test", body: "none", auth: "none" },
    };

    await call(table, "api:send", "app", request, {});

    expect(deps.api.send).toHaveBeenCalledWith("app", request, {});
  });
});

describe("dispatch table: sessions and git", () => {
  it('session:log reads the backlog for a string id and returns "" otherwise', async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    expect(await call(table, "session:log", "s1")).toBe("backlog");
    expect(await call(table, "session:log", 42)).toBe("");
    expect(deps.sessions.log).toHaveBeenCalledTimes(1);
  });

  it('session:snapshot returns the fake\'s snapshot for a string id, {text:"",end:0} otherwise without calling it', async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    expect(await call(table, "session:snapshot", "s1")).toEqual({ text: "backlog", end: 7 });
    expect(deps.sessions.snapshot).toHaveBeenCalledTimes(1);
    expect(deps.sessions.snapshot).toHaveBeenCalledWith("s1");

    expect(await call(table, "session:snapshot", 42)).toEqual({ text: "", end: 0 });
    expect(deps.sessions.snapshot).toHaveBeenCalledTimes(1);
  });

  it("sessions:list ignores its args and returns the fake's list by identity", async () => {
    const deps = fakeDeps();
    const list: Session[] = [];
    (deps.sessions.list as ReturnType<typeof vi.fn>).mockReturnValue(list);
    const table = createDispatchTable(deps);

    expect(await call(table, "sessions:list")).toBe(list);
    expect(await call(table, "sessions:list", "junk", 7)).toBe(list);
    expect(deps.sessions.list).toHaveBeenCalledTimes(2);
  });

  it("sessions:refresh ignores its args and forwards to deps.refreshSessions", async () => {
    const deps = fakeDeps();
    const result = { jarvis: 1, external: 2, importedTranscripts: 3 };
    (deps.refreshSessions as ReturnType<typeof vi.fn>).mockResolvedValue(result);
    const table = createDispatchTable(deps);

    expect(await call(table, "sessions:refresh", "junk")).toBe(result);
    expect(deps.refreshSessions).toHaveBeenCalledTimes(1);
  });

  it("session:input types only when both arguments are strings", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "session:input", "s1", "ls\n");
    await call(table, "session:input", "s1", 7);
    await call(table, "session:input", undefined, "x");
    expect(deps.sessions.write).toHaveBeenCalledTimes(1);
    expect(deps.sessions.write).toHaveBeenCalledWith("s1", "ls\n");
  });

  it("session:resize rejects a non-string id and non-finite sizes", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "session:resize", "s1", 80, 24);
    await call(table, "session:resize", "s1", Number.NaN, 24);
    await call(table, "session:resize", 1, 80, 24);
    expect(deps.sessions.resize).toHaveBeenCalledTimes(1);
    expect(deps.sessions.resize).toHaveBeenCalledWith("s1", 80, 24);
  });

  // Minor: cols/rows must be plain integers in [1, 1000] — not NaN, not a
  // float, not an absurdly large pty a phone or a compromised renderer
  // could ask for.
  it("session:resize rejects a float, zero, a negative, Infinity and an oversized value", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "session:resize", "s1", 80.5, 24);
    await call(table, "session:resize", "s1", 0, 24);
    await call(table, "session:resize", "s1", -1, 24);
    await call(table, "session:resize", "s1", Number.POSITIVE_INFINITY, 24);
    await call(table, "session:resize", "s1", 1001, 24);
    expect(deps.sessions.resize).not.toHaveBeenCalled();
  });

  it("terminal:resize rejects a non-string id and out-of-range sizes", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "terminal:resize", "t1", 80, 24);
    await call(table, "terminal:resize", 1, 80, 24);
    await call(table, "terminal:resize", "t1", 0, 24);
    await call(table, "terminal:resize", "t1", 1.5, 24);
    expect(deps.terminal.resize).toHaveBeenCalledTimes(1);
    expect(deps.terminal.resize).toHaveBeenCalledWith("t1", 80, 24);
  });

  // Replaces ipc.test.ts's "passes the argument, not the event" source grep:
  // the table receives args only, so there is no event to pass by mistake.
  it("session:transcript and session:resume receive the arguments, not an event", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "session:transcript", "s1");
    await call(table, "session:resume", "s1", "app");
    expect(deps.sessionTranscript).toHaveBeenCalledWith("s1");
    expect(deps.sessionResume).toHaveBeenCalledWith("s1", "app");
  });

  it("voice:target stores a string id and clears on anything else", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "voice:target", "s1");
    await call(table, "voice:target", null);
    expect(deps.voice.setTarget).toHaveBeenNthCalledWith(1, "s1");
    expect(deps.voice.setTarget).toHaveBeenNthCalledWith(2, undefined);
  });

  it("git:* forwards to the git handlers in argument order", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "git:setStaged", "s1", "a.ts", true);
    await call(table, "git:commit", "s1", "msg");
    expect(deps.git.setStaged).toHaveBeenCalledWith("s1", "a.ts", true);
    expect(deps.git.commit).toHaveBeenCalledWith("s1", "msg");
  });

  it("input:send hands text and language to the orchestrator, with no options object for the desktop origin", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "input:send", "hi", "en");
    expect(deps.orchestrator.handle).toHaveBeenCalledWith("hi", "en");
  });

  it("input:send refuses a non-string text or an undeclared language", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "input:send", 42, "en");
    await call(table, "input:send", "hi", "fr");
    expect(deps.orchestrator.handle).not.toHaveBeenCalled();
  });

  // Ruling 5: a phone's input:send must not speak on the laptop — the
  // exact leak muting was introduced to close.
  // [bite-proof: ignore origin; the same leak input:send used to have]
  it("input:send mutes a remote origin, passing { speakAloud: false }", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await callAs(table, REMOTE_ORIGIN, "input:send", "hi", "en");
    expect(deps.orchestrator.handle).toHaveBeenCalledWith("hi", "en", { speakAloud: false });
  });

  it("turns:list returns the last TURNS_LIST_MAX turns, in order, ignoring its args", async () => {
    const turns = Array.from({ length: 60 }, (_, i) => ({
      role: "assistant" as const,
      text: `t${i}`,
      language: "en" as const,
      at: i,
    }));
    const deps = fakeDeps({ orchestrator: { handle: vi.fn(), transcript: vi.fn(() => turns) } });
    const table = createDispatchTable(deps);
    const expected = turns.slice(-TURNS_LIST_MAX);

    expect(await call(table, "turns:list")).toEqual(expected);
    expect(await call(table, "turns:list", "junk")).toEqual(expected);
  });
});

describe("dispatch table: workspace and docker", () => {
  function workspaceTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
    return {
      id: "tab-1",
      project: "app",
      url: "",
      kind: "terminal",
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: undefined,
      hasPlayingVideo: false,
      pageFullscreen: false,
      suspended: false,
      ...overrides,
    };
  }

  it("workspace:snapshot returns the current host state without activating, navigating or spawning", async () => {
    const state: WorkspaceState = {
      tabs: [workspaceTab({ id: "tab-1", kind: "web" })],
      activeTabId: "tab-1",
    };
    const deps = fakeDeps({
      workspace: { ...fakeDeps().workspace, state: vi.fn(() => state) },
    });
    const table = createDispatchTable(deps);

    expect(await call(table, "workspace:snapshot")).toBe(state);
    expect(deps.workspace.state).toHaveBeenCalledTimes(1);
    expect(deps.workspace.open).not.toHaveBeenCalled();
    expect(deps.workspace.activate).not.toHaveBeenCalled();
    expect(deps.workspace.navigate).not.toHaveBeenCalled();
    expect(deps.terminal.open).not.toHaveBeenCalled();
    expect(deps.terminal.split).not.toHaveBeenCalled();
  });

  it("workspace:rename forwards typed arguments and drops a non-string title", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "workspace:rename", "tab-1", "Mine");
    await call(table, "workspace:rename", "tab-1", 7);
    expect(deps.workspace.rename).toHaveBeenCalledTimes(1);
    expect(deps.workspace.rename).toHaveBeenCalledWith("tab-1", "Mine");
  });

  it("workspace:move forwards typed arguments and drops a non-boolean after", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "workspace:move", "tab-1", "tab-2", true);
    await call(table, "workspace:move", "tab-1", "tab-2", "after");
    expect(deps.workspace.move).toHaveBeenCalledTimes(1);
    expect(deps.workspace.move).toHaveBeenCalledWith("tab-1", "tab-2", true);
  });

  it("terminal:panes returns only panes under the exact terminal tab id boundary", async () => {
    const deps = fakeDeps({
      workspace: {
        ...fakeDeps().workspace,
        state: vi.fn(() => ({
          tabs: [
            workspaceTab({ id: "tab-1", kind: "terminal" }),
            workspaceTab({ id: "tab-10", kind: "terminal" }),
          ],
          activeTabId: "tab-1",
        })),
      },
      shells: {
        log: vi.fn(() => "backlog"),
        snapshot: vi.fn(() => ({ text: "backlog", end: 7 })),
        panes: vi.fn(() => [
          { paneKey: "tab-1", exited: false },
          { paneKey: "tab-1:split-a", exited: true },
          { paneKey: "tab-10", exited: false },
          { paneKey: "tab-10:split-a", exited: false },
          { paneKey: "tab-1ish", exited: false },
        ]),
      },
    });
    const table = createDispatchTable(deps);

    expect(await call(table, "terminal:panes", "tab-1")).toEqual([
      { paneKey: "tab-1", exited: false },
      { paneKey: "tab-1:split-a", exited: true },
    ]);
    expect(deps.terminal.open).not.toHaveBeenCalled();
    expect(deps.terminal.split).not.toHaveBeenCalled();
    expect(deps.terminal.closePane).not.toHaveBeenCalled();
    expect(deps.terminal.close).not.toHaveBeenCalled();
  });

  it("terminal:panes returns [] for malformed, unknown, non-terminal and closed tab ids", async () => {
    const deps = fakeDeps({
      workspace: {
        ...fakeDeps().workspace,
        state: vi.fn(() => ({
          tabs: [
            workspaceTab({ id: "terminal-tab", kind: "terminal" }),
            workspaceTab({ id: "api-tab", kind: "api" }),
          ],
          activeTabId: "terminal-tab",
        })),
      },
      shells: {
        log: vi.fn(() => "backlog"),
        snapshot: vi.fn(() => ({ text: "backlog", end: 7 })),
        panes: vi.fn(() => [
          { paneKey: "terminal-tab", exited: false },
          { paneKey: "closed-tab", exited: true },
        ]),
      },
    });
    const table = createDispatchTable(deps);

    expect(await call(table, "terminal:panes")).toEqual([]);
    expect(await call(table, "terminal:panes", 7)).toEqual([]);
    expect(await call(table, "terminal:panes", "unknown-tab")).toEqual([]);
    expect(await call(table, "terminal:panes", "api-tab")).toEqual([]);
    expect(await call(table, "terminal:panes", "closed-tab")).toEqual([]);
  });

  it('workspace:open coerces an unknown kind to "web" and drops a non-string detail', async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "workspace:open", "app", "example.com", "bogus", 7);
    expect(deps.workspace.open).toHaveBeenCalledWith("app", "example.com", "web", undefined);
    await call(table, "workspace:open", 1, "x");
    expect(deps.workspace.open).toHaveBeenCalledTimes(1);
  });

  // Replaces ipc.test.ts's source grep of the workspace:close body.
  it("workspace:close reaps the tab's shell and log follower before closing it", async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      terminal: { ...fakeDeps().terminal, close: vi.fn(() => order.push("terminal")) },
      followers: {
        follow: vi.fn(() => "following" as const),
        unfollow: vi.fn(() => {
          order.push("unfollow");
          return true;
        }),
        ownerOf: vi.fn(() => undefined),
        unfollowOwnedBy: vi.fn(() => 0),
        closeAll: vi.fn(),
      },
      workspace: { ...fakeDeps().workspace, close: vi.fn(() => order.push("workspace")) },
    });
    const table = createDispatchTable(deps);
    await call(table, "workspace:close", "t1");
    expect(order).toEqual(["terminal", "unfollow", "workspace"]);
    await call(table, "workspace:close", 5);
    expect(order).toHaveLength(3);
  });

  it("workspace:devtools requires a string tab and a boolean flag", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "workspace:devtools", "t1", "yes");
    await call(table, "workspace:devtools", "t1", true);
    expect(deps.workspace.setDevTools).toHaveBeenCalledTimes(1);
  });

  it("cluster:open reads background only as the literal true", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "cluster:open", "app", "prod", "true");
    expect(deps.cluster.open).toHaveBeenCalledWith("app", "prod", { background: false });
  });

  describe("dispatch table: remote sidecar opens", () => {
    // [bite-proof: return the manager's loopback URL to a remote origin;
    // "remote editor:open never returns a loopback URL" fails]
    it("editor:open for a remote origin publishes the manager's loopback URL and returns the proxy URL", async () => {
      const publish = vi.fn(() => ({
        ok: true as const,
        url: "https://mac.tail.ts.net:7717/s/h/?k=k",
      }));
      const deps = fakeDeps({
        editor: {
          open: vi.fn(async () => ({
            ok: true as const,
            value: "http://127.0.0.1:4321/?folder=%2Fp",
          })),
          roots: vi.fn(async () => []),
        },
        sidecars: { publish },
      });
      const table = createDispatchTable(deps);
      const result = await callAs(table, REMOTE_ORIGIN, "editor:open", "app");
      expect(publish).toHaveBeenCalledWith("d1", {
        kind: "editor",
        url: "http://127.0.0.1:4321/?folder=%2Fp",
      });
      expect(result).toEqual({ ok: true, value: "https://mac.tail.ts.net:7717/s/h/?k=k" });
    });

    // [bite-proof: spread the manager result into the value; the keys test fails]
    it("database:open for a remote origin forwards basicAuth and returns only { url }", async () => {
      const publish = vi.fn(() => ({
        ok: true as const,
        url: "https://mac.tail.ts.net:7717/s/h/?k=k",
      }));
      const deps = fakeDeps({
        database: {
          open: vi.fn(async () => ({
            ok: true as const,
            value: { url: "http://127.0.0.1:3000/", login: "u", password: "p" },
          })),
        },
        sidecars: { publish },
      });
      const table = createDispatchTable(deps);
      const result = (await callAs(table, REMOTE_ORIGIN, "database:open", "app")) as {
        ok: true;
        value: Record<string, unknown>;
      };
      expect(publish).toHaveBeenCalledWith("d1", {
        kind: "database",
        url: "http://127.0.0.1:3000/",
        basicAuth: { login: "u", password: "p" },
      });
      expect(result.ok).toBe(true);
      expect(Object.keys(result.value)).toEqual(["url"]);
      expect(result.value["url"]).toBe("https://mac.tail.ts.net:7717/s/h/?k=k");
    });

    // [bite-proof: return the manager's result as-is; the keys test fails]
    it("database:open for a desktop origin returns only { url }, never login/password", async () => {
      const deps = fakeDeps({
        database: {
          open: vi.fn(async () => ({
            ok: true as const,
            value: { url: "http://127.0.0.1:3000/", login: "u", password: "p" },
          })),
        },
      });
      const table = createDispatchTable(deps);
      const result = (await call(table, "database:open", "app")) as {
        ok: true;
        value: Record<string, unknown>;
      };
      expect(result.ok).toBe(true);
      expect(Object.keys(result.value)).toEqual(["url"]);
      expect(result.value["url"]).toBe("http://127.0.0.1:3000/");
    });

    // [bite-proof: pass the argument through; the test fails]
    it("cluster:open for a remote origin forces background:true even when the phone sent false", async () => {
      const publish = vi.fn(() => ({
        ok: true as const,
        url: "https://mac.tail.ts.net:7717/s/h/?k=k",
      }));
      const deps = fakeDeps({
        cluster: {
          names: vi.fn(async () => []),
          open: vi.fn(async () => ({ ok: true as const, value: "http://127.0.0.1:5000/#/c/x" })),
        },
        sidecars: { publish },
      });
      const table = createDispatchTable(deps);
      const result = await callAs(table, REMOTE_ORIGIN, "cluster:open", "app", "prod", false);
      expect(deps.cluster.open).toHaveBeenCalledWith("app", "prod", { background: true });
      expect(result).toEqual({ ok: true, value: "https://mac.tail.ts.net:7717/s/h/?k=k" });
    });

    it("a remote sidecar publish failure returns the reason's bilingual text and never the manager's URL", async () => {
      const publish = vi.fn(() => ({ ok: false as const, reason: "needs-certificate" as const }));
      const deps = fakeDeps({ sidecars: { publish } });
      const table = createDispatchTable(deps);
      const result = await callAs(table, REMOTE_ORIGIN, "editor:open", "app");
      expect(result).toEqual({
        ok: false,
        text: MESSAGES.sidecarProxyUnavailable("needs-certificate", "en"),
        language: "en",
      });
    });

    it("a manager failure returns the manager's own localised text, never touching sidecars.publish", async () => {
      const publish = vi.fn();
      const deps = fakeDeps({
        editor: {
          open: vi.fn(async () => ({ ok: false as const, text: "nope", language: "en" as const })),
          roots: vi.fn(async () => []),
        },
        sidecars: { publish },
      });
      const table = createDispatchTable(deps);
      const result = await callAs(table, REMOTE_ORIGIN, "editor:open", "app");
      expect(result).toEqual({ ok: false, text: "nope", language: "en" });
      expect(publish).not.toHaveBeenCalled();
    });

    it("a desktop origin never calls sidecars.publish and gets the manager's own URL back", async () => {
      const publish = vi.fn();
      const deps = fakeDeps({
        editor: {
          open: vi.fn(async () => ({ ok: true as const, value: "http://127.0.0.1:4321/" })),
          roots: vi.fn(async () => []),
        },
        sidecars: { publish },
      });
      const table = createDispatchTable(deps);
      const result = await call(table, "editor:open", "app");
      expect(result).toEqual({ ok: true, value: "http://127.0.0.1:4321/" });
      expect(publish).not.toHaveBeenCalled();
    });
  });

  it("docker:open refuses an undeclared project with a bilingual error", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    const result = (await call(table, "docker:open", "nope")) as {
      ok: boolean;
      text?: string;
      language?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.text).toBeTruthy();
    expect(["ar", "en"]).toContain(result.language);
    expect(deps.workspace.openDocker).not.toHaveBeenCalled();
  });

  it("docker:follow follows only a declared container, replacing the tab's previous follower", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    expect(((await call(table, "docker:follow", "t1", "app", "db")) as { ok: boolean }).ok).toBe(
      false,
    );
    expect(((await call(table, "docker:follow", "t1", "app", "web")) as { ok: boolean }).ok).toBe(
      true,
    );
    expect(deps.followers.follow).toHaveBeenCalledWith("t1", "web", DESKTOP_OWNER);
  });

  // [bite-proof: prototype names are not projects] Reverting parseProjects
  // to build `{}` instead of `Object.create(null)` fails this: `projects["constructor"]`
  // and `projects["__proto__"]` would read back as Object.prototype's own
  // members instead of `undefined`, so docker:open/api:open would treat
  // "constructor" and "__proto__" as declared projects.
  it("docker:open and api:open refuse project names that shadow Object.prototype members", async () => {
    const raw = {
      agents: { claude: { command: "claude" } },
      brain: { cwd: "/tmp/brain" },
      projects: { app: "/tmp/app" },
    };
    const deps = fakeDeps({ projects: parseConfig(raw).projects });
    const table = createDispatchTable(deps);

    for (const [channel, method] of [
      ["docker:open", "openDocker"],
      ["api:open", "openApi"],
    ] as const) {
      for (const name of ["constructor", "__proto__", "toString"]) {
        const result = (await call(table, channel, name)) as { ok: boolean };
        expect(result.ok).toBe(false);
      }
      expect(deps.workspace[method]).not.toHaveBeenCalled();
    }
  });
});

describe("dispatch table: docker follow ownership", () => {
  // A real DockerFollowers (not the vi.fn() stub), so these tests prove
  // state — "not closed" — rather than only which arguments a mock saw.
  function realFollowers() {
    const closes: string[] = [];
    return {
      followers: createDockerFollowers({
        follow: (container: string) => ({ close: () => closes.push(container) }),
        send: vi.fn(),
      }),
      closes,
    };
  }

  it("a remote origin's tab id must match the remote pattern", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    const result = await callAs(table, REMOTE_ORIGIN, "docker:follow", "tab-1", "app", "web");
    expect(result).toEqual(invalidArgument("en"));
    expect(deps.followers.follow).not.toHaveBeenCalled();
  });

  it("a remote origin follows with its device id as owner", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    const result = await callAs(table, REMOTE_ORIGIN, "docker:follow", "remote-x", "app", "web");
    expect(result).toEqual({ ok: true, value: undefined });
    expect(deps.followers.follow).toHaveBeenCalledWith("remote-x", "web", "d1");
  });

  it("owned-elsewhere maps to invalidArgument", async () => {
    const deps = fakeDeps({
      followers: {
        follow: vi.fn(() => "owned-elsewhere" as const),
        unfollow: vi.fn(() => true),
        ownerOf: vi.fn(() => undefined),
        unfollowOwnedBy: vi.fn(() => 0),
        closeAll: vi.fn(),
      },
    });
    const table = createDispatchTable(deps);
    const result = await callAs(table, REMOTE_ORIGIN, "docker:follow", "remote-x", "app", "web");
    expect(result).toEqual(invalidArgument("en"));
  });

  it("limit maps to the dockerFollowLimit text (the fifth follower)", async () => {
    const deps = fakeDeps({
      followers: {
        follow: vi.fn(() => "limit" as const),
        unfollow: vi.fn(() => true),
        ownerOf: vi.fn(() => undefined),
        unfollowOwnedBy: vi.fn(() => 0),
        closeAll: vi.fn(),
      },
    });
    const table = createDispatchTable(deps);
    const result = await callAs(table, REMOTE_ORIGIN, "docker:follow", "remote-e", "app", "web");
    expect(result).toEqual({
      ok: false,
      text: MESSAGES.dockerFollowLimit("en"),
      language: "en",
    });
  });

  it("a remote device cannot unfollow the desktop's follower for the same tab", async () => {
    const { followers, closes } = realFollowers();
    const deps = fakeDeps({ followers });
    const table = createDispatchTable(deps);
    await call(table, "docker:follow", "tab-1", "app", "web");
    await callAs(table, REMOTE_ORIGIN, "docker:unfollow", "tab-1");
    expect(closes).toEqual([]);
    expect(followers.ownerOf("tab-1")).toBe(DESKTOP_OWNER);
  });

  it("workspace:close from the desktop does not close a remote device's follower", async () => {
    const { followers, closes } = realFollowers();
    const deps = fakeDeps({ followers });
    const table = createDispatchTable(deps);
    await callAs(table, REMOTE_ORIGIN, "docker:follow", "remote-x", "app", "web");
    await call(table, "workspace:close", "remote-x");
    expect(closes).toEqual([]);
    expect(followers.ownerOf("remote-x")).toBe("d1");
  });
});

describe("dispatch table: api, dialog, voices", () => {
  it("api:open refuses an undeclared project and opens a declared one", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    expect(((await call(table, "api:open", "nope")) as { ok: boolean }).ok).toBe(false);
    expect(((await call(table, "api:open", "app")) as { ok: boolean }).ok).toBe(true);
    expect(deps.workspace.openApi).toHaveBeenCalledWith("app");
  });

  it("api:rename reads folder only as the literal true", async () => {
    const deps = fakeDeps();
    await call(createDispatchTable(deps), "api:rename", "app", "r/1", "new", "true");
    expect(deps.api.renameEntry).toHaveBeenCalledWith("app", "r/1", "new", false);
  });

  it("dialog:readJson refuses a non-string path and reports a parse failure as a value", async () => {
    const deps = fakeDeps({ readFile: vi.fn(async () => "{not json") });
    const table = createDispatchTable(deps);
    expect(((await call(table, "dialog:readJson", 3)) as { ok: boolean }).ok).toBe(false);
    const bad = (await call(table, "dialog:readJson", "/x.json")) as { ok: boolean; text?: string };
    expect(bad.ok).toBe(false);
    expect(deps.readFile).toHaveBeenCalledWith("/x.json");
  });

  // M9 Task 3.
  it("remote:readJsonUpload refuses a desktop origin outright, without calling uploads.readJson", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    const result = (await call(table, "remote:readJsonUpload", "a".repeat(32))) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(deps.uploads.readJson).not.toHaveBeenCalled();
  });

  it("remote:readJsonUpload refuses a malformed fileId without calling uploads.readJson", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    const result = (await callAs(table, REMOTE_ORIGIN, "remote:readJsonUpload", "not-hex")) as {
      ok: boolean;
    };
    expect(result.ok).toBe(false);
    expect(deps.uploads.readJson).not.toHaveBeenCalled();
  });

  it("remote:readJsonUpload calls uploads.readJson with the authenticated origin's deviceId, never a value from args", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    const fileId = "a".repeat(32);
    await callAs(table, REMOTE_ORIGIN, "remote:readJsonUpload", fileId);
    expect(deps.uploads.readJson).toHaveBeenCalledWith(REMOTE_ORIGIN.deviceId, fileId);
  });

  it("api:importPostman forwards remote:true for a remote origin and remote:false for desktop", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "api:importPostman", "app", "name", {});
    expect(deps.api.importPostman).toHaveBeenLastCalledWith("app", "name", {}, false);
    await callAs(table, REMOTE_ORIGIN, "api:importPostman", "app", "name", {});
    expect(deps.api.importPostman).toHaveBeenLastCalledWith("app", "name", {}, true);
  });

  it("voice:preview ignores a blank name and defaults the language to en", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "voice:preview", "  ", "ar");
    await call(table, "voice:preview", "Samantha", "xx");
    expect(deps.voices.preview).toHaveBeenCalledTimes(1);
    expect(deps.voices.preview).toHaveBeenCalledWith("Samantha", "en");
  });
});

describe("dispatch table: terminal, bookmarks, settings", () => {
  it('terminal:attach returns the backlog for a string pane and "" otherwise', async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    expect(await call(table, "terminal:attach", "p1")).toBe("backlog");
    expect(await call(table, "terminal:attach", {})).toBe("");
  });

  it('terminal:snapshot returns the fake\'s snapshot for a string pane, {text:"",end:0} otherwise without calling it', async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    expect(await call(table, "terminal:snapshot", "tab-1")).toEqual({ text: "backlog", end: 7 });
    expect(deps.shells.snapshot).toHaveBeenCalledTimes(1);
    expect(deps.shells.snapshot).toHaveBeenCalledWith("tab-1");

    expect(await call(table, "terminal:snapshot", 7)).toEqual({ text: "", end: 0 });
    expect(deps.shells.snapshot).toHaveBeenCalledTimes(1);
  });

  it('terminal:open and terminal:workflows coerce a non-string project to ""', async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "terminal:open", 9);
    await call(table, "terminal:workflows", null);
    expect(deps.terminal.open).toHaveBeenCalledWith("");
    expect(deps.terminal.workflows).toHaveBeenCalledWith("");
  });

  it("terminal:open for a remote origin refuses a project deps.projects does not declare", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    const result = await callAs(table, REMOTE_ORIGIN, "terminal:open", "nope");
    expect(result).toEqual({
      ok: false,
      text: MESSAGES.unknownProject("en"),
      language: "en",
    });
    expect(deps.terminal.open).not.toHaveBeenCalled();
  });

  it("terminal:open for a remote origin opens a declared project and carries the tab id through", async () => {
    const deps = fakeDeps({
      terminal: {
        ...fakeDeps().terminal,
        open: vi.fn(() => ({ ok: true as const, value: "tab-9" })),
      },
    });
    const table = createDispatchTable(deps);
    const result = await callAs(table, REMOTE_ORIGIN, "terminal:open", "app");
    expect(deps.terminal.open).toHaveBeenCalledWith("app");
    expect(result).toEqual({ ok: true, value: "tab-9" });
  });

  it("terminal:open for a remote origin drops a second (directory-override) argument", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    const result = await callAs(table, REMOTE_ORIGIN, "terminal:open", "app", "/somewhere/else");
    expect(result).toEqual({
      ok: false,
      text: MESSAGES.unknownProject("en"),
      language: "en",
    });
    expect(deps.terminal.open).not.toHaveBeenCalled();
  });

  it("bookmarks:remove coerces both arguments to strings", async () => {
    const deps = fakeDeps();
    await call(createDispatchTable(deps), "bookmarks:remove", 1, 2);
    expect(deps.bookmarks.remove).toHaveBeenCalledWith("", "");
  });

  it("projects:list returns the declared names, providers:refresh forces a refresh from the desktop", async () => {
    const deps = fakeDeps({ projects: { app: {}, web: {} } });
    const table = createDispatchTable(deps);
    expect(await call(table, "projects:list")).toEqual(["app", "web"]);
    await call(table, "providers:refresh");
    expect(deps.providers.refreshCapacity).toHaveBeenCalledWith({ force: true });
  });

  // I5: a remote origin gets the monitor's own minimum-interval throttle,
  // not the desktop button's bypass — a phone holding the refresh action
  // down must not be able to run up a bill unattended.
  it("providers:refresh does not force from a remote origin", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await callAs(table, REMOTE_ORIGIN, "providers:refresh");
    expect(deps.providers.refreshCapacity).toHaveBeenCalledWith({ force: false });
  });

  // I5: a remote origin's cwd must stay inside the pane's project, and a
  // typed absolute or `~/` path is refused rather than partially honoured.
  it("terminal:suggest forwards remote:true only for a remote origin", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "terminal:suggest", "p1", "ls ", undefined);
    await callAs(table, REMOTE_ORIGIN, "terminal:suggest", "p1", "ls ", undefined);
    expect(deps.terminal.suggest).toHaveBeenNthCalledWith(1, "p1", "ls ", undefined, false);
    expect(deps.terminal.suggest).toHaveBeenNthCalledWith(2, "p1", "ls ", undefined, true);
  });

  // [bite-proof] Reverting settings:save to `([draft]) => settings.save(draft)`
  // fails this — the remote origin's draft.remote would reach save() as
  // `false` instead of the on-disk `true`.
  it("settings:save pins a remote-origin object draft's `remote` to what settings.read() returns", async () => {
    const deps = fakeDeps({
      settings: {
        read: vi.fn(async () => ({ remote: { enabled: true } }) as never),
        save: vi.fn(async () => ({ ok: true }) as never),
        testAgent: vi.fn(async () => ({}) as never),
        restart: vi.fn(),
      },
    });
    const table = createDispatchTable(deps);
    await callAs(table, REMOTE_ORIGIN, "settings:save", { remote: { enabled: false } });
    expect(deps.settings.save).toHaveBeenCalledWith({ remote: { enabled: true } });
    expect(deps.settings.read).toHaveBeenCalledTimes(1);
  });

  it("settings:save leaves a desktop-origin draft's `remote` untouched and never reads", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "settings:save", { remote: { enabled: false } });
    expect(deps.settings.save).toHaveBeenCalledWith({ remote: { enabled: false } });
    expect(deps.settings.read).not.toHaveBeenCalled();
  });

  it("settings:save passes a remote-origin non-object draft through unchanged", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await callAs(table, REMOTE_ORIGIN, "settings:save", "x");
    expect(deps.settings.save).toHaveBeenCalledWith("x");
    expect(deps.settings.read).not.toHaveBeenCalled();
  });

  it("settings:save fails closed when settings.read() rejects on the remote path", async () => {
    const deps = fakeDeps({
      settings: {
        read: vi.fn(async () => {
          throw new Error("disk error");
        }),
        save: vi.fn(async () => ({ ok: true }) as never),
        testAgent: vi.fn(async () => ({}) as never),
        restart: vi.fn(),
      },
    });
    const table = createDispatchTable(deps);
    await expect(
      callAs(table, REMOTE_ORIGIN, "settings:save", { remote: { enabled: false } }),
    ).rejects.toThrow("disk error");
    expect(deps.settings.save).not.toHaveBeenCalled();
  });

  it("voice:start / voice:stop drive the one voice implementation", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "voice:start");
    await call(table, "voice:stop");
    expect(deps.voiceControl.start).toHaveBeenCalledTimes(1);
    expect(deps.voiceControl.stop).toHaveBeenCalledTimes(1);
  });
});

describe("dispatch table: remote access", () => {
  it("remote:bindChoices classifies the injected interface map, re-read on every call", async () => {
    const networkInterfaces = vi.fn(() => ({
      lo0: [{ address: "127.0.0.1" }],
      en0: [{ address: "192.168.1.20" }],
    }));
    const table = createDispatchTable(fakeDeps({ networkInterfaces }));

    expect(await call(table, "remote:bindChoices")).toEqual([
      { address: "127.0.0.1", iface: "lo0", kind: "loopback" },
      { address: "192.168.1.20", iface: "en0", kind: "lan" },
    ]);
    // A VPN brought up while Jarvis runs must appear the next time Settings
    // opens, so the map is never cached.
    await call(table, "remote:bindChoices");
    expect(networkInterfaces).toHaveBeenCalledTimes(2);
  });
});

describe("dispatch table: remote controls", () => {
  it("remote:status reads the controls' status", async () => {
    const status = {
      enabled: true,
      listening: {
        host: "127.0.0.1",
        port: 4100,
        fingerprint: "ab",
        certificate: { source: "self-signed" as const, hostname: undefined },
      },
      pairing: { kind: "closed" as const },
      devices: [],
      problem: undefined,
      sidecarProxy: "off" as const,
    };
    const deps = fakeDeps({ remote: { ...fakeDeps().remote, status: vi.fn(() => status) } });
    const table = createDispatchTable(deps);
    expect(await call(table, "remote:status")).toBe(status);
  });

  it("remote:pair maps each of the three outcomes", async () => {
    for (const [outcome, expected] of [
      ["opened", { ok: true, value: undefined }],
      ["disabled", { ok: false, text: MESSAGES.remotePairingDisabled("en"), language: "en" }],
      ["unavailable", { ok: false, text: MESSAGES.remotePairingUnavailable("en"), language: "en" }],
    ] as const) {
      const deps = fakeDeps({
        remote: { ...fakeDeps().remote, openPairing: vi.fn(async () => outcome) },
      });
      const table = createDispatchTable(deps);
      const result = await call(table, "remote:pair");
      expect(result).toEqual(expected);
    }
  });

  it("remote:cancelPair forwards to the controls", async () => {
    const deps = fakeDeps();
    await call(createDispatchTable(deps), "remote:cancelPair");
    expect(deps.remote.cancelPairing).toHaveBeenCalledTimes(1);
  });

  // A phone can never reach this channel (desktop-only), but the argument
  // coercion is exactly as strict as every other boundary here.
  it('remote:decidePair("id","yes") is ignored: decidePairing is only called for a real boolean', async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    await call(table, "remote:decidePair", "id", "yes");
    expect(deps.remote.decidePairing).not.toHaveBeenCalled();
    await call(table, "remote:decidePair", "id", true);
    expect(deps.remote.decidePairing).toHaveBeenCalledWith("id", true);
  });

  it("remote:revoke refuses a non-string id with invalidArgument", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    const result = await call(table, "remote:revoke", 7);
    expect(result).toEqual(invalidArgument("en"));
    expect(deps.remote.revoke).not.toHaveBeenCalled();
  });

  it("remote:revoke reports remoteRevokeFailed when the controls answer false", async () => {
    const deps = fakeDeps({
      remote: { ...fakeDeps().remote, revoke: vi.fn(async () => false) },
    });
    const table = createDispatchTable(deps);
    const result = await call(table, "remote:revoke", "d1");
    expect(result).toEqual({
      ok: false,
      text: MESSAGES.remoteRevokeFailed("en"),
      language: "en",
    });
  });

  it("remote:revoke returns ok on a true revoke", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    expect(await call(table, "remote:revoke", "d1")).toEqual({ ok: true, value: undefined });
    expect(deps.remote.revoke).toHaveBeenCalledWith("d1");
  });
});

describe("dispatch table: remote:tailscaleCert", () => {
  it("on success, writes remote.tls and sidecarProxy:true through writeConfig and returns the certificate result", async () => {
    const writeConfig = vi.fn(async (_update: (current: JarvisConfig) => JarvisConfig) => ({
      ok: true as const,
    }));
    const deps = fakeDeps({ writeConfig });
    const table = createDispatchTable(deps);

    const result = await call(table, "remote:tailscaleCert");

    expect(result).toEqual({
      ok: true,
      certPath: "/x/.config/jarvis/tls/m.crt",
      keyPath: "/x/.config/jarvis/tls/m.key",
      name: "m.tailnet.ts.net",
    });
    expect(writeConfig).toHaveBeenCalledTimes(1);
    const update = writeConfig.mock.calls[0]![0] as (current: unknown) => unknown;
    const current = {
      remote: { enabled: true, bindAddress: "100.1.2.3", port: 1, sidecarProxy: false, tls: {} },
    };
    expect(update(current)).toEqual({
      remote: {
        enabled: true,
        bindAddress: "100.1.2.3",
        port: 1,
        sidecarProxy: true,
        tls: { certPath: "/x/.config/jarvis/tls/m.crt", keyPath: "/x/.config/jarvis/tls/m.key" },
      },
    });
  });

  it("when obtaining the certificate fails, returns that failure and never calls writeConfig", async () => {
    const writeConfig = vi.fn(async () => ({ ok: true as const }));
    const deps = fakeDeps({
      writeConfig,
      tailscaleCert: {
        obtain: vi.fn(async () => ({
          ok: false as const,
          kind: "not-connected" as const,
          detail: "Tailscale is not connected",
        })),
      },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "remote:tailscaleCert");

    expect(result).toEqual({
      ok: false,
      kind: "not-connected",
      detail: "Tailscale is not connected",
    });
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("when the certificate was obtained but writeConfig fails, reports kind: failed with the write's own detail", async () => {
    const deps = fakeDeps({
      writeConfig: vi.fn(async () => ({ ok: false as const, detail: "validation failed" })),
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "remote:tailscaleCert");

    expect(result).toEqual({ ok: false, kind: "failed", detail: "validation failed" });
  });
});

// Deferred from M2 (Task 7): git:changes/git:diff exercise real coercion
// logic that lives in createGitHandlers, not in dispatch.ts's own body
// (`git.changes(sessionId as string)` trusts the handler to validate) — so
// these run the table over the real handlers with a fake GitProvider and a
// sessions map, the same fake shape ipc.test.ts's handlerFakes() uses.
// setup:check/install and history:list are plain forwards with no
// coercion of their own, so the fakeDeps() mocks already exercise them.
describe("dispatch table: git, setup and history (deferred M2 table tests)", () => {
  function gitFakes(overrides: Partial<GitProvider> = {}) {
    const session: Session = {
      id: "s1",
      project: "acme",
      projectPath: "/projects/acme",
      agentId: "claude-acme",
      state: "running",
      summary: "",
      startedAt: 0,
      lastActivityAt: 1_700_000_000_000,
    };
    const git: GitProvider = {
      changes: vi.fn(async (repoPath: string) => ({
        ok: true,
        value: {
          repoPath,
          branch: "main",
          detached: false,
          files: [],
          insertions: 0,
          deletions: 0,
        },
      })),
      diff: vi.fn(async (_repoPath: string, path: string) => ({
        ok: true,
        value: { path, binary: false, hunks: [] },
      })),
      stage: vi.fn(async () => ({ ok: true, value: null })),
      unstage: vi.fn(async () => ({ ok: true, value: null })),
      commit: vi.fn(async () => ({ ok: true, value: { sha: "a1b2c3d", filesChanged: 0 } })),
      ...overrides,
    } as GitProvider;
    const handlers = createGitHandlers({
      git,
      sessions: { get: (id) => (id === "s1" ? session : undefined) },
      language: "en",
      refresh: vi.fn(async () => undefined),
    });
    return { git, handlers };
  }

  it("git:changes refuses a non-string id without touching git, reports an unknown session, and forwards a known session's projectPath", async () => {
    const { git, handlers } = gitFakes();
    const table = createDispatchTable(fakeDeps({ git: handlers }));

    expect(await call(table, "git:changes", 42)).toEqual(invalidArgument("en"));
    expect(git.changes).not.toHaveBeenCalled();

    const unknown = (await call(table, "git:changes", "nope")) as { ok: boolean; text?: string };
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toBe(MESSAGES.unknownSession("nope", "en"));

    const ok = (await call(table, "git:changes", "s1")) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(git.changes).toHaveBeenCalledWith("/projects/acme");
  });

  it("git:diff refuses a non-string path and forwards a known session's projectPath and path", async () => {
    const { git, handlers } = gitFakes();
    const table = createDispatchTable(fakeDeps({ git: handlers }));

    expect(await call(table, "git:diff", "s1", 7)).toEqual(invalidArgument("en"));
    expect(git.diff).not.toHaveBeenCalled();

    await call(table, "git:diff", "s1", "a.ts");
    expect(git.diff).toHaveBeenCalledWith("/projects/acme", "a.ts");
  });

  it("setup:check and setup:install forward to the setup handlers; policy keeps install desktop-only", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);

    expect(await call(table, "setup:check")).toEqual({ ok: true, value: [] });
    expect(deps.setup.check).toHaveBeenCalledTimes(1);

    await call(table, "setup:install", "ffmpeg");
    expect(deps.setup.install).toHaveBeenCalledWith("ffmpeg");

    expect(isRemoteAllowed("setup:check")).toBe(true);
    expect(isRemoteAllowed("setup:install")).toBe(false);
  });

  it("history:list returns sessionStore.history()'s value as is", async () => {
    const history = [{ id: "s1" }];
    const deps = fakeDeps({ sessionStore: { history: vi.fn(() => history) } });
    const table = createDispatchTable(deps);
    expect(await call(table, "history:list")).toBe(history);
  });
});

// M10 Task 4: the three push channels.
describe("remote:registerPush / remote:unregisterPush / terminal:commandFinished", () => {
  const VALID_REGISTRATION = {
    token: "ExponentPushToken[abcdefgh12345678]",
    platform: "ios" as const,
    language: "en" as const,
  };

  it("remote:registerPush from a desktop origin answers registered:false and never touches the store [bite-proof: drop the origin check]", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);

    const result = await call(table, "remote:registerPush", VALID_REGISTRATION);

    expect(result).toEqual({
      registered: false,
      text: MESSAGES.invalidArgument("en"),
      language: "en",
    });
    expect(deps.remote.registerPush).not.toHaveBeenCalled();
  });

  it("remote:registerPush from a remote origin forwards origin.deviceId, never a deviceId inside the registration", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);

    const result = await callAs(table, REMOTE_ORIGIN, "remote:registerPush", {
      ...VALID_REGISTRATION,
      deviceId: "someone-elses-device",
    });

    expect(result).toEqual({ registered: true, laptopEnabled: false });
    expect(deps.remote.registerPush).toHaveBeenCalledWith("d1", VALID_REGISTRATION);
  });

  it("remote:registerPush with a malformed registration answers registered:false and never forwards", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);

    const result = await callAs(table, REMOTE_ORIGIN, "remote:registerPush", {
      token: "not-a-token",
      platform: "ios",
      language: "en",
    });

    expect(result).toEqual({
      registered: false,
      text: MESSAGES.pushRegisterInvalid("en"),
      language: "en",
    });
    expect(deps.remote.registerPush).not.toHaveBeenCalled();
  });

  it("remote:unregisterPush forwards origin.deviceId, and does nothing from a desktop origin", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);

    await callAs(table, REMOTE_ORIGIN, "remote:unregisterPush");
    expect(deps.remote.unregisterPush).toHaveBeenCalledWith("d1");

    await call(table, "remote:unregisterPush");
    expect(deps.remote.unregisterPush).toHaveBeenCalledTimes(1);
  });

  it("terminal:commandFinished forwards a valid call to notifier.commandFinished", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);

    await call(table, "terminal:commandFinished", "k1", 90, true);

    expect(deps.notifier.commandFinished).toHaveBeenCalledWith("k1", 90, true);
  });

  it.each([
    ["negative seconds", "k1", -1, true],
    ["fractional seconds", "k1", 1.5, true],
    ["seconds over the cap", "k1", 86_401, true],
    ["a non-string paneKey", 42, 10, true],
    ["a non-boolean ok", "k1", 10, "yes"],
  ])("terminal:commandFinished ignores %s", async (_why, paneKey, seconds, ok) => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);

    await call(table, "terminal:commandFinished", paneKey, seconds, ok);

    expect(deps.notifier.commandFinished).not.toHaveBeenCalled();
  });

  it("terminal:commandFinished never forwards from a remote origin", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);

    await callAs(table, REMOTE_ORIGIN, "terminal:commandFinished", "k1", 90, true);

    expect(deps.notifier.commandFinished).not.toHaveBeenCalled();
  });
});

describe("dispatch table: exhaustiveness", () => {
  it("covers every invoke channel that is not Electron-bound, and nothing else", () => {
    const table = createDispatchTable(fakeDeps());
    const expected = new Set(
      Object.values(INVOKE_CHANNELS).filter(
        (c) => !(ELECTRON_BOUND_CHANNELS as readonly string[]).includes(c),
      ),
    );
    expect(new Set(Object.keys(table))).toEqual(expected);
  });

  it("holds every channel the policy allows remotely", () => {
    const table = createDispatchTable(fakeDeps());
    for (const channel of Object.keys(CHANNEL_POLICY)) {
      if (isRemoteAllowed(channel)) expect(table, channel).toHaveProperty(channel);
    }
  });

  it("accepts a remote origin", async () => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    const remote = { kind: "remote", deviceId: "d1", deviceName: "phone" } as const;
    const result = await (table["projects:list"] as (a: readonly unknown[], o: unknown) => unknown)(
      [],
      remote,
    );
    expect(result).toEqual(["app"]);
  });

  it.each(["dispatch.ts", "remote-policy.ts", "docker-followers.ts"])(
    "%s imports nothing from electron",
    (file) => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(source).not.toMatch(/["']electron(\/|["'])/);
    },
  );
});
