import { describe, expect, it } from "vitest";
import { buildDarwinService, darwinRecordedExecPath } from "./service-darwin.js";

describe("buildDarwinService", () => {
  it("builds an escaped launch agent and exact launchctl argv", () => {
    const service = buildDarwinService({
      home: "/Users/A & B",
      accountHome: "/Users/A & B",
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
    <key>JARVISD_SUPERVISOR</key>
    <string>launchd</string>
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

  it.each([
    "/Applications/Jarvis & Co.app/Contents/MacOS/Jarvis <Dev> 'q' \"d\"",
    "/private/var/folders/xy/T/AppTranslocation/ABC/d/Jarvis.app/Contents/MacOS/Jarvis",
    "/Applications/جارفيس.app/Contents/MacOS/Jarvis",
  ])("reads back the binary a plist records: %s", (execPath) => {
    const service = buildDarwinService({
      home: "/Users/u",
      accountHome: "/Users/u",
      uid: 501,
      execPath,
      daemonScript: "/d.js",
    });
    expect(darwinRecordedExecPath(service.contents)).toBe(execPath);
    expect(darwinRecordedExecPath("<plist><dict></dict></plist>")).toBeUndefined();
  });

  // A dev or test instance run with another HOME must never address the
  // user's real launch agent: one bootstrap/kickstart of the shared label
  // killed the real daemon and every terminal it held.
  describe("an instance whose HOME is not the account's home", () => {
    const build = (home: string) =>
      buildDarwinService({
        home,
        accountHome: "/Users/u",
        uid: 501,
        execPath: "/Applications/Jarvis.app/Contents/MacOS/Jarvis",
        daemonScript: "/d.js",
      });

    it("gets its own label in Label, the plist's name and every launchctl target", () => {
      const service = build("/tmp/jp/home");
      const label = "dev.jarvis.daemon.26f9ba41";
      expect(service.label).toBe(label);
      expect(service.filePath).toBe(`/tmp/jp/home/Library/LaunchAgents/${label}.plist`);
      expect(service.contents).toContain(`<key>Label</key>\n  <string>${label}</string>\n`);
      expect(service.commands).toEqual({
        install: ["launchctl", ["bootstrap", "gui/501", service.filePath]],
        uninstall: ["launchctl", ["bootout", `gui/501/${label}`]],
        start: ["launchctl", ["kickstart", "-k", `gui/501/${label}`]],
        stop: ["launchctl", ["bootout", `gui/501/${label}`]],
        status: ["launchctl", ["print", `gui/501/${label}`]],
      });
      for (const [, args] of Object.values(service.commands)) {
        for (const arg of args) expect(arg).not.toMatch(/dev\.jarvis\.daemon(\.plist)?$/);
      }
    });

    it("runs its daemon with its own HOME, which launchd would otherwise reset", () => {
      expect(build("/tmp/jp/home").contents).toContain(
        "<key>HOME</key>\n    <string>/tmp/jp/home</string>\n",
      );
      expect(build("/Users/u").contents).not.toContain("<key>HOME</key>");
    });

    it("gives two different homes two different labels", () => {
      expect(build("/tmp/jp/other").label).toBe("dev.jarvis.daemon.a2cc2acb");
      expect(build("/tmp/jp/other").label).not.toBe(build("/tmp/jp/home").label);
    });

    it("treats the account home with a trailing slash as the account home", () => {
      expect(build("/Users/u/").label).toBe("dev.jarvis.daemon");
    });
  });
});
