import { describe, expect, it } from "vitest";
import { sessionLabel } from "./label.js";

describe("sessionLabel", () => {
  it("uses the configured project name when there is one", () => {
    expect(sessionLabel({ project: "acme", projectPath: "/Users/x/projects/store" })).toBe(
      "acme",
    );
  });

  it("falls back to the directory's base name when no project matched", () => {
    expect(sessionLabel({ project: null, projectPath: "/Users/x/projects/storefront" })).toBe(
      "storefront",
    );
  });

  it("survives a trailing separator", () => {
    expect(sessionLabel({ project: null, projectPath: "/Users/x/projects/store/" })).toBe("store");
  });

  it("falls back to the path itself when it has no base name", () => {
    expect(sessionLabel({ project: null, projectPath: "/" })).toBe("/");
  });
});
