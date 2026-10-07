// `pnpm --filter @jarvis/desktop build:daemon` (contracts §4): jarvisd for
// Jarvis OS as one ES module with every JS dependency inside and no native
// module, so /usr/lib/jarvis/node/bin/node can run it from
// /usr/lib/jarvis/daemon/ with no node_modules. Bundled from tsc's output, so
// what ships is what was typechecked. src/daemon/os/os-bundle-graph.test.ts
// keeps the import graph free of node-pty, sqlite and the Agent SDK.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pkg = new URL("..", import.meta.url);
const out = new URL("dist-daemon/", pkg);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("dist/src/daemon/os/os-daemon-main.js", pkg))],
  outfile: fileURLToPath(new URL("jarvisd.mjs", out)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: "linked",
  // Inline, so dist-daemon holds exactly the four files of contracts §6 #16.
  legalComments: "eof",
  // A CommonJS dependency that calls require() inside an ES module bundle needs one.
  banner: {
    js: 'import { createRequire as __jarvisRequire } from "node:module"; const require = __jarvisRequire(import.meta.url);',
  },
  logLevel: "info",
});
// Contracts §6 #6: the bundle's stamp is {"build": string}, the exact string
// jarvisd compares in the handshake and the shell sends in its hello.
const { formatBuildId } = await import(new URL("dist/src/daemon/build-id.js", pkg).href);
const appStamp = JSON.parse(await readFile(new URL("dist/build-stamp.json", pkg), "utf8"));
await writeFile(
  new URL("build-stamp.json", out),
  `${JSON.stringify({ build: formatBuildId(appStamp) })}\n`,
);
const { buildOsDaemonUnit } = await import(new URL("dist/src/daemon/os/unit.js", pkg).href);
await writeFile(new URL("jarvisd.service", out), buildOsDaemonUnit());
