import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

// Only these may read process.platform. Everything else receives the platform
// as a parameter.
//
// This is not tidiness. There is no CI and one laptop, so a function that
// reads process.platform at the point of use can only ever be tested on the
// OS the test happens to run on — and the whole Linux port would then be
// asserted by nothing. Parametrised, one `pnpm test` proves both.
//
// main.ts and preload.cts are the impure edges: they read it once and pass it
// down. pty.ts reads it inside ensureSpawnHelperExecutable, which is resolving
// a path in the running process's own node_modules and has nothing to hand it
// in from.
const ALLOWED = new Set(["main.ts", "preload.cts", "pty.ts"]);

const ROOTS = [
  "packages/core/src",
  "packages/platform/src",
  "packages/desktop/src",
  "packages/desktop/renderer",
];

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Vendored browser libraries and test fixtures are not ours to hold to
      // this rule.
      if (entry.name === "vendor" || entry.name === "__fixtures__") continue;
      found.push(...(await sourceFiles(path)));
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".cts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    found.push(path);
  }
  return found;
}

describe("the platform-parameter convention", () => {
  it("is read only at the impure edges", async () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const path of await sourceFiles(root)) {
        // basename, not a split on "/": join() builds these with the
        // platform's own separator, so on Windows the slice returns the whole
        // backslash path and every allowed file reads as an offender.
        const name = basename(path);
        if (ALLOWED.has(name)) continue;
        const source = await readFile(path, "utf8");
        // Comments are stripped first: this codebase discusses platforms
        // constantly in prose, and a rule that fires on a comment is a rule
        // people learn to route around.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        if (/process\.platform/.test(code)) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
