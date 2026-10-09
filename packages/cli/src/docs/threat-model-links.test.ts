import { describe, expect, it } from "vitest";
import { checkThreatModel, parseThreatModel, REPO_URL } from "./threat-model-links.js";

const url = (path: string) => `${REPO_URL}${path}`;
const files: Record<string, string> = {
  "src/fence.ts": "export {}",
  "src/fence.test.ts": 'it("neutralises the fence", () => {})',
  "go/redact_test.go": "func TestPatterns(t *testing.T) {}",
};
const read = (path: string) => files[path];

function doc(rows: string, accepted = "| R1 | A2 | same user | the OS isolates users |") {
  return `# T

## Assets

| ID | Asset | Where |
|---|---|---|
| S1 | files | home |

## Actors

| ID | Actor | Reach |
|---|---|---|
| A1 | injection | text |
| A2 | local process | socket |

## Mitigations

| ID | Actors | Threat | Mitigation | Code | Tests |
|---|---|---|---|---|---|
${rows}

## Accepted risks

| ID | Actors | Risk | Why |
|---|---|---|---|
${accepted}
`;
}

const good = `| M1 | A1 | steer | fence | [fence.ts](${url("src/fence.ts")}) | [neutralises the fence](${url("src/fence.test.ts")}), [TestPatterns](${url("go/redact_test.go")}) |`;

describe("threat model walker", () => {
  it("parses tables and finds nothing wrong in a good doc", () => {
    const model = parseThreatModel(doc(good));
    expect(model.assets).toEqual(["S1"]);
    expect(model.actors).toEqual(["A1", "A2"]);
    expect(model.mitigations[0]?.tests.map((t) => t.path)).toEqual([
      "src/fence.test.ts",
      "go/redact_test.go",
    ]);
    expect(checkThreatModel(model, read)).toEqual([]);
  });

  it("fails when a linked test file disappears or a test is renamed", () => {
    const missing = good.replace("go/redact_test.go", "go/gone_test.go");
    expect(checkThreatModel(parseThreatModel(doc(missing)), read)).toEqual([
      "M1: linked file is missing: go/gone_test.go",
    ]);
    const renamed = good.replace("[TestPatterns]", "[TestOldName]");
    expect(checkThreatModel(parseThreatModel(doc(renamed)), read)).toEqual([
      'M1: test "TestOldName" is not in go/redact_test.go',
    ]);
  });

  it("fails on a row without tests, a non-test link, an unknown or uncovered actor", () => {
    const noTests = `| M1 | A1 | steer | fence | [fence.ts](${url("src/fence.ts")}) | none |`;
    const notATest = `| M2 | A9 | steer | fence | [fence.ts](${url("src/fence.ts")}) | [fence](${url("src/fence.ts")}) |`;
    const problems = checkThreatModel(parseThreatModel(doc(`${noTests}\n${notATest}`, "")), read);
    expect(problems).toEqual([
      "M1: no test link",
      "M2: unknown actor A9",
      "M2: not a test file: src/fence.ts",
      "A2: no mitigation or accepted risk names this actor",
    ]);
  });

  it("refuses paths that leave the repository", () => {
    const escaping = good.replace("src/fence.ts)", "../etc/passwd)");
    expect(checkThreatModel(parseThreatModel(doc(escaping)), read)).toContain(
      "M1: linked path leaves the repository: ../etc/passwd",
    );
  });
});
