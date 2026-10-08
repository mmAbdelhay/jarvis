import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linuxSwapScript, prepareLinux } from "./update-install-linux.js";

function deps(overrides: Partial<Parameters<typeof prepareLinux>[0]> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      file: "/home/me/.cache/jarvis/Jarvis-0.1.9.AppImage",
      appImage: "/home/me/Apps/Jarvis.AppImage",
      copy: async (src: string, dest: string) => {
        calls.push(`copy ${src} ${dest}`);
      },
      chmod: async (path: string, mode: number) => {
        calls.push(`chmod ${path} ${mode.toString(8)}`);
      },
      remove: async (path: string) => {
        calls.push(`remove ${path}`);
      },
      writable: (dir: string) => {
        calls.push(`writable ${dir}`);
        return true;
      },
      ...overrides,
    },
  };
}

describe("prepareLinux", () => {
  it("copies the download to <appImage>.new and makes it executable", async () => {
    const { calls, deps: d } = deps();
    expect(await prepareLinux(d)).toEqual({
      ok: true,
      staged: "/home/me/Apps/Jarvis.AppImage.new",
    });
    expect(calls).toEqual([
      "writable /home/me/Apps",
      "copy /home/me/.cache/jarvis/Jarvis-0.1.9.AppImage /home/me/Apps/Jarvis.AppImage.new",
      "chmod /home/me/Apps/Jarvis.AppImage.new 755",
    ]);
  });

  it("refuses when not running as an AppImage", async () => {
    for (const appImage of [undefined, ""]) {
      const { calls, deps: d } = deps({ appImage });
      expect(await prepareLinux(d)).toEqual({ ok: false, reason: "not-appimage" });
      expect(calls).toEqual([]);
    }
  });

  it("refuses when the AppImage's folder cannot be written", async () => {
    const { calls, deps: d } = deps({ writable: () => false });
    expect(await prepareLinux(d)).toEqual({ ok: false, reason: "read-only" });
    expect(calls).toEqual([]);
  });

  it("reports io when the copy or chmod fails", async () => {
    const copyFails = deps({
      copy: async () => {
        throw new Error("ENOSPC");
      },
    });
    expect(await prepareLinux(copyFails.deps)).toEqual({ ok: false, reason: "io" });
    const chmodFails = deps({
      chmod: async () => {
        throw new Error("EPERM");
      },
    });
    expect(await prepareLinux(chmodFails.deps)).toEqual({ ok: false, reason: "io" });
  });

  it("removes the partial <appImage>.new when the copy or chmod fails", async () => {
    const staged = "/home/me/Apps/Jarvis.AppImage.new";
    const copyFails = deps({
      copy: async () => {
        throw new Error("ENOSPC");
      },
    });
    await prepareLinux(copyFails.deps);
    expect(copyFails.calls.at(-1)).toBe(`remove ${staged}`);
    const chmodFails = deps({
      chmod: async () => {
        throw new Error("EPERM");
      },
    });
    await prepareLinux(chmodFails.deps);
    expect(chmodFails.calls.at(-1)).toBe(`remove ${staged}`);
  });

  it("still reports io when removing the partial copy fails too", async () => {
    const { deps: d } = deps({
      copy: async () => {
        throw new Error("ENOSPC");
      },
      remove: async () => {
        throw new Error("EBUSY");
      },
    });
    expect(await prepareLinux(d)).toEqual({ ok: false, reason: "io" });
  });
});

describe("linuxSwapScript text", () => {
  const odd = "/home/me/It's Mine/Jarvis.AppImage";

  it("single-quotes paths and starts the new AppImage detached", () => {
    const script = linuxSwapScript({ pid: 7, appImage: odd, staged: `${odd}.new` });
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`app='/home/me/It'\\''s Mine/Jarvis.AppImage'`);
    expect(script).toContain(`staged='/home/me/It'\\''s Mine/Jarvis.AppImage.new'`);
    expect(script).toContain(`old='/home/me/It'\\''s Mine/Jarvis.AppImage.old'`);
    expect(script).toContain(`nohup "$app" >/dev/null 2>&1 &`);
  });

  it("restores the old AppImage when the new one cannot be moved in", () => {
    const script = linuxSwapScript({ pid: 7, appImage: odd, staged: `${odd}.new` });
    expect(script).toMatch(/if ! mv "\$staged" "\$app"; then[\s\S]*mv "\$old" "\$app"/);
  });

  it("rejects an AppImage or staged path that is not absolute and normalised", () => {
    for (const bad of ["Jarvis.AppImage", "", "/", "/home/me/../Jarvis.AppImage"]) {
      expect(() => linuxSwapScript({ pid: 7, appImage: bad, staged: `${odd}.new` })).toThrow();
      expect(() => linuxSwapScript({ pid: 7, appImage: odd, staged: bad })).toThrow();
    }
  });

  it("rejects a pid that is not a positive integer", () => {
    expect(() => linuxSwapScript({ pid: -3, appImage: odd, staged: `${odd}.new` })).toThrow();
  });
});

