import { describe, expect, it } from "vitest";
import { PERSONAL_PROJECT, isPersonalProject } from "./personal.js";

describe("the personal pseudo-project", () => {
  // The key is interpolated into a partition name, a bookmark-file key and
  // a `<select>` option value, so it must survive all three untouched. A
  // name with a space or a slash in it would not.
  it("is a key, not a label", () => {
    expect(PERSONAL_PROJECT).toBe("__personal__");
    expect(encodeURIComponent(PERSONAL_PROJECT)).toBe(PERSONAL_PROJECT);
  });

  it("recognises itself and nothing else", () => {
    expect(isPersonalProject(PERSONAL_PROJECT)).toBe(true);
    expect(isPersonalProject("acme")).toBe(false);
    expect(isPersonalProject("personal")).toBe(false);
    expect(isPersonalProject("")).toBe(false);
  });
});
