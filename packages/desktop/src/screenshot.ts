// The topbar screenshot button's main side. Electron-free: everything it
// touches (the capturer, the clipboard, the save dialog, the file system, a
// child process) arrives in `ScreenshotDeps`, wired in electron-screenshot.ts.
//
// The last PNG lives in this process only. The renderer is handed a small
// thumbnail and an opaque id, and can ask to save that id; it never names a
// path or supplies bytes.
import { dirname, basename, join } from "node:path";
import { errorMessage, MESSAGES } from "./messages.js";

export type ScreenshotMode = "area" | "window" | "screen";
type Language = "ar" | "en";

/** The slice of Electron's NativeImage this module uses. */
export type ImageLike = {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toPNG(): Buffer;
  resize(options: { width: number }): ImageLike;
  toDataURL(): string;
};

export type CaptureSource = { id: string; display_id: string; thumbnail: ImageLike };

export type ScreenshotOutcome =
  | { ok: true; id: string; thumbnail: string; width: number; height: number }
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "permission" | "busy" | "failed"; message: string };

export type ScreenshotSaveResult =
  | { ok: true; path: string; name: string }
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "invalid" | "busy" | "failed"; message: string };

export type ScreenshotDeps = {
  platform: NodeJS.Platform;
  language: Language;
  /** execFile with no shell; resolves on exit 0, rejects otherwise. */
  execFile(file: string, args: string[], options: { timeout: number }): Promise<void>;
  makeTempDir(): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  removeDir(dir: string): Promise<void>;
  writeFile(path: string, bytes: Buffer): Promise<void>;
  imageFromPng(bytes: Buffer): ImageLike;
  /** Puts the PNG on the system clipboard as an image. */
  writeClipboardPng(png: Buffer): Promise<void>;
  /** macOS's screen-recording status for this app. */
  screenAccess(): string;
  getSources(options: {
    types: ("window" | "screen")[];
    thumbnailSize: { width: number; height: number };
  }): Promise<CaptureSource[]>;
  windowSourceId(): string;
  /** The window's size in device-independent pixels. */
  windowSize(): { width: number; height: number };
  /** The display the window is on. */
  display(): { id: number; size: { width: number; height: number }; scaleFactor: number };
  showSaveDialog(options: {
    defaultPath: string;
  }): Promise<{ canceled: boolean; filePath?: string | undefined }>;
  defaultFolder(): string;
  now(): Date;
  newId(): string;
  delay(ms: number): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
};

export type Screenshots = {
  capture(mode: ScreenshotMode): Promise<ScreenshotOutcome>;
  save(id: unknown): Promise<ScreenshotSaveResult>;
};

const SCREENCAPTURE = "/usr/sbin/screencapture";
const AREA_TIMEOUT_MS = 5 * 60 * 1000;
const HOLD_MS = 10 * 60 * 1000;
const THUMBNAIL_WIDTH = 320;
// Long enough for a native menu to finish fading before the window is grabbed.
const MENU_CLOSE_MS = 250;

const pad = (n: number): string => String(n).padStart(2, "0");

export function screenshotFileName(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `Jarvis screenshot ${day} at ${time}.png`;
}

export function screenshotMenuTemplate(
  platform: NodeJS.Platform,
  language: Language,
  pick: (mode: ScreenshotMode) => void,
): { label: string; click: () => void }[] {
  const items: { label: string; click: () => void }[] = [];
  if (platform === "darwin") {
    items.push({ label: MESSAGES.screenshotMenuArea(language), click: () => pick("area") });
  }
  items.push({ label: MESSAGES.screenshotMenuWindow(language), click: () => pick("window") });
  items.push({ label: MESSAGES.screenshotMenuScreen(language), click: () => pick("screen") });
  return items;
}

