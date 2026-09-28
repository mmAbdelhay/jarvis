type Command = readonly [command: string, args: readonly string[]];

export interface LinuxServiceDefinition {
  filePath: string;
  fileMode: number;
  contents: string;
  commands: {
    reload: Command;
    enable: Command;
    start: Command;
    stop: Command;
    restart: Command;
    status: Command;
  };
}

function systemdQuote(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$")}"`;
}

/** This process's AppImage file, or undefined. APPIMAGE is inherited by
 *  every child of an AppImage, so it is this process's own only when
 *  execPath lies inside the image's mount, APPDIR (re-review N2). */
export function appImageOf(
  env: { APPIMAGE?: string | undefined; APPDIR?: string | undefined },
  execPath: string,
): string | undefined {
  const { APPIMAGE: image, APPDIR: mount } = env;
  if (!image || !mount) return undefined;
  const prefix = mount.endsWith("/") ? mount : `${mount}/`;
  return execPath.startsWith(prefix) ? image : undefined;
}

/** The binary an installed unit runs (ExecStart's first quoted word), as
 *  buildLinuxService wrote it; undefined when the unit has none. */
export function linuxRecordedExecPath(unit: string): string | undefined {
  const match = /^ExecStart="((?:[^"\\]|\\.)*)"/m.exec(unit);
  if (match?.[1] === undefined) return undefined;
  return match[1].replace(
    /\\(.)|%%|\$\$/g,
    (whole, escaped: string | undefined) => escaped ?? whole[0] ?? "",
  );
}

/**
 * The systemd user unit.
 *
 * Restart=on-failure brings the daemon back after a crash and after a
 * restart exit (75); RestartPreventExitStatus=3 keeps "another jarvisd
 * already runs" from respawning every RestartSec, and StartLimitBurst=5 in
 * StartLimitIntervalSec=300 stops a daemon that fails at every start (a
 * headless AppImage's Electron without a display, a broken jarvis.yaml)
 * from restarting forever. KillMode=process: a stop
 * signals the daemon alone, which closes its own ptys, so a detached job a
 * Jarvis terminal started (a tmux server, nohup, docker compose) outlives a
 * daemon stop or restart, as it outlives the app in-process.
 *
 * From an AppImage, execPath and the daemon script sit in the image's
 * /tmp/.mount_* directory, gone once the app quits, so the unit runs the
 * .AppImage file itself ($APPIMAGE) with --jarvis-daemon, which under a
 * service manager runs the daemon in the foreground (main.ts).
 */
export function buildLinuxService(options: {
  home: string;
  execPath: string;
  daemonScript: string;
  /** $APPIMAGE, when the app runs from an AppImage. */
  appImage?: string;
}): LinuxServiceDefinition {
  const filePath = `${options.home}/.config/systemd/user/jarvisd.service`;
  const exec =
    options.appImage === undefined
      ? `ExecStart=${systemdQuote(options.execPath)} ${systemdQuote(options.daemonScript)} ${systemdQuote("run")}
Environment=ELECTRON_RUN_AS_NODE=1`
      : `ExecStart=${systemdQuote(options.appImage)} ${systemdQuote("--jarvis-daemon")}`;
  const contents = `[Unit]
Description=Jarvis background daemon
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
${exec}
Environment=JARVISD_SUPERVISOR=systemd
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=3
KillMode=process

[Install]
WantedBy=default.target
`;
  return {
    filePath,
    fileMode: 0o644,
    contents,
    commands: {
      reload: ["systemctl", ["--user", "daemon-reload"]],
      enable: ["systemctl", ["--user", "enable", "jarvisd.service"]],
      start: ["systemctl", ["--user", "enable", "--now", "jarvisd.service"]],
      stop: ["systemctl", ["--user", "disable", "--now", "jarvisd.service"]],
      restart: ["systemctl", ["--user", "restart", "jarvisd.service"]],
      status: ["systemctl", ["--user", "is-active", "jarvisd.service"]],
    },
  };
}
