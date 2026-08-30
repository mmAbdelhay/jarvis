import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the contract between app.ts's `$(id)` lookups and index.html's markup.
// $() throws `Missing element #x` at module top level for any id not present
// in the DOM, which blanks the entire dashboard on load. A typo here is
// invisible to tsc (ids are plain strings) and only surfaces at runtime, so
// this test derives the id list directly from app.ts's source rather than
// hand-copying it, so it can't silently drift out of sync.

const appSource = readFileSync(fileURLToPath(new URL("./app.ts", import.meta.url)), "utf8");
const htmlSource = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

function idsPassedTo$(source: string): string[] {
  const ids: string[] = [];
  const pattern = /\$\(\s*"([^"]+)"\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const id = match[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

describe("$() id contract", () => {
  const ids = idsPassedTo$(appSource);

  it("finds at least one $() call in app.ts (sanity check the extraction itself works)", () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  it.each(Array.from(new Set(ids)))("index.html has an element with id=\"%s\"", (id) => {
    expect(htmlSource).toMatch(new RegExp(`id="${id}"`));
  });
});
