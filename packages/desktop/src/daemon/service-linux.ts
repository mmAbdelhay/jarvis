type Command = readonly [command: string, args: readonly string[]];

export interface LinuxServiceDefinition {
  filePath: string;
  fileMode: number;
  contents: string;
  commands: {
    reload: Command;
    start: Command;
    stop: Command;
    restart: Command;
    status: Command;
  };
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildLinuxService(options: {
  home: string;
  execPath: string;
  daemonScript: string;
}): LinuxServiceDefinition {
  const filePath = `${options.home}/.config/systemd/user/jarvisd.service`;
  const contents = `[Unit]
Description=Jarvis background daemon

[Service]
ExecStart=${systemdQuote(options.execPath)} ${systemdQuote(options.daemonScript)} run
Environment=ELECTRON_RUN_AS_NODE=1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  return {
    filePath,
    fileMode: 0o644,
    contents,
    commands: {
      reload: ["systemctl", ["--user", "daemon-reload"]],
      start: ["systemctl", ["--user", "enable", "--now", "jarvisd.service"]],
      stop: ["systemctl", ["--user", "disable", "--now", "jarvisd.service"]],
      restart: ["systemctl", ["--user", "restart", "jarvisd.service"]],
      status: ["systemctl", ["--user", "is-active", "jarvisd.service"]],
    },
  };
}
