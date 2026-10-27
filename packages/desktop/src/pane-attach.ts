import { join } from "node:path";
import { isFileId, type AttachUploadResult } from "@jarvis/wire";
import type { UploadStore } from "./file-upload.js";
import { MESSAGES } from "./messages.js";

export const ATTACH_EXTENSIONS: Record<string, string> = {
  "image/jpg": "jpg",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
  "text/csv": "csv",
  "text/x-log": "log",
  "application/zip": "zip",
};

/** Metadata supplies only an allowlisted extension, never any part of a
 *  directory or basename. NUL-bearing names are ignored wholesale. */
export function attachFileName(
  now: number,
  hex6: string,
  contentType: string,
  originalName: string,
): string {
  const suffix = originalName.includes("\0")
    ? undefined
    : /\.([a-z]+)$/i.exec(originalName)?.[1]?.toLowerCase();
  const extension = Object.hasOwn(ATTACH_EXTENSIONS, contentType)
    ? ATTACH_EXTENSIONS[contentType]
    : suffix !== undefined && [...Object.values(ATTACH_EXTENSIONS), "jpeg"].includes(suffix)
      ? suffix
      : "bin";
  const date = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}-${hex6}.${extension}`;
}

type PaneAttachDeps = {
  uploads: Pick<UploadStore, "resolve" | "release">;
  /** Claude process cwd, falling back to the tab's project directory. */
  cwdFor(paneKey: string): Promise<string | undefined>;
  fs: {
    mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
    writeFile(
      path: string,
      bytes: string | Uint8Array,
      options: { flag: "wx"; mode: number },
    ): Promise<unknown>;
    realpath(path: string): Promise<string>;
    lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  };
  now(): number;
  /** Byte count: randomHex(3) returns six lowercase hex characters. */
  randomHex(n: number): string;
  log(token: string): void;
};

export function createPaneAttach(deps: PaneAttachDeps): {
  attach(deviceId: string, paneKey: unknown, fileId: unknown): Promise<AttachUploadResult>;
} {
  function failure(token: string, error = MESSAGES.fileUploadFailed("en")): AttachUploadResult {
    try {
      deps.log(`pane-attach: ${token}`);
    } catch {
      // Diagnostics cannot break attachment or reveal dependency errors.
    }
    return { ok: false, error };
  }

  return {
    async attach(deviceId, paneKey, fileId) {
      if (typeof paneKey !== "string" || paneKey.length === 0 || !isFileId(fileId)) {
        return failure("invalid");
      }
      try {
        const upload = await deps.uploads.resolve(deviceId, fileId);
        if (upload === undefined) return failure("notfound", MESSAGES.fileUploadNotFound("en"));
        const cwd = await deps.cwdFor(paneKey);
        if (cwd === undefined || cwd.length === 0) return failure("cwd");
        const directory = join(cwd, ".jarvis", "uploads");
        await deps.fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const [cwdReal, directoryReal, stat] = await Promise.all([
          deps.fs.realpath(cwd),
          deps.fs.realpath(directory),
          deps.fs.lstat(directory),
        ]);
        // Check before even writing .gitignore: a redirected parent or a
        // symlink at uploads must never receive any attachment bytes.
        if (stat.isSymbolicLink() || directoryReal !== join(cwdReal, ".jarvis", "uploads")) {
          return failure("directory");
        }
        try {
          await deps.fs.writeFile(join(directory, ".gitignore"), "*\n", {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          if (
            !(
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "EEXIST"
            )
          )
            throw error;
        }
        const hex = deps.randomHex(3);
        if (!/^[a-f0-9]{6}$/.test(hex)) return failure("random");
        const name = attachFileName(deps.now(), hex, upload.contentType, upload.name);
        // Exclusive creation refuses existing files and symlinks. Keep the
        // staged copy on every failed write so the phone can retry.
        await deps.fs.writeFile(join(directory, name), upload.bytes, { flag: "wx", mode: 0o600 });
        await deps.uploads.release(deviceId, fileId);
        return { ok: true, path: `.jarvis/uploads/${name}` };
      } catch {
        return failure("failed");
      }
    },
  };
}
