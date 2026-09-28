// Phase 1: where the browser build's static export lives, and how the
// bridge's `loadWebManifest` turns it into the web listener's manifest.
//
// The directory is read once, on first use, and the manifest is kept for
// the app's lifetime. A missing directory (or one with no index.html) is
// "not built": nothing is cached, so an export built later is found on the
// next bridge apply. Every other failure rejects; the bridge logs it and
// reads "not-built" too.
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { WebManifest } from "@jarvis/remote";

/** The export is held in memory for the app's lifetime, so its size is
 *  capped: today's export is a few MB, and anything near these is not one. */
export const WEB_EXPORT_FILE_BYTES = 16 * 1024 * 1024;
export const WEB_EXPORT_TOTAL_BYTES = 64 * 1024 * 1024;

export type WebExportFs = {
  /** Every regular file under `dir`, as paths relative to it. Rejects with
   *  ENOENT when `dir` does not exist. */
  listFiles(dir: string): Promise<string[]>;
  /** The bytes of `name` (relative to `dir`), or undefined when it is larger
   *  than `maxBytes`. Rejects for anything but a regular file inside `dir`. */
  readFile(dir: string, name: string, maxBytes: number): Promise<Buffer | undefined>;
};

function refuse(reason: string): Error {
  return new Error(`web export: ${reason}`);
}

async function requireDirectory(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory()) throw refuse(`${label} is not a directory`);
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** The node implementation. Symlinks and other non-files are left out of
 *  the listing, and a read lstat()s the root, every directory below it and
 *  the file itself, so a symlink that is there when the file is read —
 *  including one swapped in after listing — is refused.
 *
 *  Not closed: a directory swapped for a symlink in the instant between its
 *  lstat() and the open(). Node has no openat()/O_BENEATH to walk the tree
 *  race-free, and whoever can rewrite <resources>/web mid-read can already
 *  replace the files themselves. O_NOFOLLOW and the lstat/fstat identity
 *  check below cover only the last component. */
export const nodeWebExportFs: WebExportFs = {
  async listFiles(dir) {
    await requireDirectory(dir, "the export root");
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
  },

  async readFile(dir, name, maxBytes) {
    // Windows takes either separator; elsewhere a backslash is a name byte.
    const parts = name.split(sep === "\\" ? /[\\/]/ : "/");
    if (isAbsolute(name) || parts.some((part) => part === "" || part === "." || part === "..")) {
      throw refuse("a file path leaves the export directory");
    }
    await requireDirectory(dir, "the export root");
    let at = dir;
    for (const part of parts.slice(0, -1)) {
      at = join(at, part);
      await requireDirectory(at, name);
    }
    const path = join(dir, ...parts);
    const before = await lstat(path);
    if (!before.isFile()) throw refuse(`${name} is not a regular file`);
    if (before.size > maxBytes) return undefined;
    // O_NOFOLLOW where the platform has it (not Windows); the fstat below
    // catches the file itself being swapped on every platform.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(before, opened)) {
        throw refuse(`${name} changed while it was read`);
      }
      // One byte past the lstat() size tells a file that grew since apart,
      // so a read never returns more than `maxBytes`.
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length !== before.size) throw refuse(`${name} changed while it was read`);
      return buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
  },
};

/**
 * Packaged: `<resources>/web` (electron-builder.yml's `extraResources`).
 * Development: `packages/desktop/web`, passed in by main.ts — the copy
 * `pnpm build` makes (scripts/copy-web.mjs) and electron-builder ships.
 * The one place to change if the layout moves.
 */
export function webExportDir(options: {
  packaged: boolean;
  resourcesPath: string;
  devDir: string;
}): string {
  return options.packaged ? join(options.resourcesPath, "web") : options.devDir;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

/** "a/b.js" (either separator) → "/a/b.js"; refuses anything that climbs out. */
function urlPath(relativePath: string): string {
  const parts = relativePath.split(sep).join("/").split("/");
  if (parts.some((part) => part === ".." || part === "")) {
    throw refuse("a file path leaves the export directory");
  }
  return `/${parts.join("/")}`;
}

export function createWebManifestLoader(deps: {
  dir(): string;
  fs: WebExportFs;
  build(files: Iterable<{ path: string; bytes: Buffer }>): WebManifest;
  limits?: { fileBytes: number; totalBytes: number };
}): () => Promise<WebManifest | undefined> {
  const { fileBytes, totalBytes } = deps.limits ?? {
    fileBytes: WEB_EXPORT_FILE_BYTES,
    totalBytes: WEB_EXPORT_TOTAL_BYTES,
  };
  let loaded: Promise<WebManifest | undefined> | undefined;

  async function read(): Promise<WebManifest | undefined> {
    const dir = deps.dir();
    let names: string[];
    try {
      names = await deps.fs.listFiles(dir);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const paths = names.map((name) => ({ name, path: urlPath(name) }));
    if (!paths.some((entry) => entry.path === "/index.html")) return undefined;
    // An export over either cap is refused outright: the rejection is logged
    // by the bridge and reads as not-built, never as a partial site.
    const files: { path: string; bytes: Buffer }[] = [];
    let total = 0;
    for (const entry of paths) {
      const remaining = totalBytes - total;
      const maxBytes = Math.min(fileBytes, remaining);
      const bytes = await deps.fs.readFile(dir, entry.name, maxBytes);
      if (bytes === undefined || bytes.length > maxBytes) {
        throw remaining < fileBytes
          ? refuse(`over the ${totalBytes}-byte total limit`)
          : refuse(`${entry.name} is over the ${fileBytes}-byte file limit`);
      }
      total += bytes.length;
      files.push({ path: entry.path, bytes });
    }
    return deps.build(files);
  }

  return () => {
    if (loaded === undefined) {
      const attempt = read();
      loaded = attempt;
      // Only a built export is kept: "not built" and failures are retried.
      attempt.then(
        (manifest) => {
          if (manifest === undefined && loaded === attempt) loaded = undefined;
        },
        () => {
          if (loaded === attempt) loaded = undefined;
        },
      );
    }
    return loaded;
  };
}
