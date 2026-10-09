// One ES module with every JS dependency inside, like jarvisd's bundle (M1
// contracts §6 #16): runs from /usr/lib/jarvis/cli/ with the bundled Node.
// @jarvis/wire is taken from source, so no prior tsc build is needed.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pkg = new URL("..", import.meta.url);

export const LAUNCHER =
  '#!/bin/sh\nexec /usr/lib/jarvis/node/bin/node /usr/lib/jarvis/cli/jarvis.mjs "$@"\n';

const wireFromSource = {
  name: "wire-from-source",
  setup(b) {
    b.onResolve({ filter: /^@jarvis\/wire$/ }, () => ({
      path: fileURLToPath(new URL("../wire/src/index.ts", pkg)),
    }));
  },
};

export async function bundleCli(outfile) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("src/bin.ts", pkg))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: "linked",
    legalComments: "eof",
    metafile: true,
    logLevel: "warning",
    plugins: [wireFromSource],
  });
  return result.metafile;
}
