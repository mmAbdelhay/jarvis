// /usr/lib/systemd/user/jarvisd.service for Jarvis OS (contracts §4). Unlike
// the desktop's unit (service-linux.ts) it keeps systemd's default
// KillMode=control-group: jarvis-pkg and jarvis-diag are jarvisd's children
// and must stop with it; there are no user terminals to keep alive here.
// Restart=on-failure brings jarvisd back after a crash (spec §10); the shell
// shows "reconnecting" meanwhile. Exit 3 (another jarvisd) is not retried.
//
// No electron here (core/no-electron.test.ts).
export const OS_NODE = "/usr/lib/jarvis/node/bin/node";
export const OS_DAEMON_SCRIPT = "/usr/lib/jarvis/daemon/jarvisd.mjs";

export function buildOsDaemonUnit(): string {
  return `[Unit]
Description=Jarvis OS daemon
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
ExecStart="${OS_NODE}" "${OS_DAEMON_SCRIPT}" "run"
Environment=JARVISD_SUPERVISOR=systemd
Restart=on-failure
RestartSec=2
RestartPreventExitStatus=3

[Install]
WantedBy=default.target
`;
}
