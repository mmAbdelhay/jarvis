import { describe, expect, it, vi } from "vitest";
import { MESSAGES } from "./messages.js";
import {
  createScreenshots,
  type CaptureSource,
  screenshotFileName,
  screenshotMenuTemplate,
  type ImageLike,
  type ScreenshotDeps,
} from "./screenshot.js";

function image(width = 1000, height = 500, empty = false, bytes = "PNGDATA"): ImageLike {
  const self: ImageLike = {
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.from(bytes),
    resize: ({ width: w }) => image(w, Math.round((height * w) / width), false, "THUMB"),
    toDataURL: () => `data:image/png;base64,${width}x${height}`,
  };
  return self;
}

function fakeDeps(over: Partial<ScreenshotDeps> = {}) {
  const files = new Map<string, Buffer>();
  const removed: string[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const deps: ScreenshotDeps = {
    platform: "darwin",
    language: "en",
    execFile: vi.fn(async (_file: string, args: string[]) => {
      files.set(args[args.length - 1] as string, Buffer.from("AREA"));
    }),
    makeTempDir: vi.fn(async () => "/tmp/jarvis-shot-abc"),
    readFile: vi.fn(async (path: string) => {
      const found = files.get(path);
      if (found === undefined) throw Object.assign(new Error("nope"), { code: "ENOENT" });
      return found;
    }),
    removeDir: vi.fn(async (dir: string) => {
      removed.push(dir);
    }),
    writeFile: vi.fn(async () => {}),
    imageFromPng: vi.fn(() => image()),
    writeClipboardPng: vi.fn(async () => {}),
    screenAccess: vi.fn(() => "granted"),
    getSources: vi.fn(async () => [
      { id: "window:7:0", display_id: "", thumbnail: image(1600, 1000) },
      { id: "screen:1:0", display_id: "42", thumbnail: image(3000, 2000) },
    ]),
    windowSourceId: () => "window:7:0",
    windowSize: () => ({ width: 800, height: 500 }),
    display: () => ({ id: 42, size: { width: 1500, height: 1000 }, scaleFactor: 2 }),
    showSaveDialog: vi.fn(async (o: { defaultPath: string }) => ({
      canceled: false,
      filePath: o.defaultPath,
    })),
    defaultFolder: () => "/Users/me/Pictures",
    now: () => new Date(2026, 10, 25, 9, 5, 7),
    newId: () => "id-1",
    delay: vi.fn(async () => {}),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { cleared: boolean }).cleared = true;
    },
    ...over,
  };
  return { deps, files, removed, timers };
}

describe("screenshotFileName", () => {
  it("is Jarvis screenshot YYYY-MM-DD at HH.MM.SS.png, zero padded", () => {
    expect(screenshotFileName(new Date(2026, 0, 3, 4, 5, 6))).toBe(
      "Jarvis screenshot 2026-01-03 at 04.05.06.png",
    );
  });
});

describe("screenshotMenuTemplate", () => {
  const pick = vi.fn();
  it("macOS lists area first, then window and screen", () => {
    const t = screenshotMenuTemplate("darwin", "en", pick);
    expect(t.map((i) => i.label)).toEqual(["Select an area", "This window", "Whole screen"]);
  });
  it("other platforms have no area item", () => {
    for (const platform of ["win32", "linux"] as const) {
      const t = screenshotMenuTemplate(platform, "en", pick);
      expect(t.map((i) => i.label)).toEqual(["This window", "Whole screen"]);
    }
  });
  it("each item picks its own mode, and labels follow the language", () => {
    const t = screenshotMenuTemplate("darwin", "ar", pick);
    expect(t.map((i) => i.label)).toEqual([
      MESSAGES.screenshotMenuArea("ar"),
      MESSAGES.screenshotMenuWindow("ar"),
      MESSAGES.screenshotMenuScreen("ar"),
    ]);
    (t[0]?.click as (() => void) | undefined)?.();
    (t[1]?.click as (() => void) | undefined)?.();
    (t[2]?.click as (() => void) | undefined)?.();
    expect(pick.mock.calls.map((c) => c[0])).toEqual(["area", "window", "screen"]);
  });
});

