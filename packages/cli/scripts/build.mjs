// `pnpm --filter @jarvis/cli build` → dist-cli/{jarvis.mjs, jarvis.mjs.map, jarvis}.
// Plan L packages them as jarvis-cli: /usr/lib/jarvis/cli/jarvis.mjs and /usr/bin/jarvis.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundleCli, LAUNCHER } from "./bundle.mjs";

const out = new URL("../dist-cli/", import.meta.url);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await bundleCli(fileURLToPath(new URL("jarvis.mjs", out)));
await writeFile(new URL("jarvis", out), LAUNCHER, { mode: 0o755 });
