import { describe, expect, it } from "vitest";
import { MESSAGES } from "../src/messages.js";
import { changeMessage, daemonSettingsView } from "./daemon-settings.js";

describe("Settings → General: the background service's view of a status", () => {
  it("off: the switch off, no daemon actions", () => {
    expect(
      daemonSettingsView({ enabled: false, inApp: true, state: { kind: "off" } }, "en"),
    ).toEqual({
      toggleOn: false,
      line: "Off. Jarvis runs inside the app.",
      warning: false,
      showDaemonActions: false,
    });
  });

  it("on but stopped for this session: the switch stays on, and says so", () => {
    const view = daemonSettingsView({ enabled: true, inApp: true, state: { kind: "off" } }, "en");
    expect(view.toggleOn).toBe(true);
    expect(view.line).toBe(MESSAGES.daemonStateOffSession("en"));
    expect(view.showDaemonActions).toBe(false);
  });

  it("starting", () => {
    expect(
      daemonSettingsView({ enabled: true, inApp: false, state: { kind: "starting" } }, "ar").line,
    ).toBe(MESSAGES.daemonStateStarting("ar"));
  });

  it("running: pid and uptime, with Restart and Stop now", () => {
    expect(
      daemonSettingsView(
        { enabled: true, inApp: false, state: { kind: "running", pid: 812, uptimeMs: 7_380_000 } },
        "en",
      ),
    ).toEqual({
      toggleOn: true,
      line: "Running (pid 812, up 2h 3m).",
      warning: false,
      showDaemonActions: true,
    });
  });

  // Review I1: the setting is off, but the app found a daemon running and
  // attached to it rather than start a second core.
  it("attached with the setting off: says so, in both languages, with Stop now", () => {
    for (const language of ["en", "ar"] as const) {
      const view = daemonSettingsView(
        { enabled: false, inApp: false, state: { kind: "running", pid: 812, uptimeMs: 60_000 } },
        language,
      );
      expect(view).toEqual({
        toggleOn: false,
        line: MESSAGES.daemonStateAttached(812, MESSAGES.daemonUptime(60_000, language), language),
        warning: false,
        showDaemonActions: true,
      });
    }
    expect(MESSAGES.daemonStateAttached(812, "1m", "en")).toContain("already running");
    expect(MESSAGES.daemonStateAttached(812, "1m", "ar")).toMatch(/[\u0600-\u06ff]/);
  });

  it("failed: the reason and the log's last line, as a warning", () => {
    expect(
      daemonSettingsView(
        {
          enabled: true,
          inApp: true,
          state: { kind: "failed", reason: "timed out", lastLogLine: "EADDRINUSE 7717" },
        },
        "en",
      ),
    ).toEqual({
      toggleOn: true,
      line: "Not running: timed out",
      logLine: "Last log line: EADDRINUSE 7717",
      warning: true,
      showDaemonActions: false,
    });
    expect(
      daemonSettingsView(
        { enabled: false, inApp: true, state: { kind: "failed", reason: "x" } },
        "en",
      ),
    ).not.toHaveProperty("logLine");
  });

  it("a change that did not happen says why; a cancel says nothing", () => {
    expect(changeMessage({ ok: true }, "en")).toBeUndefined();
    expect(changeMessage({ ok: false, reason: "cancelled" }, "en")).toBeUndefined();
    expect(changeMessage({ ok: false, reason: "busy" }, "en")).toBe(MESSAGES.daemonBusy("en"));
    expect(changeMessage({ ok: false, reason: "failed", detail: "boom" }, "en")).toBe(
      "Couldn't change it: boom",
    );
  });
});
