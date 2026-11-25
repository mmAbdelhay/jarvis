// Wires screenshot.ts to Electron and node. Everything with logic is in
// screenshot.ts and tested there; this file only names the real handles.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  app,
  ClipboardItem,
  clipboard,
  desktopCapturer,
  dialog,
  nativeImage,
  screen,
  systemPreferences,
  type BrowserWindow,
} from "electron";
import { createScreenshots, type Screenshots } from "./screenshot.js";

export function createElectronScreenshots(
  window: BrowserWindow,
  language: "ar" | "en",
  platform: NodeJS.Platform,
): Screenshots {
  const display = () => screen.getDisplayMatching(window.getBounds());
  return createScreenshots({
    platform,
    language,
    execFile: (file, args, options) =>
      new Promise<void>((resolve, reject) => {
        execFile(file, args, { timeout: options.timeout }, (error) =>
          error === null ? resolve() : reject(error),
        );
      }),
    makeTempDir: () => mkdtemp(join(tmpdir(), "jarvis-shot-")),
    readFile: (path) => readFile(path),
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
    writeFile: (path, bytes) => writeFile(path, bytes),
    imageFromPng: (bytes) => nativeImage.createFromBuffer(bytes),
    writeClipboardPng: (png) =>
      clipboard.write([
        new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }) }),
      ]),
    screenAccess: () => systemPreferences.getMediaAccessStatus("screen"),
    getSources: (options) => desktopCapturer.getSources({ ...options, fetchWindowIcons: false }),
    windowSourceId: () => window.getMediaSourceId(),
    windowSize: () => {
      const { width, height } = window.getBounds();
      return { width, height };
    },
    display: () => {
      const d = display();
      return { id: d.id, size: d.size, scaleFactor: d.scaleFactor };
    },
    showSaveDialog: (options) =>
      dialog.showSaveDialog(window, {
        defaultPath: options.defaultPath,
        filters: [{ name: "PNG", extensions: ["png"] }],
      }),
    defaultFolder: () => {
      try {
        return app.getPath("pictures");
      } catch {
        return app.getPath("home");
      }
    },
    now: () => new Date(),
    newId: () => randomUUID(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  });
}
