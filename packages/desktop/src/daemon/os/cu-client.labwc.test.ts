// packages/desktop/src/daemon/os/cu-client.labwc.test.ts
// Opt-in, Linux only: jarvisd's client against the REAL jarvis-cu (Plan U)
// under a headless labwc, started by packages/desktop/scripts/cu-headless-test.sh
// (on the owner's Linux box or in CI via Plan X). Skipped everywhere else.
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodePeerCheck } from "../control/peer.js";
import { CU_HELPER_PATH, connectUnix, createCuClient, cuSocketPath } from "./cu-client.js";

const RUN = process.platform === "linux" && process.env["JARVIS_CU_LABWC"] === "1";
const timers = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe.runIf(RUN)("jarvis-cu under a headless labwc (contracts §1)", () => {
  it("lists windows, captures only the allowed one, refuses points outside it, and ends", async () => {
    const path = cuSocketPath(process.env);
    if (path === undefined) throw new Error("XDG_RUNTIME_DIR is not set");
    const expected = realpathSync(process.env["JARVIS_CU_BIN"] ?? CU_HELPER_PATH);
    const peer = nodePeerCheck();
    const client = createCuClient({
      connect: () => connectUnix(path),
      verifyPeer: async (socket) => (await peer.executableOf(socket)) === expected,
      timers,
      log: () => {},
    });
    try {
      const windows = await client.apps();
      const zenity = windows.find((w) => w.appId.toLowerCase().includes("zenity"));
      if (zenity === undefined)
        throw new Error(`no zenity window in ${JSON.stringify(windows.map((w) => w.appId))}`);
      await client.begin("labwc-test", [zenity.appId]);
      const capture = await client.capture(1280);
      expect(Math.max(capture.width, capture.height)).toBeLessThanOrEqual(1280);
      expect(Buffer.from(capture.pngBase64, "base64").subarray(0, 8)).toEqual(PNG_SIGNATURE);
      expect(capture.windows.filter((w) => w.allowed).map((w) => w.appId)).toEqual([zenity.appId]);
      const allowed = capture.windows.filter((w) => w.allowed);
      expect(allowed[0]).toMatchObject({ x: 0, y: 0, w: capture.width, h: capture.height });
      for (const window of capture.windows.filter((w) => !w.allowed)) {
        expect(window).toMatchObject({ title: "", x: 0, y: 0, w: 0, h: 0 });
      }
      await expect(client.describeAt(1, 1)).resolves.toHaveProperty("role");
      // The allowed window is fullscreen; only points beyond the capture are outside.
      await expect(
        client.click(capture.width, capture.height, "left", false),
      ).rejects.toMatchObject({ code: "outside" });
      await client.end();
      await expect(client.click(1, 1, "left", false)).rejects.toMatchObject({ code: "no-session" });
    } finally {
      client.close();
    }
  });
});
