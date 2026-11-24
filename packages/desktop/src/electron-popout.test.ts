import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// electron-popout.ts constructs windows, so it cannot run here. What can be
// held to account is its source: a pop-out keeps the main window's
// hardening, opens nothing, navigates nowhere, and is never parented.
const source = readFileSync(new URL("./electron-popout.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("the pop-out window", () => {
  it("has context isolation and the sandbox on and node integration off, and no other preload than Jarvis's own", () => {
    expect(source).toMatch(/contextIsolation: true/);
    expect(source).toMatch(/nodeIntegration: false/);
    expect(source).toMatch(/sandbox: true/);
    expect(source).not.toMatch(/nodeIntegration: true|contextIsolation: false|sandbox: false/);
    expect(source).not.toMatch(/webSecurity|allowRunningInsecureContent|enableRemoteModule/);
    // The one preload is the caller's, and only a terminal's window gets it.
    expect(source.match(/preload: options\.preload/g)).toHaveLength(1);
    expect(source).toMatch(/\.\.\.\(isTerminal\s*\?\s*\{\s*preload: options\.preload/);
  });

  it("denies window.open, and navigation away from its own file (any at all for a page's window)", () => {
    expect(source).toMatch(/setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
    expect(source).toMatch(/will-navigate/);
    expect(source).toMatch(/!isTerminal \|\| !isAllowedNavigation\(url, popoutUrl\)/);
    expect(source).toMatch(/event\.preventDefault\(\)/);
  });

  it("is never parented, and reaches its renderer only through the broadcaster's sink", () => {
    expect(source).not.toMatch(/\bparent:/);
    expect(source).not.toMatch(/webContents\.send/);
    expect(source).toMatch(/rendererSink\(window\)/);
    expect(source).toMatch(/popoutPushAllowed\(spec\.tabId, channel, payload\)/);
  });

  it("is wired in main.ts with the pop-outs counted in focus, awake, permissions and quit", () => {
    expect(main).toMatch(/window\.isFocused\(\) \|\| popouts\.anyFocused\(\)/);
    expect(main).toMatch(/popouts\.anyAwake\(\)/);
    expect(main).toMatch(/popouts\.tabOf\(requesting\.id\)/);
    expect(main).toMatch(/app\.on\("before-quit", \(\) => popouts\.closeAll\(\)\)/);
    expect(main).toMatch(/popouts\.closeAll\(\);\s*stopPushes\(\)/);
  });
});