describe("area capture", () => {
  it("runs screencapture without a shell into a fresh temp dir, copies the PNG, removes the dir", async () => {
    const { deps, removed } = fakeDeps();
    const shots = createScreenshots(deps);
    const out = await shots.capture("area");
    expect(deps.execFile).toHaveBeenCalledWith(
      "/usr/sbin/screencapture",
      ["-i", "-x", "-t", "png", "/tmp/jarvis-shot-abc/capture.png"],
      expect.anything(),
    );
    expect(deps.writeClipboardPng).toHaveBeenCalledWith(Buffer.from("PNGDATA"));
    expect(out).toMatchObject({ ok: true, id: "id-1", width: 1000, height: 500 });
    expect(removed).toEqual(["/tmp/jarvis-shot-abc"]);
  });

  it("returns a thumbnail data URL of at most 320px wide", async () => {
    const { deps } = fakeDeps();
    const out = await createScreenshots(deps).capture("area");
    expect(out).toMatchObject({ ok: true, thumbnail: "data:image/png;base64,320x160" });
  });

  it("keeps a small image as its own thumbnail", async () => {
    const { deps } = fakeDeps({ imageFromPng: () => image(200, 100) });
    const out = await createScreenshots(deps).capture("area");
    expect(out).toMatchObject({ ok: true, thumbnail: "data:image/png;base64,200x100" });
  });

  it("is a silent cancel when no file appears, and still removes the dir", async () => {
    const { deps, removed } = fakeDeps({ execFile: vi.fn(async () => {}) });
    expect(await createScreenshots(deps).capture("area")).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(deps.writeClipboardPng).not.toHaveBeenCalled();
    expect(removed).toEqual(["/tmp/jarvis-shot-abc"]);
  });

  it("is a silent cancel for an empty file", async () => {
    const { deps } = fakeDeps({
      execFile: vi.fn(async () => {}),
      readFile: vi.fn(async () => Buffer.alloc(0)),
    });
    expect(await createScreenshots(deps).capture("area")).toEqual({
      ok: false,
      reason: "cancelled",
    });
  });

  it("treats a non-zero exit with no file as a cancel, but a spawn error as a failure", async () => {
    const exit = fakeDeps({
      execFile: vi.fn(async () => {
        throw Object.assign(new Error("exit 1"), { code: 1 });
      }),
    });
    expect(await createScreenshots(exit.deps).capture("area")).toEqual({
      ok: false,
      reason: "cancelled",
    });
    const spawn = fakeDeps({
      execFile: vi.fn(async () => {
        throw Object.assign(new Error("spawn"), { code: "ENOENT" });
      }),
    });
    const out = await createScreenshots(spawn.deps).capture("area");
    expect(out).toMatchObject({ ok: false, reason: "failed" });
    expect(spawn.removed).toEqual(["/tmp/jarvis-shot-abc"]);
  });

  it("is refused off macOS", async () => {
    const { deps } = fakeDeps({ platform: "linux" });
    expect(await createScreenshots(deps).capture("area")).toMatchObject({
      ok: false,
      reason: "failed",
    });
    expect(deps.execFile).not.toHaveBeenCalled();
  });
});

