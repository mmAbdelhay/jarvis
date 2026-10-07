import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("platform barrel", () => {
  it("re-exports each module only once", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const exportLines = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("export * from"));
    const duplicates = exportLines.filter((line, i) => exportLines.indexOf(line) !== i);
    expect(duplicates).toEqual([]);
  });
});