describe.skipIf(process.platform === "win32")("linuxSwapScript run", () => {
  let dir: string;
  afterEach(() => {
    if (dir !== undefined) {
      spawnSync("/bin/chmod", ["-R", "u+w", dir]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "jarvis swap 'l' "));
    const appImage = join(dir, "Jarvis.AppImage");
    writeFileSync(appImage, "old");
    const staged = `${appImage}.new`;
    writeFileSync(staged, "new");
    const log = join(dir, "launched.log");
    const launcher = join(dir, "launcher.sh");
    writeFileSync(launcher, `printf '%s\\n' "$1" >> '${log.replace(/'/g, `'\\''`)}'\n`);
    return { appImage, staged, log, launch: `/bin/sh '${launcher.replace(/'/g, `'\\''`)}'` };
  }

  const exitedPid = () => spawnSync("/usr/bin/true").pid as number;

  function run(script: string) {
    const file = join(dir, "swap.sh");
    writeFileSync(file, script);
    return spawnSync("/bin/sh", [file], { encoding: "utf8" });
  }

  /** The launch runs in the background; wait briefly for its log line. */
  async function launched(log: string): Promise<string> {
    for (let i = 0; i < 50 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 20));
    return readFileSync(log, "utf8");
  }

  it("swaps in the new AppImage, starts it and removes the old one", async () => {
    const { appImage, staged, log, launch } = setup();
    const result = run(linuxSwapScript({ pid: exitedPid(), appImage, staged, launch }));
    expect(result.status).toBe(0);
    expect(readFileSync(appImage, "utf8")).toBe("new");
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(`${appImage}.old`)).toBe(false);
    expect(await launched(log)).toBe(`${appImage}\n`);
  });

  it("leaves everything alone and restarts the app when the staged file is missing", async () => {
    const { appImage, staged, log, launch } = setup();
    rmSync(staged);
    const result = run(linuxSwapScript({ pid: exitedPid(), appImage, staged, launch }));
    expect(result.status).toBe(1);
    expect(readFileSync(appImage, "utf8")).toBe("old");
    expect(existsSync(`${appImage}.old`)).toBe(false);
    expect(await launched(log)).toBe(`${appImage}\n`);
  });

  // Every run that launches is awaited: the launcher writes into `dir` in
  // the background, and a test that ends first races afterEach's rmSync
  // (ENOTEMPTY on macOS CI).
  it("never touches a stale .old when there is no current AppImage", async () => {
    const { appImage, staged, log, launch } = setup();
    rmSync(appImage);
    writeFileSync(`${appImage}.old`, "stale");
    const result = run(linuxSwapScript({ pid: exitedPid(), appImage, staged, launch }));
    expect(result.status).toBe(0);
    expect(readFileSync(appImage, "utf8")).toBe("new");
    expect(readFileSync(`${appImage}.old`, "utf8")).toBe("stale");
    expect(await launched(log)).toBe(`${appImage}\n`);
  });

  it("replaces a stale .old left by a failed earlier run", async () => {
    const { appImage, staged, log, launch } = setup();
    writeFileSync(`${appImage}.old`, "stale");
    const result = run(linuxSwapScript({ pid: exitedPid(), appImage, staged, launch }));
    expect(result.status).toBe(0);
    expect(readFileSync(appImage, "utf8")).toBe("new");
    expect(existsSync(`${appImage}.old`)).toBe(false);
    expect(await launched(log)).toBe(`${appImage}\n`);
  });

  it.skipIf(process.getuid?.() === 0)(
    "puts the old AppImage back and starts it when the new one cannot move in",
    async () => {
      const { appImage, log, launch } = setup();
      const locked = join(dir, "locked");
      mkdirSync(locked);
      const staged = join(locked, "Jarvis.AppImage.new");
      writeFileSync(staged, "new");
      spawnSync("/bin/chmod", ["555", locked]);
      const result = run(linuxSwapScript({ pid: exitedPid(), appImage, staged, launch }));
      expect(result.status).not.toBe(0);
      expect(readFileSync(appImage, "utf8")).toBe("old");
      expect(existsSync(`${appImage}.old`)).toBe(false);
      expect(readFileSync(staged, "utf8")).toBe("new");
      expect(await launched(log)).toBe(`${appImage}\n`);
    },
  );
});
