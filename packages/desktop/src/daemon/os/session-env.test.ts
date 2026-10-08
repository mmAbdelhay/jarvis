import { describe, expect, it } from "vitest";
import { createSessionEnv, parseShowEnvironment, SESSION_KEYS } from "./session-env.js";

describe("parseShowEnvironment (systemctl --user show-environment)", () => {
  it("reads KEY=VALUE lines and systemd's $'...' quoting", () => {
    expect(
      parseShowEnvironment(
        [
          "HOME=/home/jarvis",
          "WAYLAND_DISPLAY=wayland-1",
          "XDG_CURRENT_DESKTOP=labwc:wlroots",
          "WEIRD=$'a b\\'c\\\\d\\n'",
          "not a line",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      HOME: "/home/jarvis",
      WAYLAND_DISPLAY: "wayland-1",
      XDG_CURRENT_DESKTOP: "labwc:wlroots",
      WEIRD: "a b'c\\d\n",
    });
  });
});

describe("createSessionEnv (Rafiq M3 §5.14)", () => {
  const base = { HOME: "/home/jarvis", PATH: "/usr/bin", DISPLAY: ":old" };

  it("names exactly the session variables labwc's autostart imports", () => {
    expect(SESSION_KEYS).toEqual(["WAYLAND_DISPLAY", "DISPLAY", "XDG_CURRENT_DESKTOP"]);
  });

  it("merges only the session variables from the user manager over jarvisd's own environment", async () => {
    const env = createSessionEnv({
      base,
      read: async () => "WAYLAND_DISPLAY=wayland-0\nXDG_CURRENT_DESKTOP=labwc\nPATH=/evil\n",
    });
    expect(env.current()).toEqual(base);
    await env.changed();
    // DISPLAY is gone from the user manager, so the stale one is dropped too.
    expect(env.current()).toEqual({
      HOME: "/home/jarvis",
      PATH: "/usr/bin",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_CURRENT_DESKTOP: "labwc",
    });
  });

  it("reports a change only when a session variable changed", async () => {
    const reads = [
      "WAYLAND_DISPLAY=wayland-0\nDISPLAY=:0\nXDG_CURRENT_DESKTOP=labwc\n",
      "WAYLAND_DISPLAY=wayland-0\nDISPLAY=:0\nXDG_CURRENT_DESKTOP=labwc\nOTHER=1\n",
      "WAYLAND_DISPLAY=wayland-1\nDISPLAY=:1\nXDG_CURRENT_DESKTOP=labwc\n",
    ];
    const env = createSessionEnv({ base, read: async () => reads.shift() });
    expect(await env.changed()).toBe(true); // jarvisd started before the import
    expect(await env.changed()).toBe(false);
    expect(await env.changed()).toBe(true); // the compositor restarted
    expect(env.current()["WAYLAND_DISPLAY"]).toBe("wayland-1");
  });

  it("keeps the last environment when the user manager cannot be read", async () => {
    const reads: Array<string | undefined> = ["WAYLAND_DISPLAY=wayland-0\n", undefined];
    const env = createSessionEnv({ base, read: async () => reads.shift() });
    await env.changed();
    expect(await env.changed()).toBe(false);
    expect(env.current()["WAYLAND_DISPLAY"]).toBe("wayland-0");
    const failing = createSessionEnv({
      base,
      read: async () => {
        throw new Error("no bus");
      },
    });
    expect(await failing.changed()).toBe(false);
    expect(failing.current()).toEqual(base);
  });
});
