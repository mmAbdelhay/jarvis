import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { appMenuTemplate } from "./app-menu.js";

function roles(platform: NodeJS.Platform): (string | undefined)[] {
  return appMenuTemplate(platform)
    .flatMap((item) => (item.submenu as MenuItemConstructorOptions[] | undefined) ?? [])
    .map((item) => item.role as string | undefined);
}

describe("appMenuTemplate", () => {
  it("keeps the edit roles that make copy and paste work in plain inputs", () => {
    // The composer, the Settings editors, the API tab's URL bar. The app's own
    // chord handlers deliberately do not reach into those, so without these
    // roles there is nothing at all bound to copy and paste there — which is
    // why "just remove the menu" is the wrong fix for the visible menu bar.
    for (const platform of ["darwin", "linux"] as const) {
      expect(roles(platform)).toEqual(
        expect.arrayContaining(["copy", "paste", "cut", "selectAll", "undo", "redo"]),
      );
    }
  });

  it("offers devtools, the only way to see a renderer error in a packaged app", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(roles(platform)).toContain("toggleDevTools");
    }
  });

  it("gives macOS its app menu first, as every Mac app has", () => {
    expect(appMenuTemplate("darwin")[0]?.role).toBe("appMenu");
  });

  it("gives Linux no app menu — there is no menu bar to put one in", () => {
    expect(appMenuTemplate("linux")[0]?.role).not.toBe("appMenu");
  });

  it("still offers a way to quit off darwin, where appMenu carried it", () => {
    expect(roles("linux")).toContain("quit");
  });

  it("stays minimal — this is a hidden menu, not a menu bar to browse", () => {
    expect(appMenuTemplate("linux").length).toBeLessThanOrEqual(3);
  });
});
