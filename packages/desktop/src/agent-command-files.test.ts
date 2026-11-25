import { describe, expect, it } from "vitest";
import { parseCommandFile } from "./agent-command-files.js";

describe("parseCommandFile", () => {
  it("reads name, description and argument hint from the front matter", () => {
    expect(
      parseCommandFile(
        "---\nname: ship-it\ndescription: Ship it now\nargument-hint: [env]\n---\nbody",
      ),
    ).toEqual({ name: "ship-it", description: "Ship it now", hint: "[env]", hidden: false });
  });

  it("reads folded and literal block descriptions on one line", () => {
    expect(
      parseCommandFile("---\ndescription: >\n  First part\n  second part\n---\n").description,
    ).toBe("First part second part");
    expect(
      parseCommandFile("---\ndescription: |-\n  Line one\n  line two\nname: x\n---\n").description,
    ).toBe("Line one line two");
  });

  it("falls back to the first body line that is not a heading", () => {
    expect(parseCommandFile("\n# Title\nSync the team\n").description).toBe("Sync the team");
    expect(parseCommandFile("---\nfoo: 1\n---\n\n# H\nThe body line").description).toBe(
      "The body line",
    );
  });

  it("marks a command hidden when it is not user-invocable or says hidden", () => {
    expect(parseCommandFile("---\nuser-invocable: false\n---\nx").hidden).toBe(true);
    expect(parseCommandFile("---\nhidden: true\n---\nx").hidden).toBe(true);
    expect(parseCommandFile("---\nuser-invocable: true\n---\nx").hidden).toBe(false);
  });

  it("drops control characters, quotes and caps the description at 200", () => {
    expect(parseCommandFile('---\ndescription: "Quoted \u001b[31m text"\n---\n').description).toBe(
      "Quoted [31m text",
    );
    expect(
      parseCommandFile(`---\ndescription: ${"a".repeat(500)}\n---\n`).description,
    ).toHaveLength(200);
  });

  it("ignores an invalid front-matter name and empty text", () => {
    expect(parseCommandFile("---\nname: ../evil\n---\n").name).toBeUndefined();
    expect(parseCommandFile("")).toEqual({ hidden: false });
  });
});
