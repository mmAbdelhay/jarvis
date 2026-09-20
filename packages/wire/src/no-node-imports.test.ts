// packages/wire must import nothing (global constraints: "packages/wire
// imports nothing from node:* and nothing from any other workspace
// package") — React Native has no Buffer and no node:* built-ins. This
// test reads every non-test source file here and fails, naming the file,
// on any import/require of node:*, a bare package, or @jarvis/*. Only the
// package's own runtime code is under this constraint; the test itself is
// free to use Node.

// This package's tsconfig sets `types: []` (no Node globals) so runtime
// code here can't accidentally reach for `Buffer`/`process`. This test's
// own job is reading files, which needs two `node:fs` functions — but
// `@types/node` is deliberately absent, and TypeScript refuses a fresh
// `declare module` for any Node builtin name (it only accepts an
// *augmentation* of `@types/node`'s own declaration, which does not exist
// in this package). Rather than pull in `@types/node` (which would
// reintroduce `Buffer`/`process` globally and quietly defeat that
// guarantee), the one import line that can't resolve is typed by hand: a
// suppressed import, narrowed immediately to exactly the two functions
// this file calls.
// @ts-expect-error -- no @types/node in this package; see the comment above.
import * as nodeFs from "node:fs";
// @ts-expect-error -- same reason as the node:fs import above.
import * as nodeUrl from "node:url";
import { describe, expect, it } from "vitest";

type FsShim = {
  readFileSync(path: string, encoding: string): string;
  readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
};
const { readFileSync, readdirSync } = nodeFs as unknown as FsShim;
const { fileURLToPath } = nodeUrl as unknown as { fileURLToPath(url: URL | string): string };

// `fileURLToPath` (not `.pathname`) turns this file's own URL into a real
// filesystem path — `.pathname` keeps the URL's leading "/" in front of a
// Windows drive letter ("/D:/a/…"), and readdirSync below then resolves
// that against the current drive, doubling it ("D:\D:\a\…") and failing
// with ENOENT. `fileURLToPath` strips it correctly on every platform, and
// (for a directory URL, which this is — the second arg to `new URL` is ".")
// keeps the trailing separator the join below relies on.
const ROOT = fileURLToPath(new URL(".", import.meta.url));

function nonTestSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...nonTestSourceFiles(`${path}/`));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

/** Every module specifier a file's source text references — a static from-clause, a side-effect import, a dynamic import call, or a require call. */
function specifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const matches = [
    ...code.matchAll(/(?<!\.)\bfrom\s+(["`])([^"`]*)\1/g),
    ...code.matchAll(/\bimport\s*\(?\s*(["`])([^"`]*)\1/g),
    ...code.matchAll(/\brequire\(\s*(["`])([^"`]*)\1\s*\)/g),
  ];
  return matches.map((match) => match[2] ?? "");
}

describe("@jarvis/wire imports nothing", () => {
  // Not vacuous: `nonTestSourceFiles(ROOT)` must actually find this
  // package's real source files, or the assertion below passes for the
  // wrong reason — an empty list is trivially "no violations". If `ROOT`
  // ever resolved to the wrong directory (or an empty one), this is what
  // would catch it before the main assertion silently stopped meaning
  // anything.
  it("finds this package's own source files, so the check below isn't vacuous", () => {
    // Split on either separator: this package deliberately has no node:*
    // types (its whole rule is "imports nothing"), so node:path's basename
    // is not available here, and a "/"-only split returns a win32 path
    // untouched.
    const files = nonTestSourceFiles(ROOT).map((path) => path.split(/[\\/]/).pop());
    expect(files).toContain("address.ts");
  });

  it("has no node:*, bare-package or @jarvis/* import in any non-test source file", () => {
    const violations: [string, string][] = [];
    for (const path of nonTestSourceFiles(ROOT)) {
      const source = readFileSync(path, "utf8");
      for (const specifier of specifiers(source)) {
        // A relative specifier (within this package) is the only thing
        // allowed; anything else — node:*, a bare package, @jarvis/* — is
        // a violation, named with the file it was found in.
        if (specifier.startsWith(".")) continue;
        violations.push([path, specifier]);
      }
    }
    expect(violations).toEqual([]);
  });
});
