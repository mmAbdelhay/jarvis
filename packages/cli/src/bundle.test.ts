import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleCli } from "../scripts/bundle.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ALLOWED = ["packages/cli/src/", "packages/desktop/src/daemon/control/", "packages/wire/src/"];

describe("the jarvis bundle", () => {
  it("holds only the CLI, the control client and @jarvis/wire, and runs --help", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jcli-bundle-"));
    try {
      const outfile = join(dir, "jarvis.mjs");
      const meta = await bundleCli(outfile);
      const inputs = Object.keys(meta.inputs).map((input) =>
        relative(REPO, resolve(process.cwd(), input)).split("\\").join("/"),
      );
      expect(inputs.length).toBeGreaterThan(5);
      for (const input of inputs) {
        expect(
          ALLOWED.some((prefix) => input.startsWith(prefix)),
          input,
        ).toBe(true);
      }
      const run = spawnSync(process.execPath, [outfile, "--help"], { encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("jarvis memory clear [--yes]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
