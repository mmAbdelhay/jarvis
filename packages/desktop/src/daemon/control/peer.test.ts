import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { inodeOfLink, parseSsUnix, type PeerDeps, peerExecutable } from "./peer.js";

// `ss -x -p -H` lines: Netid State Recv-Q Send-Q Local Port Peer Port Process.
const SS = [
  'u_str ESTAB 0 0 /home/jarvis/.config/jarvis/run/jarvisd.sock 51000 * 51001 users:(("node",pid=900,fd=21))',
  'u_str ESTAB 0 0 * 51001 * 51000 users:(("jarvis-lock",pid=1234,fd=7))',
  'u_str ESTAB 0 0 /home/jarvis/.config/jarvis/run/jarvisd.sock 52000 * 52001 users:(("node",pid=900,fd=22))',
  'u_str ESTAB 0 0 * 52001 * 52000 users:(("sh",pid=77,fd=3),("sh",pid=78,fd=3))',
  "u_str ESTAB 0 0 /run/user/1000/bus 60000 * 60001",
].join("\n");

function deps(over: Partial<PeerDeps> & { links?: Record<string, string> } = {}): PeerDeps {
  const links: Record<string, string> = {
    "/proc/self/fd/21": "socket:[51000]",
    "/proc/self/fd/22": "socket:[52000]",
    "/proc/1234/exe": "/usr/bin/jarvis-lock",
    ...over.links,
  };
  return {
    fdOf: over.fdOf ?? (() => 21),
    readlink:
      over.readlink ??
      (async (path) => {
        const target = links[path];
        if (target === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return target;
      }),
    listUnixSockets: over.listUnixSockets ?? (async () => SS),
  };
}
const socket = {} as Socket;

describe("parseSsUnix", () => {
  it("reads local inode, peer inode and owning pids, paths and all", () => {
    expect(parseSsUnix(SS)).toEqual([
      { localInode: "51000", peerInode: "51001", pids: [900] },
      { localInode: "51001", peerInode: "51000", pids: [1234] },
      { localInode: "52000", peerInode: "52001", pids: [900] },
      { localInode: "52001", peerInode: "52000", pids: [77, 78] },
      { localInode: "60000", peerInode: "60001", pids: [] },
    ]);
    expect(parseSsUnix("garbage\n\n")).toEqual([]);
  });
  it("reads a socket link", () => {
    expect(inodeOfLink("socket:[51000]")).toBe("51000");
    expect(inodeOfLink("/dev/null")).toBeUndefined();
  });
});

describe("peerExecutable", () => {
  it("names the peer's executable", async () => {
    await expect(peerExecutable(socket, deps())).resolves.toBe("/usr/bin/jarvis-lock");
  });
  it("refuses a peer socket shared by several processes", async () => {
    await expect(peerExecutable(socket, deps({ fdOf: () => 22 }))).resolves.toBeUndefined();
  });
  it("refuses a deleted executable", async () => {
    await expect(
      peerExecutable(
        socket,
        deps({ links: { "/proc/1234/exe": "/usr/bin/jarvis-lock (deleted)" } }),
      ),
    ).resolves.toBeUndefined();
  });
  it("answers undefined with no fd, no row or a failing ss", async () => {
    await expect(peerExecutable(socket, deps({ fdOf: () => undefined }))).resolves.toBeUndefined();
    await expect(peerExecutable(socket, deps({ fdOf: () => 99 }))).resolves.toBeUndefined();
    await expect(
      peerExecutable(
        socket,
        deps({
          listUnixSockets: async () => {
            throw new Error("ss missing");
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
