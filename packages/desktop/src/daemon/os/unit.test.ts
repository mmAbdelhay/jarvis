import { describe, expect, it } from "vitest";
import { buildOsDaemonUnit } from "./unit.js";

describe("buildOsDaemonUnit", () => {
  const unit = buildOsDaemonUnit();

  it("runs the bundle with the bundled Node under systemd supervision", () => {
    // contracts §6 #16: the exact line Plan D's packaging checks for.
    expect(unit.split("\n")).toContain(
      "ExecStart=/usr/lib/jarvis/node/bin/node /usr/lib/jarvis/daemon/jarvisd.mjs run",
    );
    expect(unit).toContain("Environment=JARVISD_SUPERVISOR=systemd");
  });

  it("restarts after a crash but not when another jarvisd holds the lock", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartPreventExitStatus=3");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("kills the MCP servers with the daemon (default control-group kill mode)", () => {
    expect(unit).not.toContain("KillMode=process");
  });
});
