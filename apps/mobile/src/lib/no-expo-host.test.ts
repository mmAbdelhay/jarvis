// task-5-brief.md, rule 11 / global-constraints.md: `exp.host` appears in
// exactly one source file in this whole repo, `packages/remote/src/push.ts`
// (guarded by that package's own test, Task 2) — `apps/mobile` must never
// contain it, and must never import `expo-server-sdk` (a Node-only package
// that has no business on the phone). This scan also proves
// `expo-notifications` itself is referenced from exactly one file,
// `native-notifications.ts` — the only place a native module for it is
// ever loaded.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(HERE, "..", "..");

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

// This file's own header comment above necessarily names both forbidden
// strings in prose to explain what it's guarding against — excluded from
// its own scan so it isn't a false positive against itself.
const SELF = fileURLToPath(import.meta.url);

function scan(): { file: string; text: string }[] {
  const targets = [join(MOBILE_ROOT, "app"), join(MOBILE_ROOT, "src")];
  const results: { file: string; text: string }[] = [];
  for (const dir of targets) {
    for (const file of collectSourceFiles(dir)) {
      if (file === SELF) continue;
      results.push({ file, text: readFileSync(file, "utf8") });
    }
  }
  return results;
}

describe("apps/mobile carries no exp.host and no expo-server-sdk (rule 11)", () => {
  it("no file under app/ or src/ contains 'exp.host'", () => {
    const offenders = scan()
      .filter(({ text }) => text.includes("exp.host"))
      .map(({ file }) => file);

    expect(offenders, `'exp.host' found in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no file under app/ or src/ references 'expo-server-sdk'", () => {
    const offenders = scan()
      .filter(({ text }) => text.includes("expo-server-sdk"))
      .map(({ file }) => file);

    expect(offenders, `'expo-server-sdk' found in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the native 'expo-notifications' module is loaded only from native-notifications.ts", () => {
    // A literal import/require of the module specifier, not any mention of
    // the package name in a comment or docstring elsewhere (several files
    // legitimately explain their relationship to it in prose).
    const NATIVE_MODULE_PATTERN =
      /\bfrom\s+["']expo-notifications["']|\brequire\(\s*["']expo-notifications["']\s*\)/;
    const offenders = scan()
      .filter(
        ({ file, text }) =>
          NATIVE_MODULE_PATTERN.test(text) &&
          !file.endsWith("native-notifications.ts") &&
          !file.endsWith("native-notifications.test.ts"),
      )
      .map(({ file }) => file);

    expect(
      offenders,
      `'expo-notifications' loaded outside native-notifications.ts: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
