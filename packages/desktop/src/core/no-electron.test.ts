import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, type PlatformPath, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The core runs in two hosts (Phase 2): in-process inside Electron main, and
// as `jarvisd` under plain Node, where `import "electron"` resolves to the
// npm package's path string or fails outright. So nothing the core loads may
// load electron — not the files under src/core/, not the daemon's own entry
// files, and not any local file either of them reaches. Electron-bound
// pieces (window, menus, notifications, WebContentsView) are handed in as
// injected deps from main.ts instead.
//
// "Loads" is the rule, so the walk follows value imports only: an
// `import type {…}` clause is erased from the compiled output and carries
// nothing to runtime (browser-host.ts, home of the hosted-view types, only
// type-imports electron's Session). The same reasoning as
// packages/remote's index.ts reachability test.
const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every non-test .ts file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

/**
 * The walk's entry points: everything under src/core/ and src/daemon/, and
 * any `src/daemon-*.ts` entry file (the daemon's main lands there later —
 * matched now so it is covered the day it exists).
 */
function entryFiles(): string[] {
  const daemonEntries = readdirSync(SRC)
    .filter((name) => /^daemon-.*\.ts$/.test(name) && !name.endsWith(".test.ts"))
    .map((name) => resolve(SRC, name));
  return [
    ...sourceFiles(resolve(SRC, "core")),
    ...sourceFiles(resolve(SRC, "daemon")),
    ...daemonEntries,
  ];
}

/**
 * Every module specifier a source *value*-imports: a from-clause not led by
 * `type`, a side-effect `import "…"`, a dynamic `import("…")`, or a
 * `require("…")`. Comments are stripped first, so prose that shows import
 * syntax never counts. `import { type A } from "…"` is a value import here
 * — conservative, since whether it survives compilation depends on flags.
 */
function valueSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found: string[] = [];
  for (const match of code.matchAll(/\b(?:import|export)\b([^;]*?)\bfrom\s+(["`])([^"`]*)\2/g)) {
    if (/^\s*type\b/.test(match[1] ?? "")) continue;
    found.push(match[3] ?? "");
  }
  for (const match of code.matchAll(/\bimport\s+(["`])([^"`]*)\1/g)) found.push(match[2] ?? "");
  for (const match of code.matchAll(/\bimport\s*\(\s*(["`])([^"`]*)\1\s*\)/g)) {
    found.push(match[2] ?? "");
  }
  for (const match of code.matchAll(/\brequire\(\s*(["`])([^"`]*)\1\s*\)/g)) {
    found.push(match[2] ?? "");
  }
  return found;
}

function isElectron(specifier: string): boolean {
  return specifier === "electron" || specifier.startsWith("electron/");
}

/**
 * Every (file, specifier) pair, reachable from `entries` through relative
 * value imports, that loads electron. `read` answers a file's source, or
 * undefined when there is no such file. `paths` resolves the relative
 * specifiers: the host's own for the real tree, posix or win32 for fixtures,
 * so a fixture reads the same on every OS.
 */
function electronImports(
  entries: readonly string[],
  read: (path: string) => string | undefined,
  paths: Pick<PlatformPath, "dirname" | "resolve">,
): { file: string; specifier: string }[] {
  const violations: { file: string; specifier: string }[] = [];
  const visited = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const source = read(file);
    if (source === undefined) continue;
    for (const specifier of valueSpecifiers(source)) {
      if (isElectron(specifier)) violations.push({ file, specifier });
      if (!specifier.startsWith(".")) continue;
      queue.push(paths.resolve(paths.dirname(file), specifier).replace(/\.js$/, ".ts"));
    }
  }
  return violations;
}

/** The host's own path rules, for walking the real source tree. */
const NATIVE = { dirname, resolve };

function readSource(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

describe("valueSpecifiers", () => {
  it("finds static, side-effect, re-export, dynamic and require forms", () => {
    const source = [
      'import { app } from "electron";',
      'import "electron";',
      'export { shell } from "electron";',
      'const m = await import("electron");',
      'const r = require("electron");',
    ].join("\n");
    expect(valueSpecifiers(source)).toEqual([
      "electron",
      "electron",
      "electron",
      "electron",
      "electron",
    ]);
  });

  it("skips type-only clauses and comments", () => {
    const source = [
      'import type { Session } from "electron";',
      'export type { BrowserWindow } from "electron";',
      '// import { app } from "electron";',
      '/* require("electron") */',
    ].join("\n");
    expect(valueSpecifiers(source)).toEqual([]);
  });

  it('does not read Buffer.from("…") as a from-clause', () => {
    expect(valueSpecifiers('const b = Buffer.from("electron");')).toEqual([]);
  });
});

describe("electronImports", () => {
  it("follows relative value imports to a file that loads electron", () => {
    const files: Record<string, string> = {
      "/src/core/a.ts": 'import { b } from "../b.js";',
      "/src/b.ts": 'import { c } from "./c.js";',
      "/src/c.ts": 'import { Menu } from "electron";',
    };
    expect(electronImports(["/src/core/a.ts"], (path) => files[path], posix)).toEqual([
      { file: "/src/c.ts", specifier: "electron" },
    ]);
  });

  it("resolves Windows paths with Windows rules", () => {
    const files: Record<string, string> = {
      "C:\\src\\core\\a.ts": 'import { b } from "../b.js";',
      "C:\\src\\b.ts": 'import { c } from "./c.js";',
      "C:\\src\\c.ts": 'import { Menu } from "electron";',
    };
    expect(electronImports(["C:\\src\\core\\a.ts"], (path) => files[path], win32)).toEqual([
      { file: "C:\\src\\c.ts", specifier: "electron" },
    ]);
  });

  it("does not follow a type-only import", () => {
    const files: Record<string, string> = {
      "/src/core/a.ts": 'import type { B } from "../b.js";',
      "/src/b.ts": 'import { Menu } from "electron";',
    };
    expect(electronImports(["/src/core/a.ts"], (path) => files[path], posix)).toEqual([]);
  });

  it("catches electron subpaths", () => {
    const files: Record<string, string> = { "/src/core/a.ts": 'import x from "electron/main";' };
    expect(electronImports(["/src/core/a.ts"], (path) => files[path], posix)).toEqual([
      { file: "/src/core/a.ts", specifier: "electron/main" },
    ]);
  });
});

describe("the core never loads electron", () => {
  it("would catch main.ts, which is Electron's side of the seam", () => {
    expect(electronImports([resolve(SRC, "main.ts")], readSource, NATIVE)).not.toEqual([]);
  });

  it("walks the core's composition root", () => {
    expect(entryFiles()).toContain(resolve(SRC, "core/compose.ts"));
  });

  // Task 18: the Workspace's tab state is the core's; only its pages are
  // Electron's. TabHost must be walked, and the view factory the Electron
  // host follows it with must be the kind of file the walk would flag.
  it("walks the core's tab state, and would catch the Electron view factory", () => {
    expect(entryFiles()).toContain(resolve(SRC, "core/tab-host.ts"));
    expect(electronImports([resolve(SRC, "electron-view.ts")], readSource, NATIVE)).not.toEqual([]);
  });

  it("finds no electron import under src/core/, src/daemon/ or daemon-*.ts, directly or transitively", () => {
    expect(electronImports(entryFiles(), readSource, NATIVE)).toEqual([]);
  });
});
