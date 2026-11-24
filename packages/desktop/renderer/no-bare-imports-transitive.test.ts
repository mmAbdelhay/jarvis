// The renderer has no bundler: a browser resolves every import itself, so one
// bare specifier anywhere in the graph kills the whole window at load. The
// direct imports are no-value-imports.test.ts's; this follows the graph, since
// a module under src/ that imports "@jarvis/core" breaks the page just as well.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Specifiers a module loads at run time: not `import type`, and not an
 *  import whose every named binding is a type. */
function runtimeSpecifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /^(?:import|export)\s+(?!type\s)(?:([^;"']*?)\s+from\s+)?["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) {
    const names = /^\{([\s\S]*)\}$/.exec((match[1] ?? "").trim())?.[1];
    const bindings = names
      ?.split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    if (bindings?.every((name) => name.startsWith("type "))) continue;
    if (match[2] !== undefined) found.push(match[2]);
  }
  return found;
}

function bareImports(entry: string): string[] {
  const cameFrom = new Map<string, string | undefined>([[join(HERE, entry), undefined]]);
  const queue = [...cameFrom.keys()];
  const bare: string[] = [];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) {
        bare.push(`${file.slice(dirname(HERE).length + 1)} imports ${specifier}`);
        continue;
      }
      const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
      if (!existsSync(target) || cameFrom.has(target)) continue;
      cameFrom.set(target, file);
      queue.push(target);
    }
  }
  return bare;
}

describe("the renderer's whole import graph", () => {
  it.each(["app.ts", "popout.ts"])("%s reaches no bare specifier", (entry) => {
    expect(bareImports(entry)).toEqual([]);
  });
});
