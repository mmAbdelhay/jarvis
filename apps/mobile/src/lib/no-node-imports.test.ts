// Fix round 1, M1: node-builtins.d.ts's shims (node:fs, node:path, node:url,
// node:crypto, node:module) exist only so test files can read real inputs
// at typecheck time — Metro never sees them, since Vitest runs directly
// under Node. But the shims typecheck the same way for *any* file, so a
// stray `import "node:fs"` in app code would pass `tsc` and then fail at
// runtime in Metro. This scans everything except `*.test.ts` for a
// `node:` import and fails, naming the file, if one turns up outside the
// test-only carve-out.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(HERE, "..", "..");

// Fix round 3, m-r1-3: the original pattern only caught
// `import { x } from "node:y"` and `require("node:y")`. It missed a
// side-effect import (`import "node:y";`, no `from`) and a dynamic
// import (`import("node:y")`) — both are valid ways to reach a node:
// builtin from app code and would have passed `tsc` (node-builtins.d.ts
// shims every node: specifier) and then failed at runtime in Metro.
const NODE_IMPORT_PATTERN =
  /\bfrom\s+["']node:[a-z/]+["']|\brequire\(\s*["']node:[a-z/]+["']\s*\)|\bimport\s+["']node:[a-z/]+["']|\bimport\(\s*["']node:[a-z/]+["']\s*\)/;

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

describe("no node: imports outside test files (M1)", () => {
  it("app/ and src/ never import a node: builtin, except in *.test.ts", () => {
    const targets = [join(MOBILE_ROOT, "app"), join(MOBILE_ROOT, "src")];
    const offenders: string[] = [];

    for (const dir of targets) {
      for (const file of collectSourceFiles(dir)) {
        const text = readFileSync(file, "utf8");
        if (NODE_IMPORT_PATTERN.test(text)) {
          offenders.push(file);
        }
      }
    }

    expect(
      offenders,
      `node: import found outside a *.test.ts file: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it(
    "the pattern itself catches a node: import " +
      '[bite-proof: import "node:fs" in non-test source and this test fails]',
    () => {
      expect(NODE_IMPORT_PATTERN.test('import { readFileSync } from "node:fs";')).toBe(true);
      expect(NODE_IMPORT_PATTERN.test('const fs = require("node:fs");')).toBe(true);
      expect(NODE_IMPORT_PATTERN.test('import { View } from "react-native";')).toBe(false);
    },
  );

  // Fix round 3, m-r1-3: the two forms the original pattern missed —
  // a side-effect import (no `from`) and a dynamic import.
  it(
    "also catches a side-effect import and a dynamic import " +
      "[bite-proof: revert to the pre-round-3 pattern and both of these fail]",
    () => {
      expect(NODE_IMPORT_PATTERN.test('import "node:fs";')).toBe(true);
      expect(NODE_IMPORT_PATTERN.test('const fs = await import("node:fs");')).toBe(true);
      expect(NODE_IMPORT_PATTERN.test('import "react-native";')).toBe(false);
    },
  );
});
