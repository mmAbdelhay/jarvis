import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.each([undefined, "num_ctx 16384"])(
  "probes at jarvisd's context when model parameters are %s",
  async (parameters) => {
    const dir = mkdtempSync(join(tmpdir(), "vision-context-"));
    try {
      const out = join(dir, "evidence.json");
      const setup = join(dir, "setup.mjs");
      const config = join(dir, "vitest.config.mts");
      writeFileSync(setup, `
        const clicks = [{ x: 220, y: 150 }, { x: 1020, y: 630 }, { x: 1060, y: 170 }];
        globalThis.fetch = async (url, init) => {
          if (url.endsWith('/api/show')) return Response.json({
            capabilities: ['vision', 'tools'], parameters: ${JSON.stringify(parameters) ?? "undefined"}
          });
          const request = JSON.parse(init.body);
          if (request.options.num_ctx !== 8192) throw new Error('Probe context differs from jarvisd');
          return Response.json({ message: { tool_calls: [
            { function: { name: 'click', arguments: clicks.shift() } }
          ] } });
        };
      `);
      writeFileSync(config, `
        import config from ${JSON.stringify(resolve("os/models/probe/vitest.config.ts"))};
        export default { ...config, test: { ...config.test, setupFiles: [${JSON.stringify(setup)}] } };
      `);
      await promisify(execFile)("pnpm", ["exec", "vitest", "run", "--config", config,
        "os/models/probe/vision-probe.test.ts"], {
        timeout: 30_000,
        env: { ...process.env, VISION_MODEL_TAG: "fixture:vision", VISION_PROBE_OUT: out },
      });
      const evidence = JSON.parse(readFileSync(out, "utf8"));
      expect(evidence).toMatchObject({ status: "passed", contextSize: 8192 });
      expect(evidence.trials).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
