// Copies the vendored browser libraries into the compiled output.
//
// The renderer's modules are emitted to `dist/renderer/`, but their source
// lives in `renderer/`, so a relative import that is correct in one tree is
// wrong in the other — the exact mismatch that silently killed the renderer
// three times during phase 1 (a `dist/renderer/app.js` importing a path that
// only existed beside the source). Rather than reasoning about `../..`
// hops, the vendor directory is placed at the same relative position in
// both trees, so `./vendor/xterm.mjs` resolves in each.
//
// These are pinned copies of the installed @xterm packages, checked in so
// the app has no runtime dependency on node_modules' layout and satisfies
// its own `script-src 'self'` CSP, which no CDN or bare specifier could.
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "renderer", "vendor");
const to = join(here, "..", "dist", "renderer", "vendor");

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });

// The app icon, resolved from dist/src/main.js as ../../assets — so it has
// to exist beside the compiled output as well as beside the source.
const assetsFrom = join(here, "..", "assets");
const assetsTo = join(here, "..", "dist", "assets");
await mkdir(assetsTo, { recursive: true });
await cp(assetsFrom, assetsTo, { recursive: true });
