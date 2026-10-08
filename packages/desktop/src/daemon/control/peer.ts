// Which program is on the other end of a control connection (Rafiq M3 §3:
// sys:setLocked is accepted from /usr/bin/jarvis-lock only). Node exposes no
// SO_PEERCRED and this project ships no native module, so the kernel is asked
// through sock_diag instead: `ss -xpH` lists every Unix socket with its own
// inode, its peer's inode and the processes holding it. Our accepted socket's
// row names the peer inode; that inode's row names the owning pid; the pid's
// /proc/<pid>/exe names the program. Nothing here trusts the client. Any doubt
// answers undefined, which the caller treats as "not the lock screen".
//
// No electron here (core/no-electron.test.ts).
import { execFile } from "node:child_process";
import { readdir, readlink } from "node:fs/promises";
import type { Socket } from "node:net";

export const SS_PATH = "/usr/bin/ss";
const SS_TIMEOUT_MS = 2_000;
const SS_MAX_BYTES = 8 * 1024 * 1024;

export type SsUnixRow = { localInode: string; peerInode: string; pids: number[] };

// Netid State Recv-Q Send-Q <local address (may hold spaces)> <inode> <peer address> <inode> [users:(…)]
const ROW = /^\S+\s+\S+\s+\d+\s+\d+\s+.+?\s+(\d+)\s+\S+\s+(\d+)(?:\s+(users:\(.*\)))?\s*$/;

export function parseSsUnix(output: string): SsUnixRow[] {
  const rows: SsUnixRow[] = [];
  for (const line of output.split("\n")) {
    const match = ROW.exec(line.trim());
    if (match === null) continue;
    const pids = [
      ...new Set([...(match[3] ?? "").matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]))),
    ];
    rows.push({ localInode: match[1] as string, peerInode: match[2] as string, pids });
  }
  return rows;
}

export function inodeOfLink(link: string): string | undefined {
  return /^socket:\[(\d+)\]$/.exec(link)?.[1];
}

export type PeerDeps = {
  fdOf(socket: Socket): number | undefined;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  listUnixSockets(): Promise<string>;
};

export async function peerExecutable(socket: Socket, deps: PeerDeps): Promise<string | undefined> {
  try {
    const fd = deps.fdOf(socket);
    if (fd === undefined) return undefined;
    const mine = inodeOfLink(await deps.readlink(`/proc/self/fd/${fd}`));
    if (mine === undefined) return undefined;
    const rows = parseSsUnix(await deps.listUnixSockets());
    // A client chooses its own socket address, which ss prints unescaped, so
    // text can carry forged rows: an inode seen in more than one row is refused.
    const ownRows = rows.filter((row) => row.localInode === mine);
    if (ownRows.length !== 1) return undefined;
    const own = ownRows[0] as SsUnixRow;
    if (own.peerInode === "0") return undefined;
    const peerRows = rows.filter((row) => row.localInode === own.peerInode);
    if (peerRows.length !== 1) return undefined;
    const pids = (peerRows[0] as SsUnixRow).pids;
    if (pids.length !== 1) return undefined;
    const pid = pids[0] as number;
    // The pid in the text is a claim; the kernel must confirm the process holds the peer inode.
    const want = `socket:[${own.peerInode}]`;
    let holds = false;
    for (const name of await deps.readdir(`/proc/${pid}/fd`)) {
      if (!/^\d+$/.test(name)) continue;
      const link = await deps.readlink(`/proc/${pid}/fd/${name}`).catch(() => undefined);
      if (link === want) {
        holds = true;
        break;
      }
    }
    if (!holds) return undefined;
    const exe = await deps.readlink(`/proc/${pid}/exe`);
    return exe.endsWith(" (deleted)") ? undefined : exe;
  } catch {
    return undefined;
  }
}

export function nodePeerDeps(): PeerDeps {
  return {
    fdOf(socket) {
      // libuv's pipe handle carries the fd on Unix; there is no public API for it.
      const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
      return typeof fd === "number" && Number.isInteger(fd) && fd >= 0 ? fd : undefined;
    },
    readlink: (path) => readlink(path),
    readdir: (path) => readdir(path),
    listUnixSockets: () =>
      new Promise((resolve, reject) => {
        execFile(
          SS_PATH,
          ["-x", "-p", "-H"],
          { timeout: SS_TIMEOUT_MS, maxBuffer: SS_MAX_BYTES, env: { LC_ALL: "C" } },
          (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
        );
      }),
  };
}

export type PeerCheck = { executableOf(socket: Socket): Promise<string | undefined> };

export function nodePeerCheck(): PeerCheck {
  const deps = nodePeerDeps();
  return { executableOf: (socket) => peerExecutable(socket, deps) };
}
