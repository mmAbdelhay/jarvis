import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodePeerCheck, SS_PATH } from "./peer.js";

// Real kernel answers: Linux with iproute2 only (CI). The dev Mac has neither.
describe.runIf(process.platform === "linux" && existsSync(SS_PATH))(
  "nodePeerCheck on Linux",
  () => {
    it("names the process on the other end of a Unix socket", async () => {
      const dir = await mkdtemp(join("/tmp", "peer-"));
      const path = join(dir, "s.sock");
      const accepted = new Promise<Socket>((resolve) => {
        const server = createServer(resolve);
        server.listen(path);
      });
      const child = spawn(process.execPath, [
        "-e",
        `require("node:net").connect(${JSON.stringify(path)}); setTimeout(() => {}, 10000);`,
      ]);
      try {
        const socket = await accepted;
        await expect(nodePeerCheck().executableOf(socket)).resolves.toBe(
          realpathSync(process.execPath),
        );
        socket.destroy();
      } finally {
        child.kill();
        await rm(dir, { recursive: true, force: true });
      }
    });
  },
);
