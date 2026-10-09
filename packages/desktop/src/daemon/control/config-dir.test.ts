import { describe, expect, it } from "vitest";
import { jarvisConfigDir } from "./config-dir.js";

describe("jarvisConfigDir", () => {
  it("is ~/.config/jarvis when JARVIS_CONFIG_DIR is unset or empty", () => {
    expect(jarvisConfigDir({ platform: "linux", home: "/home/u", env: {} })).toBe(
      "/home/u/.config/jarvis",
    );
    expect(
      jarvisConfigDir({ platform: "linux", home: "/home/u", env: { JARVIS_CONFIG_DIR: "" } }),
    ).toBe("/home/u/.config/jarvis");
    expect(jarvisConfigDir({ platform: "win32", home: "C:\\Users\\Me", env: {} })).toBe(
      "C:\\Users\\Me\\.config\\jarvis",
    );
  });

  it("honors an absolute JARVIS_CONFIG_DIR (Jarvis Workspace on Rafiq, M4 §6.16)", () => {
    expect(
      jarvisConfigDir({
        platform: "linux",
        home: "/home/u",
        env: { JARVIS_CONFIG_DIR: "/home/u/.config/jarvis-workspace/" },
      }),
    ).toBe("/home/u/.config/jarvis-workspace");
  });

  it("ignores a relative JARVIS_CONFIG_DIR rather than resolving it against the cwd", () => {
    expect(
      jarvisConfigDir({ platform: "linux", home: "/home/u", env: { JARVIS_CONFIG_DIR: "ws" } }),
    ).toBe("/home/u/.config/jarvis");
  });
});

describe("daemonLogPath", () => {
  it("is <config dir>/logs/jarvisd.log, following JARVIS_CONFIG_DIR", async () => {
    const { daemonLogPath } = await import("../log-file.js");
    expect(daemonLogPath("/home/u", {}, "linux")).toBe("/home/u/.config/jarvis/logs/jarvisd.log");
    expect(
      daemonLogPath("/home/u", { JARVIS_CONFIG_DIR: "/home/u/.config/jarvis-workspace" }, "linux"),
    ).toBe("/home/u/.config/jarvis-workspace/logs/jarvisd.log");
  });
});
