import { describe, expect, it } from "vitest";
import { buildDarwinService } from "./service-darwin.js";

describe("buildDarwinService", () => {
  it("builds an escaped launch agent and exact launchctl argv", () => {
    const service = buildDarwinService({
      home: "/Users/A & B",
      uid: 501,
      execPath: "/Applications/Jarvis & Co.app/Contents/MacOS/Jarvis <Dev>",
      daemonScript: "/Users/A & B/Jarvis/dist/daemon-main.js",
    });

    expect(service.filePath).toBe("/Users/A & B/Library/LaunchAgents/dev.jarvis.daemon.plist");
    expect(service.fileMode).toBe(0o644);
    expect(service.contents).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.jarvis.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/Jarvis &amp; Co.app/Contents/MacOS/Jarvis &lt;Dev&gt;</string>
    <string>/Users/A &amp; B/Jarvis/dist/daemon-main.js</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/A &amp; B/.config/jarvis/logs/jarvisd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/A &amp; B/.config/jarvis/logs/jarvisd.err.log</string>
</dict>
</plist>
`);
    expect(service.commands).toEqual({
      install: ["launchctl", ["bootstrap", "gui/501", service.filePath]],
      uninstall: ["launchctl", ["bootout", "gui/501/dev.jarvis.daemon"]],
      start: ["launchctl", ["kickstart", "-k", "gui/501/dev.jarvis.daemon"]],
      stop: ["launchctl", ["bootout", "gui/501/dev.jarvis.daemon"]],
      status: ["launchctl", ["print", "gui/501/dev.jarvis.daemon"]],
    });
  });
});
