// File access for the account dirs. removeTree refuses anything that is not
// strictly inside one of the three account roots, so a bug can never delete
// $HOME or jarvis.yaml. Reads go through readRegularFile: the config and temp
// dirs are writable by the sandboxed CLI (threat A4), so a FIFO, a symlink or
// a /dev/zero link planted there must never block, redirect or flood jarvisd.
//
// No electron here (core/no-electron.test.ts).
import { constants } from "node:fs";
import { access, chmod, mkdir, open, rm } from "node:fs/promises";
import { posix } from "node:path";

export type AccountFs = {
  readText(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Recursive; the leaf and the account root above it end up 0700. */
  makeDir(path: string): Promise<void>;
  removeTree(path: string): Promise<void>;
};

/** Largest file jarvisd reads from an account dir (a CLI package-lock is ~100 KiB). */
export const ACCOUNT_READ_MAX_BYTES = 4 * 1024 * 1024;
const OPEN_URL_MAX_BYTES = 4096;

/**
 * Reads a regular file without following a final symlink (O_NOFOLLOW), without
 * blocking on a FIFO (O_NONBLOCK, then fstat must say regular file), and never
 * more than maxBytes.
 */
export async function readRegularFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    if (stat.size > maxBytes) throw new Error(`${path} is too large`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, maxBytes + 1 - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(`${path} is too large`);
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** The browser shim's open-url drop: read once, then removed; undefined when absent or unsafe. */
export async function readOpenUrlFile(path: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readRegularFile(path, OPEN_URL_MAX_BYTES);
  } catch {
    await rm(path, { force: true }).catch(() => {});
    return undefined;
  }
  await rm(path, { force: true }).catch(() => {});
  const url = raw.trim();
  return url === "" ? undefined : url;
}

export function accountRoots(home: string): string[] {
  return [
    posix.join(home, ".config", "jarvis", "accounts"),
    posix.join(home, ".local", "share", "jarvis", "clis"),
    posix.join(home, ".cache", "jarvis", "accounts"),
  ];
}

export function insideAccountRoot(home: string, path: string): string | undefined {
  const normal = posix.normalize(path);
  return accountRoots(home).find(
    (root) => normal.startsWith(`${root}/`) && normal.length > root.length + 1,
  );
}

export function nodeAccountFs(home: string): AccountFs {
  return {
    readText: (path) => readRegularFile(path, ACCOUNT_READ_MAX_BYTES),
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    async makeDir(path) {
      const root = insideAccountRoot(home, path);
      if (root === undefined) throw new Error(`refusing to create ${path}`);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700);
      await chmod(path, 0o700);
    },
    async removeTree(path) {
      if (insideAccountRoot(home, path) === undefined)
        throw new Error(`refusing to remove ${path}`);
      await rm(path, { recursive: true, force: true });
    },
  };
}
