import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The app shipped broken once (889e2fa) because preload.cts value-imported
// from "./channels.js". This window is created with `sandbox: true` (see
// main.ts), and a sandboxed preload's `require` is restricted to Electron's
// own built-ins — exactly `electron`, `events`, `timers`, `url` (no
// `node:` prefix) — it can never reach a local file or an npm package. A
// value import of anything outside that list compiles fine (tsc has no idea
// the preload will run sandboxed) but throws at launch: "module not found",
// then `window.jarvis` is undefined and every renderer call dies with
// "Cannot read properties of undefined". `import type` erases to nothing at
// build time, so it's the only safe way for preload.cts to reference
// another local module's shapes.
//
// The sandbox rule is a positive list (only those four names survive), so
// this guard is one too: every non-type import/export/require is an
// offender unless its specifier is exactly one of them. It used to be a
// denylist keyed on relative-path specifiers (`./x`, `../x`), which missed
// `node:fs`, a bare `path`, or any npm package — the same bug class the
// branch shipped with, just one door over.
//
// This is a regex guard, not an AST one, despite that being the more robust
// choice: this workspace pins `typescript@7`, the native ("typescript-go")
// preview package, whose npm entry point exports only a version string to
// Node — nothing that parses a single file synchronously, so the regex
// stays. It spans newlines (no `\n` exclusion) so a Biome-wrapped multi-line
// import is still caught up to the next `;`, which Biome always inserts. A
// `;` inside a string or template literal ends that scan early too, but no
// real specifier or statement shape here puts one there, so it's harmless.
function findSandboxViolations(code: string): string[] {
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // Every import/export/require statement's specifier, whatever it names,
  // spanning newlines so a wrapped multi-line statement is still caught.
  // Capturing the keyword lets us tell a value reference apart from an
  // `import type` / `export type` one, which erases at build time.
  const ALLOWED_SPECIFIERS = new Set(["electron", "events", "timers", "url"]);
  const importOrRequire =
    /\b(import type|import|export type|export|require)\b[^;]*?["'`]([^"'`]+)["'`]/g;

  const offenders: string[] = [];
  for (const match of stripped.matchAll(importOrRequire)) {
    const [statement, keyword, specifier] = match;
    if (statement === undefined || specifier === undefined) continue;
    if (keyword === "import type" || keyword === "export type") continue;
    if (ALLOWED_SPECIFIERS.has(specifier)) continue;
    offenders.push(statement.trim());
  }
  return offenders;
}

describe("findSandboxViolations", () => {
  it.each([
    ["a single-line value import", 'import { A } from "./channels.js";'],
    ["a multi-line value import", 'import {\n  A,\n} from "./channels.js";'],
    ["a partially type-only import", 'import { type A, B } from "./x";'],
    ["a barrel re-export", 'export * from "./x";'],
    ["a single-line require", "const y = require('../y');"],
    ["a multi-line require", 'const y = require(\n  "./y"\n);'],
    ["a dynamic import", 'const y = import("./y");'],
    ["a side-effect import", 'import "./x";'],
    ["a node:-prefixed built-in", 'import { readFileSync } from "node:fs";'],
    ["a bare-specifier require", 'const p = require("path");'],
    ["an npm package import", 'import { z } from "zod";'],
  ])("flags %s", (_description, snippet) => {
    expect(findSandboxViolations(snippet)).not.toEqual([]);
  });

  it.each([
    ["a type-only import", 'import type { A } from "./x";'],
    ["a multi-line type-only import", 'import type {\n  A,\n} from "./x";'],
    ["a built-in require", 'const electron = require("electron");'],
    ["a sandboxed built-in import", 'import { EventEmitter } from "events";'],
    ["a destructured built-in require", 'const { app } = require("electron");'],
  ])("does not flag %s", (_description, snippet) => {
    expect(findSandboxViolations(snippet)).toEqual([]);
  });
});

describe("preload's sandboxed require", () => {
  it("never imports a local module except as a type", () => {
    const preload = readFileSync(new URL("./preload.cts", import.meta.url), "utf8");
    expect(findSandboxViolations(preload)).toEqual([]);
  });
});
