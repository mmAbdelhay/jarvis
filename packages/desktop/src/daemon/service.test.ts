import { describe, expect, it } from "vitest";
import { createServiceManager, type ServiceFileSystem, type ServicePlatform } from "./service.js";

type Operation =
  | ["mkdir", string, { recursive: true }]
  | ["writeFile", string, string, { mode?: number } | undefined]
  | ["rm", string, { force: true }];
type Invocation = [string, readonly string[]];

function setup(
  platform: ServicePlatform,
  options: {
    installed?: boolean;
    results?: Array<{ code: number; stdout: string; stderr: string }>;
  } = {},
) {
  const operations: Operation[] = [];
  const invocations: Invocation[] = [];
  const detachedInvocations: Invocation[] = [];
  const fs: ServiceFileSystem = {
    mkdir: async (path, mkdirOptions) => void operations.push(["mkdir", path, mkdirOptions]),
    writeFile: async (path, contents, writeOptions) =>
      void operations.push(["writeFile", path, contents, writeOptions]),
    rm: async (path, rmOptions) => void operations.push(["rm", path, rmOptions]),
    exists: async () => options.installed ?? true,
  };
  const results = [...(options.results ?? [])];
  const manager = createServiceManager({
    platform,
    home: "/Users/Jarvis User",
    uid: 502,
    execPath:
      platform === "win32"
        ? "C:\\Program Files\\Jarvis\\Jarvis.exe"
        : "/Applications/Jarvis App/Jarvis",
    daemonScript: "/Applications/Jarvis App/daemon-main.js",
    fs,
    run: async (command, args) => {
      invocations.push([command, args]);
      return results.shift() ?? { code: 0, stdout: "", stderr: "" };
    },
    spawnDetached: async (command, args) => void detachedInvocations.push([command, args]),
  });
  return { manager, operations, invocations, detachedInvocations };
}

const darwinPrint: Invocation = ["launchctl", ["print", "gui/502/dev.jarvis.daemon"]];
const darwinBootstrap: Invocation = [
  "launchctl",
  ["bootstrap", "gui/502", "/Users/Jarvis User/Library/LaunchAgents/dev.jarvis.daemon.plist"],
];
const darwinBootout: Invocation = ["launchctl", ["bootout", "gui/502/dev.jarvis.daemon"]];
const darwinKickstart: Invocation = ["launchctl", ["kickstart", "-k", "gui/502/dev.jarvis.daemon"]];

