import { describe, expect, it } from "vitest";
import { buildLinuxService } from "./service-linux.js";

describe("buildLinuxService", () => {
  it("builds a quoted user unit and exact systemctl argv", () => {
    const service = buildLinuxService({
      home: "/home/Jarvis User",
      execPath: "/opt/Jarvis App/bin/jarvis\\preview",
      daemonScript: '/home/Jarvis User/a "quoted" daemon.js',
    });

    expect(service.filePath).toBe("/home/Jarvis User/.config/systemd/user/jarvisd.service");
    expect(service.fileMode).toBe(0o644);
    expect(service.contents).toBe(`[Unit]
Description=Jarvis background daemon

[Service]
ExecStart="/opt/Jarvis App/bin/jarvis\\\\preview" "/home/Jarvis User/a \\"quoted\\" daemon.js" run
Environment=ELECTRON_RUN_AS_NODE=1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`);
    expect(service.commands).toEqual({
      reload: ["systemctl", ["--user", "daemon-reload"]],
      start: ["systemctl", ["--user", "enable", "--now", "jarvisd.service"]],
      stop: ["systemctl", ["--user", "disable", "--now", "jarvisd.service"]],
      restart: ["systemctl", ["--user", "restart", "jarvisd.service"]],
      status: ["systemctl", ["--user", "is-active", "jarvisd.service"]],
    });
  });
});
