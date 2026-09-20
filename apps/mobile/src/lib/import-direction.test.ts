// Final review M4: apps/mobile imports from workspace packages only
// `@jarvis/wire` (values and types) and, type-only, `@jarvis/core`
// (global-constraints.md). Everything else — `@jarvis/remote`,
// `@jarvis/desktop`, `@jarvis/platform`, or a value import of `@jarvis/core`
// — must never be reachable from app code. This was previously verified
// only by manual grep at review time; this scan makes it a gate, in the
// same style as no-node-imports.test.ts.
//
// The two stated exceptions (scripts/*.mjs reading packages/desktop/renderer
// directly, and terminal-html.test.ts doing the same to prove the generated
// HTML is current) are outside this scan's scope: scripts/ isn't under
// app/ or src/, and *.test.ts files are excluded below, exactly as
// no-node-imports.test.ts excludes them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(HERE, "..", "..");

// Matches one import statement's `@jarvis/<pkg>` specifier, capturing
// whether the statement opens with `import type` and which package it
// names. `[^;]*?` (not `[\s\S]*?`) keeps the lazy match from crossing a
// statement boundary into a later, unrelated import — it can include
// newlines (a multi-line `{ ... }` clause) but never a semicolon, so it
// can't walk past the end of the statement it started in.
const JARVIS_IMPORT_PATTERN = /\bimport\s+(type\s+)?[^;]*?from\s*["']@jarvis\/([a-z]+)["']/g;
// A dynamic `import("@jarvis/x")` or `require("@jarvis/x")` — always a
// value-position use, so it's never a valid way to reach `@jarvis/core`
// type-only, and never a valid way to reach any package but `wire`.
const JARVIS_DYNAMIC_PATTERN = /\b(?:import|require)\(\s*["']@jarvis\/([a-z]+)["']\s*\)/g;

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      files.push(full);
    }
  }
  return files;
}

/** Every `@jarvis/*` reference in `text` that violates the import-direction
 * rule: any package other than `wire`, or a non-type-only reach into
 * `core`. Returns human-readable offense strings, not just booleans, so a
 * failing assertion names the exact statement. */
function findOffenses(text: string): string[] {
  const offenses: string[] = [];

  for (const match of text.matchAll(JARVIS_IMPORT_PATTERN)) {
    const [statement, typeKeyword, pkg] = match;
    if (pkg === "wire") continue;
    if (pkg === "core" && typeKeyword) continue;
    offenses.push(statement.trim());
  }
  for (const match of text.matchAll(JARVIS_DYNAMIC_PATTERN)) {
    const [statement, pkg] = match;
    if (pkg === "wire") continue;
    offenses.push(statement.trim());
  }
  return offenses;
}

describe("import direction: apps/mobile -> @jarvis/* (final review M4)", () => {
  it("app/ and src/ import only @jarvis/wire (any) and @jarvis/core (type-only), outside *.test.ts", () => {
    const targets = [join(MOBILE_ROOT, "app"), join(MOBILE_ROOT, "src")];
    const offenders: string[] = [];

    for (const dir of targets) {
      for (const file of collectSourceFiles(dir)) {
        const text = readFileSync(file, "utf8");
        for (const offense of findOffenses(text)) {
          offenders.push(`${file}: ${offense}`);
        }
      }
    }

    expect(
      offenders,
      `import-direction violation (only @jarvis/wire and type-only @jarvis/core are allowed): ${offenders.join("; ")}`,
    ).toEqual([]);
  });

  it(
    "the pattern allows @jarvis/wire and type-only @jarvis/core " +
      '[bite-proof: require typeKeyword for "wire" too and this fails]',
    () => {
      expect(findOffenses('import { isSubscriptionKey } from "@jarvis/wire";')).toEqual([]);
      expect(findOffenses('import type { PairingLink } from "@jarvis/wire";')).toEqual([]);
      expect(findOffenses('import type { SessionState } from "@jarvis/core";')).toEqual([]);
    },
  );

  it(
    "the pattern rejects a value import of @jarvis/core " +
      '[bite-proof: drop the `pkg === "core" && typeKeyword` check and this fails]',
    () => {
      expect(findOffenses('import { something } from "@jarvis/core";')).toHaveLength(1);
    },
  );

  it(
    "the pattern rejects any import of @jarvis/remote, @jarvis/desktop or @jarvis/platform " +
      '[bite-proof: drop the `pkg === "wire"` check and this fails]',
    () => {
      expect(findOffenses('import { x } from "@jarvis/remote";')).toHaveLength(1);
      expect(findOffenses('import type { X } from "@jarvis/desktop";')).toHaveLength(1);
      expect(findOffenses('import { y } from "@jarvis/platform";')).toHaveLength(1);
    },
  );

  it(
    "the pattern also catches a dynamic import and a require of a disallowed package " +
      "[bite-proof: remove the JARVIS_DYNAMIC_PATTERN scan and both of these fail]",
    () => {
      expect(findOffenses('const m = await import("@jarvis/core");')).toHaveLength(1);
      expect(findOffenses('const m = require("@jarvis/desktop");')).toHaveLength(1);
      expect(findOffenses('const m = require("@jarvis/wire");')).toEqual([]);
    },
  );

  it("a multi-line import statement is matched as one statement, not spilled into the next", () => {
    const text = [
      "import {",
      "  isSubscriptionKey,",
      '} from "@jarvis/wire";',
      'import type { SessionState } from "@jarvis/core";',
    ].join("\n");
    expect(findOffenses(text)).toEqual([]);
  });
});
