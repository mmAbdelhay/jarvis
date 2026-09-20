// The real `RemoteFs`/`Timers` the bridge runs on outside a test — `node:fs`
// and `node:timers` wrapped to the exact shapes `io.ts` defines. This file
// (and server.ts, certificate.ts, probe-client.ts) is unreachable from
// `index.ts`: only `listen.ts` re-exports it, so requiring `@jarvis/remote`
// alone never touches the real filesystem or the real clock.

import {
  appendFile as fsAppendFile,
  chmod as fsChmod,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rename as fsRename,
  stat as fsStat,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import type { RemoteFs, Timers } from "./io.js";

export const nodeFs: RemoteFs = {
  async readFile(path) {
    return await fsReadFile(path, "utf8");
  },

  async writeFile(path, data, mode) {
    // Exclusive create (POSIX `wx`): the whole point of writing to a random
    // temp name before renaming over the real target (io.ts, writeFileAtomic).
    await fsWriteFile(path, data, { mode, flag: "wx" });
  },

  async appendFile(path, data, mode) {
    await fsAppendFile(path, data, { mode });
  },

  async rename(from, to) {
    await fsRename(from, to);
  },

  async mkdir(path, mode) {
    await fsMkdir(path, { recursive: true, mode });
  },

  async chmod(path, mode) {
    await fsChmod(path, mode);
  },

  async stat(path) {
    const { mode } = await fsStat(path);
    return { mode };
  },

  async unlink(path) {
    await fsUnlink(path);
  },
};

export const nodeTimers: Timers = {
  setTimeout(callback, ms) {
    // `unref()` so a pending handshake timer, heartbeat or backoff never
    // keeps the Node process alive on its own — the same reason
    // node-pty's and every other background timer in this app unrefs.
    return setTimeout(callback, ms).unref();
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};
