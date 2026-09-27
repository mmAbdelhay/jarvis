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
  const fs: ServiceFileSystem = {
    mkdir: async (path, mkdirOptions) => {
      operations.push(["mkdir", path, mkdirOptions]);
    },
    writeFile: async (path, contents, writeOptions) => {
      operations.push(["writeFile", path, contents, writeOptions]);
    },
    rm: async (path, rmOptions) => {
      operations.push(["rm", path, rmOptions]);
    },
    exists: async () => options.installed ?? true,
  };
  const results = [...(options.results ?? [])];
  const manager = createServiceManager({
    platform,
    home: "/Users/Jarvis User",
    uid: 502,
    localAppData: "C:\\Users\\Jarvis User\\AppData\\Local",
    execPath:
      platform === "win32"
        ? "C:\\Program Files\\Jarvis\\Jarvis.exe"
        : "/Applications/Jarvis App/Jarvis",
    daemonScript:
      platform === "win32"
        ? "C:\\Program Files\\Jarvis\\daemon-main.js"
        : "/Applications/Jarvis App/daemon-main.js",
    env: { ELECTRON_RUN_AS_NODE: "ignored" },
    fs,
    run: async (command, args) => {
      invocations.push([command, args]);
      return results.shift() ?? { code: 0, stdout: "", stderr: "" };
    },
  });
  return { manager, operations, invocations };
}

describe("createServiceManager", () => {
  it("installs and uninstalls the macOS launch agent", async () => {
    const { manager, operations, invocations } = setup("darwin");

    await manager.install();
    await manager.uninstall();

    expect(
      operations.map(([operation, path, , writeOptions]) => [operation, path, writeOptions]),
    ).toEqual([
      ["mkdir", "/Users/Jarvis User/Library/LaunchAgents", undefined],
      ["mkdir", "/Users/Jarvis User/.config/jarvis/logs", undefined],
      [
        "writeFile",
        "/Users/Jarvis User/Library/LaunchAgents/dev.jarvis.daemon.plist",
        { mode: 0o644 },
      ],
      ["rm", "/Users/Jarvis User/Library/LaunchAgents/dev.jarvis.daemon.plist", undefined],
    ]);
    expect(invocations).toEqual([
      [
        "launchctl",
        ["bootstrap", "gui/502", "/Users/Jarvis User/Library/LaunchAgents/dev.jarvis.daemon.plist"],
      ],
      ["launchctl", ["bootout", "gui/502/dev.jarvis.daemon"]],
    ]);
  });

  it("installs and uninstalls the Linux user service", async () => {
    const { manager, operations, invocations } = setup("linux");

    await manager.install();
    await manager.uninstall();

    expect(
      operations.map(([operation, path, , writeOptions]) => [operation, path, writeOptions]),
    ).toEqual([
      ["mkdir", "/Users/Jarvis User/.config/systemd/user", undefined],
      ["writeFile", "/Users/Jarvis User/.config/systemd/user/jarvisd.service", { mode: 0o644 }],
      ["rm", "/Users/Jarvis User/.config/systemd/user/jarvisd.service", undefined],
    ]);
    expect(invocations).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "--now", "jarvisd.service"]],
      ["systemctl", ["--user", "disable", "--now", "jarvisd.service"]],
      ["systemctl", ["--user", "daemon-reload"]],
    ]);
  });

  it("installs and uninstalls the Windows scheduled task", async () => {
    const { manager, operations, invocations } = setup("win32");

    await manager.install();
    await manager.uninstall();

    expect(operations.map(([operation, path]) => [operation, path])).toEqual([
      ["mkdir", "C:\\Users\\Jarvis User\\AppData\\Local\\Jarvis"],
      ["writeFile", "C:\\Users\\Jarvis User\\AppData\\Local\\Jarvis\\jarvisd.cmd"],
      ["rm", "C:\\Users\\Jarvis User\\AppData\\Local\\Jarvis\\jarvisd.cmd"],
    ]);
    expect(invocations).toEqual([
      [
        "schtasks",
        [
          "/Create",
          "/F",
          "/SC",
          "ONLOGON",
          "/TN",
          "JarvisDaemon",
          "/RL",
          "LIMITED",
          "/TR",
          '"C:\\Users\\Jarvis User\\AppData\\Local\\Jarvis\\jarvisd.cmd"',
        ],
      ],
      ["schtasks", ["/Delete", "/F", "/TN", "JarvisDaemon"]],
    ]);
  });

  it.each([
    [
      "darwin",
      [["launchctl", ["kickstart", "-k", "gui/502/dev.jarvis.daemon"]]],
      [["launchctl", ["bootout", "gui/502/dev.jarvis.daemon"]]],
      [["launchctl", ["kickstart", "-k", "gui/502/dev.jarvis.daemon"]]],
    ],
    [
      "linux",
      [["systemctl", ["--user", "enable", "--now", "jarvisd.service"]]],
      [["systemctl", ["--user", "disable", "--now", "jarvisd.service"]]],
      [["systemctl", ["--user", "restart", "jarvisd.service"]]],
    ],
    [
      "win32",
      [["schtasks", ["/Run", "/TN", "JarvisDaemon"]]],
      [["schtasks", ["/End", "/TN", "JarvisDaemon"]]],
      [
        ["schtasks", ["/End", "/TN", "JarvisDaemon"]],
        ["schtasks", ["/Run", "/TN", "JarvisDaemon"]],
      ],
    ],
  ] as const)("uses exact %s lifecycle argv", async (platform, start, stop, restart) => {
    const context = setup(platform);
    await context.manager.start();
    expect(context.invocations).toEqual(start);
    context.invocations.length = 0;
    await context.manager.stop();
    expect(context.invocations).toEqual(stop);
    context.invocations.length = 0;
    await context.manager.restart();
    expect(context.invocations).toEqual(restart);
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "reports %s as not installed without running a command",
    async (platform) => {
      const { manager, invocations } = setup(platform, { installed: false });
      await expect(manager.status()).resolves.toBe("not-installed");
      expect(invocations).toEqual([]);
    },
  );

  it.each([
    ["darwin", { code: 0, stdout: "", stderr: "" }, "running"],
    ["darwin", { code: 113, stdout: "", stderr: "" }, "stopped"],
    ["linux", { code: 0, stdout: "active\n", stderr: "" }, "running"],
    ["linux", { code: 3, stdout: "inactive\n", stderr: "" }, "stopped"],
    ["linux", { code: 1, stdout: "failed\n", stderr: "" }, "unknown"],
    ["win32", { code: 0, stdout: "Status: Running", stderr: "" }, "running"],
    ["win32", { code: 0, stdout: "Status: Ready", stderr: "" }, "stopped"],
    ["win32", { code: 1, stdout: "", stderr: "ERROR" }, "unknown"],
  ] as const)("parses %s status results", async (platform, result, expected) => {
    const { manager } = setup(platform, { results: [result] });
    await expect(manager.status()).resolves.toBe(expected);
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "tolerates an already removed %s service during uninstall",
    async (platform) => {
      const { manager } = setup(platform, {
        results: [
          { code: 1, stdout: "", stderr: "not found" },
          { code: 0, stdout: "", stderr: "" },
        ],
      });
      await expect(manager.uninstall()).resolves.toBeUndefined();
    },
  );
});
