// An in-memory RemoteFs for tests: no real disk, so a test can assert on
// exactly what got written (and at what mode) without touching a temp
// directory or cleaning one up afterwards.

import type { RemoteFs } from "./io.js";

type FileEntry = { data: string; mode: number };

function fsError(code: "ENOENT" | "EEXIST", path: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${path}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

export function memoryFs(): RemoteFs & {
  files: Map<string, FileEntry>;
  dirs: Map<string, number>;
} {
  const files = new Map<string, FileEntry>();
  const dirs = new Map<string, number>();

  return {
    files,
    dirs,

    async readFile(path) {
      const entry = files.get(path);
      if (entry === undefined) throw fsError("ENOENT", path);
      return entry.data;
    },

    async writeFile(path, data, mode) {
      // Exclusive create: mirrors POSIX `wx`, which is the whole point of
      // writing to a random temp name before renaming over the real target.
      if (files.has(path)) throw fsError("EEXIST", path);
      files.set(path, { data, mode });
    },

    async appendFile(path, data, mode) {
      const existing = files.get(path);
      files.set(path, { data: (existing?.data ?? "") + data, mode: existing?.mode ?? mode });
    },

    async rename(from, to) {
      const entry = files.get(from);
      if (entry === undefined) throw fsError("ENOENT", from);
      files.delete(from);
      files.set(to, entry); // whole-file replace: `to`'s previous contents, if any, are gone
    },

    async mkdir(path, mode) {
      if (!dirs.has(path)) dirs.set(path, mode);
    },

    async chmod(path, mode) {
      const file = files.get(path);
      if (file !== undefined) {
        files.set(path, { ...file, mode });
        return;
      }
      if (dirs.has(path)) {
        dirs.set(path, mode);
        return;
      }
      throw fsError("ENOENT", path);
    },

    async stat(path) {
      const file = files.get(path);
      if (file !== undefined) return { mode: file.mode };
      const dirMode = dirs.get(path);
      if (dirMode !== undefined) return { mode: dirMode };
      throw fsError("ENOENT", path);
    },

    async unlink(path) {
      if (!files.has(path)) throw fsError("ENOENT", path);
      files.delete(path);
    },
  };
}
