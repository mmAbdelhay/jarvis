// Copies the browser client's static export into the desktop package.
//
// `pnpm build` runs apps/mobile's `export:web` just before this (after
// `tsc -b`, which is what builds packages/wire/dist — the export cannot
// resolve @jarvis/wire without it). The result lands in apps/mobile/dist-web,
// outside this package, and electron-builder can only ship what sits beside
// electron-builder.yml. So it is copied to packages/desktop/web, which
// `extraResources` puts at <resources>/web in the packaged app, and which
// main.ts reads directly in development — the same bytes either way.
//
// The old copy is removed first: the export's file names carry content
// hashes, so copying over it would leave every previous build's bundle in
// the directory and in the manifest the web listener serves.
import { cp, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "..", "..", "apps", "mobile", "dist-web");
const to = join(here, "..", "web");

// A missing index.html means the export did not run or failed half-way; the
// app would read that as "not built", which is far harder to notice here.
await stat(join(from, "index.html"));
await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });
console.log("copy-web: apps/mobile/dist-web -> packages/desktop/web");
