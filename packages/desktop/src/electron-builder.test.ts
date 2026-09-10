import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The packaging config is the one part of this app no unit test can exercise
// by running it — a wrong glob here produces a bundle that installs, launches
// and fails at the first session. These are the properties that were actually
// got wrong, each pinned so it stays got right.

async function config(): Promise<Record<string, never>> {
  return parse(await readFile("packages/desktop/electron-builder.yml", "utf8"));
}

describe("electron-builder.yml", () => {
  it("keeps only the host's own agent SDK runtime on each platform", async () => {
    // @anthropic-ai/claude-agent-sdk ships one ~200 MB runtime per platform
    // and pnpm installs all eight. The shared exclusion glob used to name
    // `linux`, which is how a Linux build would ship with no agent runtime at
    // all — and fail at the first session rather than at build time.
    const c = (await config()) as unknown as {
      mac: { files: string[] };
      linux: { files: string[] };
      files: string[];
    };

    expect(c.linux.files.join(" ")).not.toContain("claude-agent-sdk-linux-x64");
    expect(c.linux.files.join(" ")).toContain("darwin");
    expect(c.mac.files.join(" ")).not.toContain("claude-agent-sdk-darwin-arm64");
    expect(c.mac.files.join(" ")).toContain("linux");

    // And the shared block must not exclude any of them, or the per-platform
    // keeps below it are pointless.
    expect(c.files.join(" ")).not.toContain("claude-agent-sdk");
  });

  it("ships the renderer's runtime assets, both copies of vendor included", async () => {
    // index.html is loaded from the source tree, not from dist, so renderer/
    // is a runtime asset. A missing vendor file is not a crash — it is a
    // blank terminal, which is far harder to notice.
    const c = (await config()) as unknown as { files: string[] };
    for (const glob of ["renderer/index.html", "renderer/styles.css", "renderer/vendor/**/*"]) {
      expect(c.files).toContain(glob);
    }
  });

  it("unpacks node-pty on every target", async () => {
    // dlopen() needs a real path and cannot read out of an asar archive. The
    // Linux binding is a source build in build/Release rather than a shipped
    // prebuild — same constraint, different directory, same glob.
    const c = (await config()) as unknown as { asarUnpack: string[] };
    expect(c.asarUnpack).toContain("**/node_modules/node-pty/**");
  });

  it("still does not rebuild native modules", async () => {
    // npmRebuild writes into the pnpm store's own copy of node-pty, and
    // node-pty's loader searches build/Release before prebuilds/ — so the
    // first packaging run on a machine silently changes what every later run
    // ships. See the comment in the file.
    const c = (await config()) as unknown as { npmRebuild: boolean };
    expect(c.npmRebuild).toBe(false);
  });

  it("builds an AppImage for Linux and a dmg for macOS", async () => {
    const c = (await config()) as unknown as {
      mac: { target: { target: string }[] };
      linux: { target: { target: string }[] };
    };
    expect(c.linux.target.map((t) => t.target)).toContain("AppImage");
    expect(c.mac.target.map((t) => t.target)).toContain("dmg");
  });

  it("names the Linux executable itself", async () => {
    // electron-builder derives it from the package name otherwise, and this
    // package is `@jarvis/desktop` — which becomes `@jarvisdesktop`, a name it
    // then refuses as unsafe in a file path. The whole AppImage build fails on
    // it, and only on Linux: macOS names the .app from productName.
    const c = (await config()) as unknown as { linux: { executableName: string } };
    expect(c.linux.executableName).toBe("jarvis");
    expect(c.linux.executableName).toMatch(/^[a-z0-9._-]+$/);
  });

  it("keeps the desktop entry and Electron's app_id in step", async () => {
    // Without the match the window manager cannot link the running window to
    // the launcher that started it, and the app shows up twice in the dock.
    //
    // The entry's name comes from package.json rather than from here —
    // desktopName is not a `linux:` key, and putting it there fails the whole
    // build on a schema error that names nothing.
    const c = (await config()) as unknown as { linux: { syncDesktopName: boolean } };
    expect(c.linux.syncDesktopName).toBe(true);

    const pkg = JSON.parse(await readFile("packages/desktop/package.json", "utf8")) as {
      desktopName: string;
    };
    expect(pkg.desktopName).toBe("jarvis.desktop");
  });

  it("points Linux at the PNG icon, not the icns", async () => {
    const c = (await config()) as unknown as { linux: { icon: string } };
    expect(c.linux.icon).toMatch(/\.png$/);
  });

  it("runs the VMP signing hook", async () => {
    // Without it the packaged app plays no DRM at all — Netflix answers a
    // development-signed client with E100.
    const c = (await config()) as unknown as { afterPack: string };
    expect(c.afterPack).toBe("scripts/vmp-sign.cjs");
  });
});
