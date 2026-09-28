import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// main.ts reaches the core through CoreClient (core/core-client.ts) and
// nothing else. The one exception is createCore itself, which the in-process
// adapter wraps. Anything more — the TabHost, the dispatch table, a type out
// of compose.ts, a constant — is a reach-through that a core running in
// jarvisd, behind the socket adapter, could not satisfy, and Task 20 would
// have to change main.ts to remove it.

type CoreImport = { specifier: string; names: string[] };

/** Every import, re-export, dynamic import and require in `source` whose
 *  specifier is under ./core/ — type-only ones included: a type out of the
 *  core's internals ties main.ts to them just the same. */
function coreImports(source: string): CoreImport[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found: CoreImport[] = [];
  const quote = `["'\`]`;
  const fromClause = new RegExp(
    `\\b(?:import|export)\\b([^;]*?)\\bfrom\\s+${quote}([^"'\`]*)${quote}`,
    "g",
  );
  for (const match of code.matchAll(fromClause)) {
    const clause = match[1] ?? "";
    const names = [...(clause.match(/\{([\s\S]*)\}/)?.[1] ?? "").split(",")]
      .map((name) =>
        name
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]!
          .trim(),
      )
      .filter((name) => name !== "");
    const rest = clause.replace(/\{[\s\S]*\}/, "").replace(/^\s*type\b/, "");
    for (const part of rest.split(",")) {
      const name = part.trim();
      if (name !== "") names.push(name);
    }
    found.push({ specifier: match[2] ?? "", names });
  }
  for (const pattern of [
    new RegExp(`\\bimport\\s+${quote}([^"'\`]*)${quote}`, "g"),
    new RegExp(`\\bimport\\s*\\(\\s*${quote}([^"'\`]*)${quote}`, "g"),
    new RegExp(`\\brequire\\(\\s*${quote}([^"'\`]*)${quote}`, "g"),
  ]) {
    for (const match of code.matchAll(pattern)) {
      found.push({ specifier: match[1] ?? "", names: ["*"] });
    }
  }
  return found.filter(({ specifier }) => /^\.\/core\//.test(specifier));
}

/** What the rule allows: createCore from compose.ts, anything from
 *  core-client.ts. Everything else under ./core/ is a violation. */
function reachThrough(source: string): string[] {
  const violations: string[] = [];
  for (const { specifier, names } of coreImports(source)) {
    if (specifier === "./core/core-client.js") continue;
    if (specifier === "./core/compose.js") {
      for (const name of names) if (name !== "createCore") violations.push(`${specifier}:${name}`);
      continue;
    }
    violations.push(`${specifier}:${names.join(",")}`);
  }
  return violations;
}

describe("main.ts reaches the core only through CoreClient", () => {
  const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

  it("imports from core/ only createCore and core-client", () => {
    expect(
      coreImports(main)
        .map(({ specifier }) => specifier)
        .sort(),
    ).toEqual(["./core/compose.js", "./core/core-client.js"]);
    expect(reachThrough(main)).toEqual([]);
  });

  it("does not hold the dispatch table or the broadcaster itself", () => {
    const code = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/from\s+"\.\/dispatch\.js"/);
    expect(code).not.toMatch(/\bcreateBroadcaster\b/);
  });

  describe("the check itself", () => {
    it("flags a second name out of compose.ts, type-only or not", () => {
      expect(reachThrough(`import { createCore, MINUTE_MS } from "./core/compose.js";`)).toEqual([
        "./core/compose.js:MINUTE_MS",
      ]);
      expect(reachThrough(`import type { Core } from "./core/compose.js";`)).toEqual([
        "./core/compose.js:Core",
      ]);
      expect(
        reachThrough(`import { createCore, type Core as C } from "./core/compose.js";`),
      ).toEqual(["./core/compose.js:Core"]);
    });

    it("flags any other core file, however it is loaded", () => {
      expect(reachThrough(`import { TabHost } from "./core/tab-host.js";`)).toEqual([
        "./core/tab-host.js:TabHost",
      ]);
      expect(reachThrough(`export { createHostLink } from "./core/host-link.js";`)).toEqual([
        "./core/host-link.js:createHostLink",
      ]);
      expect(reachThrough(`const m = await import("./core/tab-host.js");`)).toEqual([
        "./core/tab-host.js:*",
      ]);
      expect(reachThrough(`const m = require("./core/host-link.js");`)).toEqual([
        "./core/host-link.js:*",
      ]);
    });

    it("allows core-client, and ignores prose and other directories", () => {
      expect(
        reachThrough(
          [
            `import { inProcessCoreClient, type CoreClient } from "./core/core-client.js";`,
            `// import { TabHost } from "./core/tab-host.js";`,
            `import { rendererSink } from "./broadcast.js";`,
          ].join("\n"),
        ),
      ).toEqual([]);
    });
  });
});