describe("createServiceManager", () => {
  it("replaces a loaded macOS launch agent during install", async () => {
    const { manager, invocations } = setup("darwin");
    await manager.install();
    expect(invocations).toEqual([darwinPrint, darwinBootout, darwinBootstrap]);
  });

  it("bootstraps an unloaded macOS launch agent during install", async () => {
    const { manager, invocations } = setup("darwin", {
      results: [{ code: 113, stdout: "", stderr: "not loaded" }],
    });
    await manager.install();
    expect(invocations).toEqual([darwinPrint, darwinBootstrap]);
  });

  it("continues macOS install when bootout of a loaded job fails", async () => {
    const { manager, invocations } = setup("darwin", {
      results: [
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "already exiting" },
        { code: 0, stdout: "", stderr: "" },
      ],
    });
    await expect(manager.install()).resolves.toBeUndefined();
    expect(invocations).toEqual([darwinPrint, darwinBootout, darwinBootstrap]);
  });

  it("uses load-aware macOS lifecycle commands and tolerates stop failure", async () => {
    const context = setup("darwin", {
      results: [
        { code: 113, stdout: "", stderr: "not loaded" },
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "not loaded" },
        { code: 113, stdout: "", stderr: "not loaded" },
      ],
    });
    await context.manager.start();
    expect(context.invocations).toEqual([darwinPrint, darwinBootstrap]);
    context.invocations.length = 0;
    await expect(context.manager.stop()).resolves.toBeUndefined();
    expect(context.invocations).toEqual([darwinBootout]);
    context.invocations.length = 0;
    await context.manager.restart();
    expect(context.invocations).toEqual([darwinPrint, darwinBootstrap]);
  });

  it("kickstarts a loaded macOS launch agent on start and restart", async () => {
    const context = setup("darwin");
    await context.manager.start();
    expect(context.invocations).toEqual([darwinPrint, darwinKickstart]);
    context.invocations.length = 0;
    await context.manager.restart();
    expect(context.invocations).toEqual([darwinPrint, darwinKickstart]);
  });

  it.each([
    [{ code: 0, stdout: "state = running\n", stderr: "" }, true, "running"],
    [{ code: 0, stdout: "state = waiting\n", stderr: "" }, true, "stopped"],
    [{ code: 0, stdout: "service state = running later\n", stderr: "" }, true, "stopped"],
    [{ code: 113, stdout: "", stderr: "" }, true, "stopped"],
    [{ code: 113, stdout: "", stderr: "" }, false, "not-installed"],
  ] as const)("parses macOS loaded state", async (result, installed, expected) => {
    const { manager } = setup("darwin", { installed, results: [result] });
    await expect(manager.status()).resolves.toBe(expected);
  });

  it("uses enable --now for a first Linux install", async () => {
    const { manager, invocations } = setup("linux", {
      results: [
        { code: 0, stdout: "", stderr: "" },
        { code: 3, stdout: "inactive", stderr: "" },
      ],
    });
    await manager.install();
    expect(invocations).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "is-active", "jarvisd.service"]],
      ["systemctl", ["--user", "enable", "--now", "jarvisd.service"]],
    ]);
  });

  it("enables and restarts an already-running Linux service during install", async () => {
    const { manager, invocations } = setup("linux");
    await manager.install();
    expect(invocations).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "is-active", "jarvisd.service"]],
      ["systemctl", ["--user", "enable", "jarvisd.service"]],
      ["systemctl", ["--user", "restart", "jarvisd.service"]],
    ]);
  });

  it("manages Windows autostart through the registry without files", async () => {
    const { manager, operations, invocations } = setup("win32");
    await manager.install();
    await manager.uninstall();
    expect(operations).toEqual([]);
    expect(invocations).toEqual([
      [
        "reg",
        [
          "add",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
          "/v",
          "JarvisDaemon",
          "/t",
          "REG_SZ",
          "/d",
          '"C:\\Program Files\\Jarvis\\Jarvis.exe" --jarvis-daemon',
          "/f",
        ],
      ],
      [
        "reg",
        [
          "delete",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
          "/v",
          "JarvisDaemon",
          "/f",
        ],
      ],
    ]);
  });

  it("starts Windows detached and directs stop/restart to the control socket", async () => {
    const { manager, invocations, detachedInvocations } = setup("win32");
    await expect(manager.start()).resolves.toBeUndefined();
    await expect(manager.stop()).resolves.toEqual({ ok: false, reason: "use-control-socket" });
    await expect(manager.restart()).resolves.toEqual({ ok: false, reason: "use-control-socket" });
    expect(detachedInvocations).toEqual([
      ["C:\\Program Files\\Jarvis\\Jarvis.exe", ["--jarvis-daemon"]],
    ]);
    expect(invocations).toEqual([]);
  });

  it.each([
    [{ code: 0, stdout: "value", stderr: "" }, "stopped"],
    [{ code: 1, stdout: "", stderr: "missing" }, "not-installed"],
  ] as const)("maps Windows registry query status", async (result, expected) => {
    const { manager } = setup("win32", { results: [result] });
    await expect(manager.status()).resolves.toBe(expected);
  });

  it("tolerates missing services during uninstall", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const { manager } = setup(platform, {
        results: [
          { code: 1, stdout: "", stderr: "not found" },
          { code: 0, stdout: "", stderr: "" },
        ],
      });
      await expect(manager.uninstall()).resolves.toBeUndefined();
    }
  });
});
