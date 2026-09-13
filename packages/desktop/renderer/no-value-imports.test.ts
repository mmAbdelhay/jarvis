import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A renderer module may import *types* from a workspace package — those are
// erased at compile time — but never a value. A bare specifier like
// `import { X } from "@jarvis/platform"` survives into the bundle and is
// fatal the moment the module loads in the browser context, which no unit
// test running under Node would ever catch. This is the guard for that,
// written after exactly that mistake was made in settings.ts.
const dir = fileURLToPath(new URL(".", import.meta.url));
const modules = readdirSync(dir).filter(
  (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
);

describe("renderer workspace-package imports", () => {
  it.each(modules)("%s imports no values from a workspace package", (name) => {
    const source = readFileSync(`${dir}${name}`, "utf8");
    const offenders = [
      ...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(@jarvis\/[^"]+)"/gm),
    ].map((match) => match[1]);

    expect(offenders).toEqual([]);
  });
});