describe("window and screen capture", () => {
  it("captures the window's source at its real pixel size", async () => {
    const { deps } = fakeDeps({
      display: () => ({ id: 42, size: { width: 1500, height: 1000 }, scaleFactor: 2 }),
    });
    const out = await createScreenshots(deps).capture("window");
    expect(deps.getSources).toHaveBeenCalledWith({
      types: ["window"],
      thumbnailSize: { width: 1600, height: 1000 },
    });
    expect(out).toMatchObject({ ok: true, width: 1600, height: 1000 });
    expect(deps.writeClipboardPng).toHaveBeenCalledTimes(1);
  });

  it("captures the screen the window is on, at its real pixel size", async () => {
    const { deps } = fakeDeps();
    const out = await createScreenshots(deps).capture("screen");
    expect(deps.getSources).toHaveBeenCalledWith({
      types: ["screen"],
      thumbnailSize: { width: 3000, height: 2000 },
    });
    expect(out).toMatchObject({ ok: true, width: 3000, height: 2000 });
  });

  it("waits for the menu to close before grabbing", async () => {
    const { deps } = fakeDeps();
    await createScreenshots(deps).capture("window");
    expect(deps.delay).toHaveBeenCalled();
  });

  it("reports permission when macOS says denied or restricted, without capturing", async () => {
    for (const status of ["denied", "restricted"]) {
      const { deps } = fakeDeps({ screenAccess: () => status });
      const out = await createScreenshots(deps).capture("window");
      expect(out).toEqual({
        ok: false,
        reason: "permission",
        message: MESSAGES.screenshotPermission("en"),
      });
      expect(deps.getSources).not.toHaveBeenCalled();
    }
  });

  it("reports permission when there is no matching source or the image is empty", async () => {
    const none = fakeDeps({ getSources: vi.fn(async () => []) });
    expect(await createScreenshots(none.deps).capture("screen")).toMatchObject({
      ok: false,
      reason: "permission",
    });
    const blank = fakeDeps({
      getSources: vi.fn(async () => [
        { id: "window:7:0", display_id: "", thumbnail: image(1, 1, true) },
      ]),
    });
    expect(await createScreenshots(blank.deps).capture("window")).toMatchObject({
      ok: false,
      reason: "permission",
    });
    expect(blank.deps.writeClipboardPng).not.toHaveBeenCalled();
  });

  it("refuses an area without the permission, which would capture only the wallpaper", async () => {
    const { deps } = fakeDeps({ screenAccess: () => "denied" });
    expect(await createScreenshots(deps).capture("area")).toMatchObject({ reason: "permission" });
    expect(deps.execFile).not.toHaveBeenCalled();
  });

  it("takes the only screen when Linux names no display, and never blames macOS", async () => {
    const one = fakeDeps({
      platform: "linux",
      getSources: vi.fn(async () => [{ id: "s", display_id: "", thumbnail: image(10, 10) }]),
    });
    expect(await createScreenshots(one.deps).capture("screen")).toMatchObject({ ok: true });
    const none = fakeDeps({ platform: "linux", getSources: vi.fn(async () => []) });
    expect(await createScreenshots(none.deps).capture("screen")).toMatchObject({
      reason: "failed",
    });
  });

  it("does not ask macOS about permission on other platforms", async () => {
    const { deps } = fakeDeps({ platform: "linux", screenAccess: vi.fn(() => "denied") });
    expect(await createScreenshots(deps).capture("window")).toMatchObject({ ok: true });
  });

  it("fails with a message when the capturer throws", async () => {
    const { deps } = fakeDeps({
      getSources: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const out = await createScreenshots(deps).capture("window");
    expect(out).toEqual({
      ok: false,
      reason: "failed",
      message: MESSAGES.screenshotFailed("boom", "en"),
    });
  });

  it("fails when the clipboard throws", async () => {
    const { deps } = fakeDeps({
      writeClipboardPng: vi.fn(async () => {
        throw new Error("clip");
      }),
    });
    expect(await createScreenshots(deps).capture("window")).toMatchObject({
      ok: false,
      reason: "failed",
    });
    expect(await createScreenshots(deps).capture("window")).not.toHaveProperty("id");
  });
});

describe("one capture at a time", () => {
  it("refuses a second capture while one runs, then allows another", async () => {
    let release: (() => void) | undefined;
    const { deps } = fakeDeps({
      getSources: vi.fn(
        () =>
          new Promise<CaptureSource[]>((resolve) => {
            release = () => resolve([{ id: "window:7:0", display_id: "", thumbnail: image() }]);
          }),
      ),
    });
    const shots = createScreenshots(deps);
    const first = shots.capture("window");
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await shots.capture("screen")).toEqual({
      ok: false,
      reason: "busy",
      message: MESSAGES.screenshotBusy("en"),
    });
    release?.();
    expect(await first).toMatchObject({ ok: true });
    const { deps: d2 } = fakeDeps();
    expect(await createScreenshots(d2).capture("window")).toMatchObject({ ok: true });
  });

  it("frees the slot after a failure", async () => {
    const { deps } = fakeDeps({
      getSources: vi
        .fn()
        .mockRejectedValueOnce(new Error("x"))
        .mockResolvedValue([{ id: "window:7:0", display_id: "", thumbnail: image() }]),
    });
    const shots = createScreenshots(deps);
    expect(await shots.capture("window")).toMatchObject({ reason: "failed" });
    expect(await shots.capture("window")).toMatchObject({ ok: true });
  });
});

describe("save", () => {
  async function held() {
    const f = fakeDeps();
    const shots = createScreenshots(f.deps);
    await shots.capture("window");
    return { ...f, shots };
  }

  it("only saves a held id, and never takes a path or bytes", async () => {
    const { deps, shots } = await held();
    expect(await shots.save("nope")).toMatchObject({ ok: false, reason: "invalid" });
    expect(await shots.save(42 as never)).toMatchObject({ ok: false, reason: "invalid" });
    expect(deps.showSaveDialog).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it("offers the default name in Pictures first, writes the held PNG where it was chosen", async () => {
    const { deps, shots } = await held();
    deps.showSaveDialog = vi.fn(async () => ({
      canceled: false,
      filePath: "/Users/me/Desktop/shot.png",
    }));
    const out = await shots.save("id-1");
    expect(out).toEqual({ ok: true, path: "/Users/me/Desktop/shot.png", name: "shot.png" });
    expect(deps.writeFile).toHaveBeenCalledWith(
      "/Users/me/Desktop/shot.png",
      Buffer.from("PNGDATA"),
    );
    // next time the dialog opens in the last folder
    deps.showSaveDialog = vi.fn(async (o: { defaultPath: string }) => ({
      canceled: true,
      filePath: o.defaultPath,
    }));
    await shots.save("id-1");
    expect(deps.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: "/Users/me/Desktop/Jarvis screenshot 2026-11-25 at 09.05.07.png",
    });
  });

  it("defaults to the Pictures folder before anything was saved", async () => {
    const { deps, shots } = await held();
    await shots.save("id-1");
    expect(deps.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: "/Users/me/Pictures/Jarvis screenshot 2026-11-25 at 09.05.07.png",
    });
  });

  it("adds .png when the chosen name lacks it", async () => {
    const { deps, shots } = await held();
    deps.showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: "/x/shot" }));
    expect(await shots.save("id-1")).toMatchObject({ ok: true, path: "/x/shot.png" });
  });

  it("a cancelled dialog writes nothing and is silent", async () => {
    const { deps, shots } = await held();
    deps.showSaveDialog = vi.fn(async () => ({ canceled: true }));
    expect(await shots.save("id-1")).toEqual({ ok: false, reason: "cancelled" });
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it("says why when the write fails, and keeps the screenshot for a retry", async () => {
    const { deps, shots } = await held();
    deps.writeFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    expect(await shots.save("id-1")).toEqual({
      ok: false,
      reason: "failed",
      message: MESSAGES.screenshotSaveFailed("disk full", "en"),
    });
    expect(await shots.save("id-1")).toMatchObject({ ok: true });
  });

  it("does not open a second dialog while one is up", async () => {
    const { deps, shots } = await held();
    let close: ((v: { canceled: boolean }) => void) | undefined;
    deps.showSaveDialog = vi.fn(
      () => new Promise<{ canceled: boolean }>((resolve) => (close = resolve)),
    );
    const first = shots.save("id-1");
    await vi.waitFor(() => expect(close).toBeDefined());
    expect(await shots.save("id-1")).toMatchObject({ ok: false, reason: "busy" });
    close?.({ canceled: true });
    await first;
  });
});

