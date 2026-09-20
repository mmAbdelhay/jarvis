// Bite-proof (task-6-brief.md, Tests): greps every `app/` and
// `src/components/` source file for a hard-coded left/right style, which
// global-constraints.md forbids — layout direction must follow `start`/
// `end` so it flips correctly under RTL (ruling 6). Naming the offending
// file(s) in the failure message is the point: add `marginLeft` to a
// component and this test fails, pointing straight at it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(HERE, "../..");

const FORBIDDEN_PATTERN =
  /marginLeft|marginRight|paddingLeft|paddingRight|left:|right:|textAlign:\s*["'](?:left|right)["']/;

/**
 * Strips comments before matching, so a file that merely *mentions*
 * `left:`/`right:` in a code comment (e.g. this file's own docstrings, or
 * one describing why a style avoids them) never counts as an offender. A
 * `//` immediately after a `:` (as in `jarvis://...`) is left alone — it is
 * almost certainly inside a string literal, not the start of a comment.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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

describe("no hard-coded left/right styles (ruling 6)", () => {
  it("app/ and src/components/ never use marginLeft/Right, paddingLeft/Right or left:/right:", () => {
    const targets = [join(MOBILE_ROOT, "app"), join(MOBILE_ROOT, "src", "components")];
    const offenders: string[] = [];

    for (const dir of targets) {
      for (const file of collectSourceFiles(dir)) {
        const text = stripComments(readFileSync(file, "utf8"));
        if (FORBIDDEN_PATTERN.test(text)) {
          offenders.push(file);
        }
      }
    }

    expect(offenders, `hard-coded left/right style found in: ${offenders.join(", ")}`).toEqual([]);
  });

  it(
    "the pattern itself catches textAlign: 'left'/'right' and left:/right: with or " +
      "without a space, and ignores a comment merely mentioning them " +
      "[bite-proof for T6 M6: revert to the narrower pattern and the first two cases stop matching]",
    () => {
      expect(FORBIDDEN_PATTERN.test('textAlign: "left"')).toBe(true);
      expect(FORBIDDEN_PATTERN.test("textAlign: 'right'")).toBe(true);
      expect(FORBIDDEN_PATTERN.test("left: 0")).toBe(true);
      expect(FORBIDDEN_PATTERN.test("left:0")).toBe(true);
      expect(
        stripComments("// this component intentionally avoids left:/right: styles\nconst x = 1;"),
      ).not.toMatch(FORBIDDEN_PATTERN);
      expect(stripComments('const url = "jarvis://pair?x=1";')).toContain("jarvis://pair");
    },
  );
});
