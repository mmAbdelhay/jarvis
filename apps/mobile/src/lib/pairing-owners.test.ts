// The stored pairing has two owners: pairing-record.ts holds the functions and
// the legacy keys, machine-store.ts decides which machine's keys to use. Every
// other file goes through the machine store, so nothing can read one machine's
// keys while another is active. Scans as no-node-imports.test.ts does.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(HERE, "..", "..");

const OWNERS = new Set(["machine-store.ts", "pairing-record.ts"]);
// The one place the two key layouts meet: it takes the legacy keys from
// pairing-record.ts by name, and writes no literal.
const KEY_LAYOUT = "machine-index.ts";
// "jarvis.refresh" here names the keychain service and the database that hold
// the refresh tokens, not a key inside them. Stored tokens depend on it.
const STORE_NAMES = new Set(["refresh-store.ts", "refresh-store.web.ts"]);

const LEGACY_IMPORT_PATTERN =
  /\bimport\s*\{[^}]*\b(?:loadPairing|savePairing|clearPairing)\b[^}]*\}\s*from\s*["'][^"']*pairing-record["']/;
// Any other way to reach the module's values. A named import of its types and
// of the *At functions stays open: the keys those need are banned by name.
const WHOLE_MODULE_PATTERN =
  /\bimport\s*\*\s*as\s+\w+\s+from\s*["'][^"']*pairing-record["']|\bexport\s*(?:\*(?:\s*as\s+\w+)?|\{[^}]*\})\s*from\s*["'][^"']*pairing-record["']|\b(?:import|require)\(\s*["'][^"']*pairing-record["']\s*\)/;
const LEGACY_LITERAL_PATTERN = /["'`]jarvis\.(?:pairing|token|refresh)["'`]/;
const LEGACY_NAME_PATTERN =
  /\b(?:REFRESH_TOKEN_KEY|LEGACY_PAIRING_KEYS|LEGACY_REFRESH_KEY|createRefreshStoredFlag)\b/;

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function offenders(accepts: (name: string, text: string) => boolean): string[] {
  const found: string[] = [];
  for (const dir of [join(MOBILE_ROOT, "app"), join(MOBILE_ROOT, "src")]) {
    for (const file of collectSourceFiles(dir)) {
      const name = file.slice(dirname(file).length + 1);
      if (accepts(name, readFileSync(file, "utf8"))) found.push(file);
    }
  }
  return found;
}

describe("the stored pairing's owners", () => {
  it("no source file outside the two owners imports the legacy pairing functions", () => {
    expect(
      offenders((name, text) => !OWNERS.has(name) && LEGACY_IMPORT_PATTERN.test(text)),
    ).toEqual([]);
  });

  it("no source file outside the two owners reaches pairing-record as a whole", () => {
    expect(offenders((name, text) => !OWNERS.has(name) && WHOLE_MODULE_PATTERN.test(text))).toEqual(
      [],
    );
  });

  it("no source file outside the two owners writes a legacy key", () => {
    expect(
      offenders(
        (name, text) =>
          !OWNERS.has(name) && !STORE_NAMES.has(name) && LEGACY_LITERAL_PATTERN.test(text),
      ),
    ).toEqual([]);
  });

  it("no source file outside the owners and the key layout names a legacy key constant", () => {
    expect(
      offenders(
        (name, text) => !OWNERS.has(name) && name !== KEY_LAYOUT && LEGACY_NAME_PATTERN.test(text),
      ),
    ).toEqual([]);
  });

  it("the patterns themselves catch each form [bite-proof]", () => {
    expect(LEGACY_IMPORT_PATTERN.test('import { loadPairing } from "@/lib/pairing-record";')).toBe(
      true,
    );
    expect(
      LEGACY_IMPORT_PATTERN.test(
        'import {\n  clearPairing,\n  PairingAlreadyExistsError,\n} from "./pairing-record";',
      ),
    ).toBe(true);
    expect(
      LEGACY_IMPORT_PATTERN.test('import { PairingAlreadyExistsError } from "./pairing-record";'),
    ).toBe(false);
    expect(WHOLE_MODULE_PATTERN.test('import * as record from "./pairing-record";')).toBe(true);
    expect(WHOLE_MODULE_PATTERN.test('import type * as record from "./pairing-record";')).toBe(
      false,
    );
    expect(WHOLE_MODULE_PATTERN.test('export * from "./pairing-record";')).toBe(true);
    expect(WHOLE_MODULE_PATTERN.test('export * as record from "./pairing-record";')).toBe(true);
    expect(WHOLE_MODULE_PATTERN.test('export { loadPairing } from "./pairing-record";')).toBe(true);
    expect(
      WHOLE_MODULE_PATTERN.test('export type { PairingRecord } from "./pairing-record";'),
    ).toBe(false);
    expect(WHOLE_MODULE_PATTERN.test('await import("./pairing-record")')).toBe(true);
    expect(WHOLE_MODULE_PATTERN.test('require("@/lib/pairing-record")')).toBe(true);
    expect(LEGACY_NAME_PATTERN.test("createRefreshStoredFlag(store, tag)")).toBe(true);
    expect(LEGACY_LITERAL_PATTERN.test('store.get("jarvis.token")')).toBe(true);
    expect(LEGACY_LITERAL_PATTERN.test('store.get("jarvis.machines")')).toBe(false);
    expect(LEGACY_NAME_PATTERN.test("store.delete(REFRESH_TOKEN_KEY)")).toBe(true);
  });

  it("the scan reaches app/ and the browser build's siblings", () => {
    const scanned = offenders(() => true);
    expect(scanned).toContain(join(MOBILE_ROOT, "app", "pair.web.tsx"));
    expect(scanned).toContain(join(MOBILE_ROOT, "app", "sidecars", "[project].tsx"));
    expect(scanned).toContain(join(MOBILE_ROOT, "src", "lib", "connect-stored.ts"));
  });
});