export function createScreenshots(deps: ScreenshotDeps): Screenshots {
  const L = deps.language;
  let busy = false;
  let saving = false;
  let held: { id: string; png: Buffer; timer: unknown } | undefined;
  let lastFolder: string | undefined;

  const fail = (reason: "permission" | "busy" | "failed", message: string): ScreenshotOutcome => ({
    ok: false,
    reason,
    message,
  });

  async function hold(image: ImageLike): Promise<ScreenshotOutcome> {
    const png = image.toPNG();
    await deps.writeClipboardPng(png);
    if (held !== undefined) deps.clearTimer(held.timer);
    const id = deps.newId();
    const timer = deps.setTimer(() => {
      if (held?.id === id) held = undefined;
    }, HOLD_MS);
    held = { id, png, timer };
    const size = image.getSize();
    const thumb = size.width > THUMBNAIL_WIDTH ? image.resize({ width: THUMBNAIL_WIDTH }) : image;
    return { ok: true, id, thumbnail: thumb.toDataURL(), width: size.width, height: size.height };
  }

  async function captureArea(): Promise<ScreenshotOutcome> {
    if (deps.platform !== "darwin") return fail("failed", MESSAGES.screenshotFailed("area", L));
    const dir = await deps.makeTempDir();
    try {
      const file = join(dir, "capture.png");
      try {
        await deps.execFile(SCREENCAPTURE, ["-i", "-x", "-t", "png", file], {
          timeout: AREA_TIMEOUT_MS,
        });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        const killed = (error as { killed?: unknown } | null)?.killed === true;
        // A spawn error (string code) or a timeout kill is a failure; a plain
        // non-zero exit with nothing written is the user backing out.
        if (typeof code === "string" || killed) {
          return fail("failed", MESSAGES.screenshotFailed(errorMessage(error), L));
        }
      }
      let bytes: Buffer;
      try {
        bytes = await deps.readFile(file);
      } catch {
        return { ok: false, reason: "cancelled" };
      }
      if (bytes.length === 0) return { ok: false, reason: "cancelled" };
      const image = deps.imageFromPng(bytes);
      if (image.isEmpty()) return fail("failed", MESSAGES.screenshotFailed("empty image", L));
      return await hold(image);
    } finally {
      await deps.removeDir(dir).catch(() => undefined);
    }
  }

  async function captureSource(mode: "window" | "screen"): Promise<ScreenshotOutcome> {
    const display = deps.display();
    const scale = display.scaleFactor;
    const base = mode === "window" ? deps.windowSize() : display.size;
    const thumbnailSize = {
      width: Math.max(1, Math.round(base.width * scale)),
      height: Math.max(1, Math.round(base.height * scale)),
    };
    await deps.delay(MENU_CLOSE_MS);
    const sources = await deps.getSources({ types: [mode], thumbnailSize });
    const source =
      mode === "window"
        ? sources.find((s) => s.id === deps.windowSourceId())
        : // Linux leaves display_id empty; with one screen there is nothing to choose.
          (sources.find((s) => s.display_id === String(display.id)) ??
          (sources.length === 1 ? sources[0] : undefined));
    if (source === undefined || source.thumbnail.isEmpty()) {
      // On macOS a missing or empty source is how a refused permission shows.
      return deps.platform === "darwin"
        ? fail("permission", MESSAGES.screenshotPermission(L))
        : fail("failed", MESSAGES.screenshotFailed("no source", L));
    }
    return await hold(source.thumbnail);
  }

  return {
    async capture(mode) {
      if (busy) return fail("busy", MESSAGES.screenshotBusy(L));
      // Without the permission macOS hands back the wallpaper, not an error.
      if (deps.platform === "darwin") {
        const status = deps.screenAccess();
        if (status === "denied" || status === "restricted") {
          return fail("permission", MESSAGES.screenshotPermission(L));
        }
      }
      busy = true;
      try {
        return mode === "area" ? await captureArea() : await captureSource(mode);
      } catch (error) {
        return fail("failed", MESSAGES.screenshotFailed(errorMessage(error), L));
      } finally {
        busy = false;
      }
    },

    async save(id) {
      if (typeof id !== "string" || held === undefined || held.id !== id) {
        return { ok: false, reason: "invalid", message: MESSAGES.screenshotGone(L) };
      }
      if (saving) return { ok: false, reason: "busy", message: MESSAGES.screenshotBusy(L) };
      saving = true;
      const shot = held;
      try {
        const folder = lastFolder ?? deps.defaultFolder();
        const chosen = await deps.showSaveDialog({
          defaultPath: join(folder, screenshotFileName(deps.now())),
        });
        if (chosen.canceled || chosen.filePath === undefined || chosen.filePath === "") {
          return { ok: false, reason: "cancelled" };
        }
        const path = chosen.filePath.toLowerCase().endsWith(".png")
          ? chosen.filePath
          : `${chosen.filePath}.png`;
        try {
          await deps.writeFile(path, shot.png);
        } catch (error) {
          return {
            ok: false,
            reason: "failed",
            message: MESSAGES.screenshotSaveFailed(errorMessage(error), L),
          };
        }
        lastFolder = dirname(path);
        return { ok: true, path, name: basename(path) };
      } catch (error) {
        return {
          ok: false,
          reason: "failed",
          message: MESSAGES.screenshotSaveFailed(errorMessage(error), L),
        };
      } finally {
        saving = false;
      }
    },
  };
}