describe("the held screenshot", () => {
  it("is replaced by the next capture: the old id stops working and its timer is cleared", async () => {
    let n = 0;
    const f = fakeDeps({ newId: () => `id-${++n}` });
    const shots = createScreenshots(f.deps);
    await shots.capture("window");
    await shots.capture("window");
    expect(f.timers[0]?.cleared).toBe(true);
    expect(await shots.save("id-1")).toMatchObject({ reason: "invalid" });
    expect(await shots.save("id-2")).toMatchObject({ ok: true });
  });

  it("is dropped after ten minutes", async () => {
    const f = fakeDeps();
    const shots = createScreenshots(f.deps);
    await shots.capture("window");
    expect(f.timers[0]?.ms).toBe(10 * 60 * 1000);
    f.timers[0]?.fn();
    expect(await shots.save("id-1")).toMatchObject({
      ok: false,
      reason: "invalid",
      message: MESSAGES.screenshotGone("en"),
    });
  });

  it("a failed capture leaves the previous screenshot in place", async () => {
    const f = fakeDeps();
    const shots = createScreenshots(f.deps);
    await shots.capture("window");
    f.deps.screenAccess = () => "denied";
    await shots.capture("window");
    expect(await shots.save("id-1")).toMatchObject({ ok: true });
  });
});
