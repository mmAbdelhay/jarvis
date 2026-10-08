// Rafiq M4 contracts §4: the recipe files Plan T ships to
// /usr/share/jarvis/recipes/ (package jarvis-recipes), read as JSON for the
// recipe engine (core recipe-engine.ts parses them field by field).
//
// No electron here (core/no-electron.test.ts).
import { posix } from "node:path";

export const MAX_RECIPE_FILES = 100;
export const MAX_RECIPE_FILE_BYTES = 65_536;
const RECIPE_FILE = /^[a-z0-9][a-z0-9-]{0,31}\.json$/;
const OS_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function loadRecipeFiles(
  dir: string,
  io: { listDir(dir: string): Promise<string[]>; readFile(path: string): Promise<string> },
  log: (line: string) => void,
): Promise<unknown[]> {
  let names: string[];
  try {
    names = await io.listDir(dir);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      log(`[recipes] ${dir}: ${describe(error)}`);
    return [];
  }
  const loaded: unknown[] = [];
  for (const name of names
    .filter((n) => RECIPE_FILE.test(n))
    .sort()
    .slice(0, MAX_RECIPE_FILES)) {
    try {
      const text = await io.readFile(posix.join(dir, name));
      if (new TextEncoder().encode(text).length > MAX_RECIPE_FILE_BYTES) {
        log(`[recipes] ${name} is larger than 64 KiB; skipped`);
        continue;
      }
      loaded.push(JSON.parse(text));
    } catch (error) {
      log(`[recipes] ${name}: ${describe(error)}; skipped`);
    }
  }
  return loaded;
}

/** /etc/os-release's ID (recipe requires.os). */
export function parseOsReleaseId(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^ID=(.*)$/.exec(line.trim());
    if (match === null) continue;
    const value = (match[1] ?? "").replace(/^"(.*)"$/, "$1");
    return OS_ID.test(value) ? value : null;
  }
  return null;
}
