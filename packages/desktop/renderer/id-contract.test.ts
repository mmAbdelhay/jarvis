import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the contract between app.ts's/changes.ts's `$(id)` lookups and
// index.html's markup. $() throws `Missing element #x` for any id not
// present in the DOM — at module top level in app.ts (blanking the entire
// dashboard on load) or inside openChanges/showView in changes.ts (breaking
// the Changes route Tasks 13-15 build on). A typo here is invisible to tsc
// (ids are plain strings) and only surfaces at runtime, so this test derives
// the id list directly from both modules' source rather than hand-copying
// it, so it can't silently drift out of sync.

const appSource = readFileSync(fileURLToPath(new URL("./app.ts", import.meta.url)), "utf8");
const changesSource = readFileSync(fileURLToPath(new URL("./changes.ts", import.meta.url)), "utf8");
// session-view.ts's own `$` returns null instead of throwing, so a typo
// there fails *silently* — a pane that simply never fills in — which is
// harder to notice than the thrown "Missing element #x", not easier. Same
// contract, same check.
const sessionViewSource = readFileSync(
  fileURLToPath(new URL("./session-view.ts", import.meta.url)),
  "utf8",
);
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
  const ids = [
    ...idsPassedTo$(appSource),
    ...idsPassedTo$(changesSource),
    ...idsPassedTo$(sessionViewSource),
  ];

  it("finds at least one $() call across the renderer modules (sanity check the extraction itself works)", () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  it.each(Array.from(new Set(ids)))("index.html has an element with id=\"%s\"", (id) => {
    expect(htmlSource).toMatch(new RegExp(`id="${id}"`));
  });
});
