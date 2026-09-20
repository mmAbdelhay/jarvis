// This test exists because a green `pnpm test` + a clean `pnpm typecheck`
// has three times now shipped a renderer whose *emitted* module graph does
// not actually resolve — src/ and renderer/ are independent tsc projects
// with independent outDirs, so tsc happily emits a relative specifier that
// was correct in source (`../src/messages.js`) but is wrong once each file
// lands in its own project's dist/ tree. Neither `tsc` (it doesn't follow
// cross-project relative specifiers) nor a source-level vitest run (it
// never touches dist/ at all) can catch that class of bug. This test reads
// the *built* dist/**/*.js files, extracts every relative import
// specifier, and asserts each one resolves to a real file on disk under
// Node's own ESM resolution rules (explicit extension required, no
// extensionless/index fallback) — the same rules Node and Chromium's
// `file://` module loader apply when the app actually runs.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(desktopDir, "dist");

function listJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listJsFiles(full));
    } else if (entry.endsWith(".js") && !entry.endsWith(".test.js")) {
      // Emitted test files are excluded: they're never part of the shipped
      // module graph (nothing requires/imports them at runtime), and they
      // may carry illustrative specifiers in strings or comments — this
      // file's own regex docs above, and preload-sandbox.test's
      // string-literal guard cases (`'import { A } from "./x";'`) — that
      // the naive regex below would otherwise mistake for real imports.
      out.push(full);
    }
  }
  return out;
}

// Matches the specifier in `from "..."`, `import "..."`, and
// `import("...")`, for relative specifiers only (starting with `.`) — bare
// specifiers (`electron`, `@jarvis/core`) are resolved by Node/bundler
// module resolution, not filesystem-relative, and are out of scope here.
const RELATIVE_IMPORT_RE = /(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g;

function extractRelativeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe("dist emit module resolution", () => {
  if (!existsSync(distDir)) {
    it.skip("skipped: packages/desktop/dist has not been built (run `pnpm --filter @jarvis/desktop run build`)", () => {});
    return;
  }

  const jsFiles = listJsFiles(distDir);
  // A build that produced zero .js files is itself a sign something is
  // wrong with the outDir wiring — fail loudly rather than vacuously
  // passing an empty describe block.
  it("found built .js files under dist/", () => {
    expect(jsFiles.length).toBeGreaterThan(0);
  });

  for (const file of jsFiles) {
    const relFile = file.slice(desktopDir.length + 1);
    it(`every relative import in ${relFile} resolves to a real file`, () => {
      const source = readFileSync(file, "utf8");
      const specifiers = extractRelativeSpecifiers(source);
      for (const specifier of specifiers) {
        // Node's real ESM resolver requires the extension exactly as
        // written — no extensionless/index fallback — which is exactly
        // what tripped up `../src/messages.js` resolving from
        // dist/renderer/app.js when it didn't actually exist there.
        const target = resolve(dirname(file), specifier);
        expect(
          existsSync(target),
          `${relFile} imports "${specifier}" -> ${target.slice(desktopDir.length + 1)}, which does not exist`,
        ).toBe(true);
      }
    });
  }
});
