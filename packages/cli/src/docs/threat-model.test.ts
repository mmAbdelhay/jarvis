import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkThreatModel, parseThreatModel } from "./threat-model-links.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const DOC = readFileSync(join(REPO, "docs/os/threat-model.md"), "utf8");
const readRepoFile = (path: string) => {
  try {
    return readFileSync(join(REPO, path), "utf8");
  } catch {
    return undefined;
  }
};

describe("docs/os/threat-model.md (design §3.2, criterion 2)", () => {
  it("links every mitigation to code and tests that exist", () => {
    expect(checkThreatModel(parseThreatModel(DOC), readRepoFile)).toEqual([]);
  });

  it("names the design's five assets and six actors", () => {
    const model = parseThreatModel(DOC);
    expect(model.assets).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(model.actors).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"]);
    expect(model.mitigations.length).toBeGreaterThanOrEqual(16);
  });

  it("states plainly that the confirm card is a UI gate, not a security boundary", () => {
    expect(DOC).toContain("The confirm card is a UI gate, not a security boundary");
  });
});
