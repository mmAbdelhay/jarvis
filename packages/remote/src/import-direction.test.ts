import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `remote` knows nothing about Jarvis (spec, "Architecture"): the import
// direction is desktop → {platform, remote} → core, and remote imports only
// core, plus an exact per-file allowlist of the third-party packages the
// bridge needs (`ws`, `@peculiar/x509`, `reflect-metadata`) — never a
// subpath of one. This is an allowlist, not a blocklist of "not platform,
// not desktop, not electron": a blocklist only catches names it already
// knows, so `@jarvis/somethingnew` a later milestone adds would sail
// straight through it. The walk is recursive because a flat readdir goes
// blind the day M4 adds a subdirectory such as `src/transport/`.
const ROOT = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...sourceFiles(`${path}/`));
      continue;
    }
    if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

/**
 * Every module specifier a file's source text references: a static from-
 * clause or side-effect import, a dynamic import call, or a require call.
 * Biome enforces double-quoted strings across this repo, so a single-quoted
 * specifier is not a quieter way past this — there are none to miss. The
 * quote class also accepts a backtick, so `import(\`electron\`)` is caught
 * too; a template with an interpolation (`` import(`${name}`) ``) is still
 * matched, captured as the literal text "${name}", which can never equal an
 * allowlisted name, so it is flagged like any other unrecognised specifier.
 *
 * Comments are stripped first (the same rule platform-convention.test.ts
 * applies): this file's own doc comments talk about import syntax in prose,
 * and a rule that fires on a comment's example is a rule that also fires on
 * this file when the real-tree assertion below scans it.
 */
function specifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const matches = [
    // The keyword `from` clause only — real `import … from "…"` / `export …
    // from "…"` syntax never puts a paren between `from` and the quote, so
    // requiring whitespace directly before the quote (no `\(?`) is what
    // keeps `Buffer.from("literal")` from reading as a module specifier.
    // The negative lookbehind rules out a preceding `.` for the same
    // reason: a real `from` clause is never a property access.
    ...code.matchAll(/(?<!\.)\bfrom\s+(["`])([^"`]*)\1/g),
    ...code.matchAll(/\bimport\s*\(?\s*(["`])([^"`]*)\1/g),
    ...code.matchAll(/\brequire\(\s*(["`])([^"`]*)\1\s*\)/g),
  ];
  return matches.map((match) => match[2] ?? "");
}

/**
 * Third-party packages the bridge is allowed to import, each keyed to the
 * exact files (relative to `src/`) allowed to import it. Exact names only —
 * `ws/lib/websocket.js` is not `ws` — and exact files only, so a package
 * landing in a new file needs a deliberate edit here, not a broadened glob.
 */
const THIRD_PARTY: Readonly<Record<string, readonly string[]>> = {
  ws: ["server.ts", "probe-client.ts", "bridge.integration.test.ts"],
  // certificate.test.ts mints its own SAN-carrying certificates (M11 rule 3)
  // with the same library certificate.ts uses to mint its self-signed pair,
  // and so needs the same reflect-metadata guarantee independently.
  "@peculiar/x509": ["certificate.ts", "certificate.test.ts"],
  "reflect-metadata": ["certificate.ts", "certificate.test.ts"],
};

/** A file's path plus its source text, the unit the detector runs on. */
type SourceFile = { path: string; source: string };

/**
 * Every specifier outside the allowlist: `@jarvis/core` (and its subpaths),
 * `node:*`, `vitest` in test files only, a relative import that stays inside
 * this directory once resolved, and a `THIRD_PARTY` package imported from
 * exactly the file(s) it names. Anything else — `@jarvis/platform`,
 * `@jarvis/desktop`, `electron`, an unrelated `@jarvis/*`, a relative path
 * that climbs out of `packages/remote/src`, a `THIRD_PARTY` package from a
 * file not listed for it, or a subpath such as `ws/lib/websocket.js` — is a
 * violation.
 */
function violations(files: readonly SourceFile[]): [string, string][] {
  const found: [string, string][] = [];
  for (const { path, source } of files) {
    const isTest = path.endsWith(".test.ts");
    const relativePath = path.startsWith(ROOT) ? path.slice(ROOT.length) : path;
    for (const specifier of specifiers(source)) {
      // A template literal with an unresolved interpolation is never a
      // static specifier the checks below can reason about — `./${dir}/x.js`
      // would resolve (as the literal text) inside ROOT and sail past the
      // relative-import allowance below despite naming no file at all. Catch
      // it before any allow branch gets a chance to.
      if (specifier.includes("${")) {
        found.push([path, specifier]);
        continue;
      }
      if (specifier === "@jarvis/core" || specifier.startsWith("@jarvis/core/")) continue;
      if (specifier === "@jarvis/wire" || specifier.startsWith("@jarvis/wire/")) continue;
      if (specifier.startsWith("node:")) continue;
      if (isTest && specifier === "vitest") continue;
      if (specifier.startsWith(".") && resolve(dirname(path), specifier).startsWith(ROOT)) {
        continue;
      }
      // `Object.hasOwn` rather than a bare property lookup: a specifier of
      // `"__proto__"` on a plain object literal reads back `Object.prototype`
      // itself (truthy, no `.includes`), which would throw instead of being
      // flagged like any other unrecognised specifier.
      if (Object.hasOwn(THIRD_PARTY, specifier) && THIRD_PARTY[specifier]?.includes(relativePath)) {
        continue;
      }
      found.push([path, specifier]);
    }
  }
  return found;
}

// Fixture sources for the self-check below, assembled from a quote character
// held in a variable rather than typed literally. Typed as
// `from "electron"` these fixtures would themselves look like real imports
// of `electron`/`@jarvis/platform` to the very regex under test, and get
// flagged by the "real tree" assertion at the bottom of this file, which
// scans this file too.
const Q = '"';
const asStaticImport = (specifier: string) => `export * from ${Q}${specifier}${Q};`;
const asSideEffectImport = (specifier: string) => `import ${Q}${specifier}${Q};`;
const asDynamicImport = (specifier: string) => `const m = await import(${Q}${specifier}${Q});`;
const asRequire = (specifier: string) => `const m = require(${Q}${specifier}${Q});`;
const asVitestImport = (specifier: string) => `import { it } from ${Q}${specifier}${Q};`;

// A second quote character for the backtick-quote fixtures, held in a
// variable for the same reason `Q` is: written literally, `import(\`electron\`)`
// would itself look like a real import of `electron` to the self-check at
// the bottom of this file.
const BACKTICK = "`";
const asBacktickDynamicImport = (specifier: string) =>
  `const m = await import(${BACKTICK}${specifier}${BACKTICK});`;

describe("@jarvis/remote's import direction", () => {
  // Self-check: the detector is tested on sample sources before it is
  // trusted against the real tree, the same way a linter's rule ships with
  // fixtures for what it must catch and what it must leave alone.
  it.each<[string, string]>([
    [asSideEffectImport("electron"), "electron"],
    [asDynamicImport("@jarvis/platform"), "@jarvis/platform"],
    [asStaticImport("../../platform/src/x.js"), "../../platform/src/x.js"],
    [asStaticImport("@jarvis/desktop"), "@jarvis/desktop"],
    [asRequire("ws"), "ws"],
    [asStaticImport("@jarvis/somethingnew"), "@jarvis/somethingnew"],
    // A subpath is not the package: THIRD_PARTY only ever allows "ws" itself.
    [asRequire("ws/lib/websocket.js"), "ws/lib/websocket.js"],
    // Backtick-quoted specifiers, including a template with an
    // interpolation — captured as the literal text "${name}", which can
    // never match an allowlisted name.
    [asBacktickDynamicImport("electron"), "electron"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal specifier text, not a forgotten template
    [asBacktickDynamicImport("${name}"), "${name}"],
    // A relative-looking template with an interpolation: naively resolved
    // (as the literal text) this sits inside ROOT and would sail past the
    // relative-import allowance — the `${` check ahead of every allow
    // branch is what catches it instead.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal specifier text, not a forgotten template
    [asStaticImport("./${dir}/x.js"), "./${dir}/x.js"],
    // `THIRD_PARTY["__proto__"]` would read back `Object.prototype` itself
    // (truthy, no `.includes`) on a bare property lookup — `Object.hasOwn`
    // is what keeps this a flag instead of a thrown TypeError.
    [asRequire("__proto__"), "__proto__"],
  ])("flags %j", (source, specifier) => {
    expect(violations([{ path: `${ROOT}sample.ts`, source }])).toEqual([
      [`${ROOT}sample.ts`, specifier],
    ]);
  });

  it("leaves Buffer.from(...) unflagged — it is a method call, not a module specifier", () => {
    // Built from `Q` rather than typed as `Buffer.from("deadbeef", "hex")`
    // directly, for the same reason the fixtures above are: a literal
    // double-quoted string here would itself look like real source text to
    // the "real tree" self-check at the bottom of this file (which scans
    // this file too), and biome enforces double quotes anyway, so a plain
    // single-quoted literal isn't a quieter way to write one.
    const source = `const key = Buffer.from(${Q}deadbeef${Q}, ${Q}hex${Q});`;
    expect(violations([{ path: `${ROOT}sample.ts`, source }])).toEqual([]);
  });

  it.each<string>([
    asStaticImport("@jarvis/core"),
    asStaticImport("@jarvis/core/x.js"),
    asStaticImport("@jarvis/wire"),
    asStaticImport("@jarvis/wire/x.js"),
    asSideEffectImport("node:net"),
    asStaticImport("./interfaces.js"),
  ])("does not flag %j", (source) => {
    expect(violations([{ path: `${ROOT}sample.ts`, source }])).toEqual([]);
  });

  it("allows vitest in a test file but not a non-test module", () => {
    const source = asVitestImport("vitest");
    expect(violations([{ path: `${ROOT}sample.test.ts`, source }])).toEqual([]);
    expect(violations([{ path: `${ROOT}sample.ts`, source }])).toEqual([
      [`${ROOT}sample.ts`, "vitest"],
    ]);
  });

  it("allows ws in server.ts and reflect-metadata in certificate.ts", () => {
    expect(violations([{ path: `${ROOT}server.ts`, source: asStaticImport("ws") }])).toEqual([]);
    expect(
      violations([{ path: `${ROOT}certificate.ts`, source: asStaticImport("reflect-metadata") }]),
    ).toEqual([]);
  });

  it("flags ws in connection.ts and @peculiar/x509 in server.ts — the allowlist is per file, not per package", () => {
    expect(violations([{ path: `${ROOT}connection.ts`, source: asStaticImport("ws") }])).toEqual([
      [`${ROOT}connection.ts`, "ws"],
    ]);
    expect(
      violations([{ path: `${ROOT}server.ts`, source: asStaticImport("@peculiar/x509") }]),
    ).toEqual([[`${ROOT}server.ts`, "@peculiar/x509"]]);
  });

  it("has no violations across the real tree", () => {
    const files = sourceFiles(ROOT).map((path) => ({ path, source: readFileSync(path, "utf8") }));
    expect(violations(files)).toEqual([]);
  });

  it("keeps the Expo host in push.ts constants only", () => {
    const host = ["exp", "host"].join(".");
    const matching = sourceFiles(ROOT).filter((path) => readFileSync(path, "utf8").includes(host));
    expect(matching).toEqual([`${ROOT}push.ts`]);

    const pushSource = readFileSync(`${ROOT}push.ts`, "utf8");
    expect(pushSource.match(new RegExp(host, "g"))).toHaveLength(2);
    expect(pushSource).not.toMatch(/undici|@jarvis\/platform/);
  });
});

/**
 * Every relative specifier a file's source *value*-imports — a `from`
 * clause (or a side-effect `import "…"`) whose clause does not start with
 * `type`, so `import type {…} from "./certificate.js"` and `export type
 * {…} from "./bridge.js"` are skipped. This is deliberately narrower than
 * `specifiers()` above: that function is a security net that must catch
 * every specifier of every kind; this one drives the reachability walk,
 * where a type-only import correctly carries nothing into the compiled
 * output and so must not count as reaching the file it names.
 */
function valueSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found: string[] = [];
  for (const match of code.matchAll(/\b(?:import|export)\b([^;]*?)\bfrom\s+(["`])([^"`]*)\2/g)) {
    const clause = match[1] ?? "";
    if (/^\s*type\b/.test(clause)) continue;
    found.push(match[3] ?? "");
  }
  for (const match of code.matchAll(/\bimport\s+(["`])([^"`]*)\1/g)) {
    found.push(match[2] ?? "");
  }
  // A dynamic `import("…")` / `` import(`…`) `` call is a value import too
  // — `await import("./server.js")` inside bridge.ts would reach the real
  // listener code just as surely as a static `export * from` would, and a
  // reachability walk that only understood static syntax would miss it.
  for (const match of code.matchAll(/\bimport\s*\(\s*(["`])([^"`]*)\1\s*\)/g)) {
    found.push(match[2] ?? "");
  }
  return found;
}

describe("@jarvis/remote's index.ts reachability", () => {
  // Ruling 21: the main entry never loads a listener. server.ts,
  // certificate.ts, node-io.ts, probe-client.ts, listen.ts and proxy.ts
  // must be unreachable from index.ts by value import, so requiring
  // `@jarvis/remote` alone can never touch the network, the real
  // filesystem or third-party TLS/cert code. `proxy.ts` is listed
  // explicitly (M11 Task 2 fix round 1) rather than relying only on its
  // `node:net`/`node:http` imports below to catch a value path into it —
  // a future edit that dropped those imports (e.g. `handleUpgrade` moving
  // its socket work elsewhere) would otherwise silently reopen the door.
  const FORBIDDEN_FILES = new Set([
    "server.ts",
    "certificate.ts",
    "node-io.ts",
    "probe-client.ts",
    "listen.ts",
    "proxy.ts",
  ]);

  // Defence in depth beside the file-name check above: even if a listener's
  // code moved to a differently-named file, none of *these* specifiers —
  // the ones that actually touch the network or a TLS certificate — should
  // ever be reachable from `index.ts` either. `node:net` used to be
  // deliberately left out: `address.ts` (reachable from `index.ts` by
  // design) imported its `isIP` for pure address-literal parsing, no
  // socket and no I/O involved. As of M6, `address.ts` re-exports its pure
  // `canonicalAddress` from `@jarvis/wire` instead, so no non-test file in
  // this package imports `node:net` any more — it now belongs in this set
  // like any other real networking import, load-bearing rather than moot.
  // `node:http` (M11 Task 2 fix round 1) is proxy.ts's own hop client —
  // listed for the same reason `node:net` is.
  const FORBIDDEN_SPECIFIERS = new Set([
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "ws",
    "@peculiar/x509",
  ]);

  function reachableFrom(entry: string): { path: string; specifier: string }[] {
    const violationsFound: { path: string; specifier: string }[] = [];
    const visited = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || visited.has(file)) continue;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      for (const specifier of valueSpecifiers(source)) {
        if (FORBIDDEN_SPECIFIERS.has(specifier)) {
          violationsFound.push({ path: file, specifier });
        }
        if (!specifier.startsWith(".")) continue;
        const resolved = resolve(dirname(file), specifier).replace(/\.js$/, ".ts");
        if (!resolved.startsWith(ROOT)) continue;
        const relative = resolved.slice(ROOT.length);
        if (FORBIDDEN_FILES.has(relative)) {
          violationsFound.push({ path: file, specifier: `./${relative}` });
        }
        queue.push(resolved);
      }
    }
    return violationsFound;
  }

  it("never reaches server.ts, certificate.ts, node-io.ts, probe-client.ts or listen.ts by value import, static or dynamic", () => {
    expect(reachableFrom(`${ROOT}index.ts`)).toEqual([]);
  });

  it("never reaches node:https, node:net, node:tls, ws or @peculiar/x509 by value import", () => {
    expect(reachableFrom(`${ROOT}index.ts`)).toEqual([]);
  });
});
