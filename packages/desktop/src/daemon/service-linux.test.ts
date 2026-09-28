import { describe, expect, it } from "vitest";
import { appImageOf, buildLinuxService, linuxRecordedExecPath } from "./service-linux.js";

describe("buildLinuxService", () => {
  it("builds a quoted user unit and exact systemctl argv", () => {
    const service = buildLinuxService({
      home: "/home/Jarvis User",
      execPath: "/opt/Jarvis %App/bin/jarvis\\preview$",
      daemonScript: '/home/Jarvis User/a "quoted" daemon.js',
    });

    expect(service.filePath).toBe("/home/Jarvis User/.config/systemd/user/jarvisd.service");
    expect(service.fileMode).toBe(0o644);
    expect(service.contents).toBe(`[Unit]
Description=Jarvis background daemon
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
ExecStart="/opt/Jarvis %%App/bin/jarvis\\\\preview$$" "/home/Jarvis User/a \\"quoted\\" daemon.js" "run"
Environment=ELECTRON_RUN_AS_NODE=1
Environment=JARVISD_SUPERVISOR=systemd
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=3
KillMode=process

[Install]
WantedBy=default.target
`);
    expect(service.commands).toEqual({
      reload: ["systemctl", ["--user", "daemon-reload"]],
      enable: ["systemctl", ["--user", "enable", "jarvisd.service"]],
      start: ["systemctl", ["--user", "enable", "--now", "jarvisd.service"]],
      stop: ["systemctl", ["--user", "disable", "--now", "jarvisd.service"]],
      restart: ["systemctl", ["--user", "restart", "jarvisd.service"]],
      status: ["systemctl", ["--user", "is-active", "jarvisd.service"]],
    });
  });

  it("runs an AppImage through its own file and --jarvis-daemon, not the vanishing mount", () => {
    // $APPIMAGE is the .AppImage file; execPath is inside /tmp/.mount_*,
    // gone once the app quits (fix-wave ruling).
    const service = buildLinuxService({
      home: "/home/u",
      execPath: "/tmp/.mount_JarvisX1/jarvis",
      daemonScript: "/tmp/.mount_JarvisX1/resources/app.asar/dist/src/daemon-main.js",
      appImage: "/home/u/Apps/Jarvis 1.0 $beta%.AppImage",
    });
    expect(service.contents).toContain(
      'ExecStart="/home/u/Apps/Jarvis 1.0 $$beta%%.AppImage" "--jarvis-daemon"\n',
    );
    expect(service.contents).not.toContain(".mount_");
    // The launcher runs as Electron to read its flag, then the daemon as Node.
    expect(service.contents).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(service.contents).toContain("Environment=JARVISD_SUPERVISOR=systemd\n");
    expect(service.contents).toContain("RestartPreventExitStatus=3\nKillMode=process\n");
  });

  it.each([
    ["/opt/Jarvis %App/bin/jarvis\\preview$", undefined],
    ['/home/u/Apps/Jarvis "β" $1.AppImage', '/home/u/Apps/Jarvis "β" $1.AppImage'],
    ["/opt/جارفيس/jarvis", undefined],
  ])("reads back the binary a unit records: %s", (execPath, appImage) => {
    const service = buildLinuxService({
      home: "/home/u",
      execPath,
      daemonScript: "/x/daemon-main.js",
      ...(appImage === undefined ? {} : { appImage }),
    });
    expect(linuxRecordedExecPath(service.contents)).toBe(appImage ?? execPath);
    expect(linuxRecordedExecPath("[Service]\nRestart=on-failure\n")).toBeUndefined();
  });

  // Re-review N2: APPIMAGE is inherited by every child of an AppImage (a
  // Jarvis pty, a terminal emulator's shells), so it names this process's
  // own image only when execPath is inside the image's mount (APPDIR).
  it("takes $APPIMAGE only when this process runs from that image's mount", () => {
    const image = { APPIMAGE: "/home/u/Jarvis.AppImage", APPDIR: "/tmp/.mount_Jarv1" };
    expect(appImageOf(image, "/tmp/.mount_Jarv1/jarvis")).toBe("/home/u/Jarvis.AppImage");
    // Inherited by a tarball or dev build started from such a shell:
    expect(appImageOf(image, "/opt/jarvis/jarvis")).toBeUndefined();
    expect(appImageOf({ APPIMAGE: image.APPIMAGE }, "/tmp/.mount_Jarv1/jarvis")).toBeUndefined();
    // A sibling directory that only shares the prefix is not inside it.
    expect(appImageOf(image, "/tmp/.mount_Jarv1x/jarvis")).toBeUndefined();
    expect(appImageOf({}, "/tmp/.mount_Jarv1/jarvis")).toBeUndefined();
  });
});
