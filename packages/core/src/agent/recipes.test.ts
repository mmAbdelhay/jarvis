import { describe, expect, it } from "vitest";
import { PYTHON } from "./__fixtures__/recipes.js";
import { RECIPE_TEXT } from "./messages.js";
import {
  checkStepTool,
  parseRecipe,
  recipeFits,
  RECIPE_STEP_TOOLS,
  type Recipe,
} from "./recipes.js";

const parsed = (raw: unknown): Recipe => {
  const result = parseRecipe(raw);
  if (!result.ok) throw new Error(result.error);
  return result.recipe;
};

describe("recipe files (M4 §4)", () => {
  it("parses a recipe field by field", () => {
    const recipe = parsed({ ...PYTHON, extra: "ignored" });
    expect(recipe.id).toBe("python-dev");
    expect(recipe.steps.map((s) => s.tool)).toEqual(["pkg.install", "pkg.install", "svc.restart"]);
    expect(recipe.requires).toEqual({ os: "rafiq", minRamGB: 4 });
    expect(Object.keys(recipe)).not.toContain("extra");
  });

  it("allows only the setup tools as steps", () => {
    expect([...RECIPE_STEP_TOOLS].sort()).toEqual([
      "apps.set_default",
      "pkg.install",
      "svc.restart",
    ]);
    for (const tool of [
      "registry.install",
      "users.add",
      "files.trash",
      "recipes.run",
      "pkg.remove",
    ]) {
      const raw = { ...PYTHON, steps: [{ ...PYTHON.steps[0], tool }] };
      expect(parseRecipe(raw).ok, tool).toBe(false);
    }
  });

  it("refuses broken recipes", () => {
    const bad: unknown[] = [
      null,
      { ...PYTHON, id: "Python Dev" },
      { ...PYTHON, title: { en: "Python" } },
      { ...PYTHON, description: { en: "x", ar: "" } },
      { ...PYTHON, steps: [] },
      { ...PYTHON, steps: Array.from({ length: 21 }, () => PYTHON.steps[2]) },
      { ...PYTHON, steps: [{ ...PYTHON.steps[2], input: "unit=ssh" }] },
      { ...PYTHON, steps: [{ ...PYTHON.steps[2], input: JSON.parse('{"__proto__": {"x": 1}}') }] },
      { ...PYTHON, steps: [{ ...PYTHON.steps[0], input: { items: [] } }] },
      { ...PYTHON, steps: [{ ...PYTHON.steps[2], title: { en: "a\u0007", ar: "ب" } }] },
      { ...PYTHON, requires: {} },
      { ...PYTHON, requires: { os: "rafiq", minRamGB: -1 } },
    ];
    for (const raw of bad) expect(parseRecipe(raw).ok, JSON.stringify(raw)).toBe(false);
  });

  it("accepts a non-executing note step (contracts §6 #2)", () => {
    const note = { tool: "note", title: { en: "Log out and in", ar: "سجّل الخروج ثم الدخول" } };
    const recipe = parsed({ ...PYTHON, steps: [PYTHON.steps[2], note] });
    expect(recipe.steps[1]).toEqual({ ...note, input: {} });
    expect(parseRecipe({ ...PYTHON, steps: [{ ...note, input: { x: 1 } }] }).ok).toBe(false);
  });

  it("fits memory at 90% of the stated GiB (contracts §6 #3)", () => {
    const recipe = parsed(PYTHON);
    expect(recipeFits(recipe, { osId: "rafiq", memTotalBytes: 3.7 * 1024 ** 3 })).toBeUndefined();
    expect(recipeFits(recipe, { osId: "rafiq", memTotalBytes: 3.5 * 1024 ** 3 })).toBeDefined();
  });

  it("parses available (default true) and refuses an unavailable recipe (contracts §6 #15)", () => {
    const machine = { osId: "rafiq", memTotalBytes: 8 * 1024 ** 3 };
    expect(parsed(PYTHON).available).toBe(true);
    const off = parsed({ ...PYTHON, available: false });
    expect(off.available).toBe(false);
    expect(recipeFits(off, machine)).toBe(RECIPE_TEXT.notAvailable("python-dev"));
    expect(parseRecipe({ ...PYTHON, available: "no" }).ok).toBe(false);
  });

  it("checks the machine: os id and memory", () => {
    const recipe = parsed(PYTHON);
    expect(recipeFits(recipe, { osId: "rafiq", memTotalBytes: 8 * 1024 ** 3 })).toBeUndefined();
    expect(recipeFits(recipe, { osId: "debian", memTotalBytes: 8 * 1024 ** 3 })).toBe(
      RECIPE_TEXT.wrongOs("python-dev", "rafiq"),
    );
    expect(recipeFits(recipe, { osId: "rafiq", memTotalBytes: 2 * 1024 ** 3 })).toBe(
      RECIPE_TEXT.tooLittleRam("python-dev", 4),
    );
    expect(recipeFits(recipe, { osId: "rafiq", memTotalBytes: null })).toBeUndefined();
  });
});

describe("checkStepTool", () => {
  const host = new Set(["jarvis-pkg", "jarvis-diag", "jarvis-apps"]);
  const tool = {
    name: "pkg.install",
    server: "jarvis-pkg",
    risk: "confirm" as const,
    secrets: [],
    hidden: false,
  };

  it("accepts a built-in confirm tool without secrets", () => {
    expect(checkStepTool("pkg.install", tool, host)).toBeUndefined();
  });

  it("refuses everything else", () => {
    expect(checkStepTool("pkg.install", undefined, host)).toMatch(/not available/);
    expect(checkStepTool("pkg.install", { ...tool, server: "acme-tools" }, host)).toMatch(
      /built-in/,
    );
    expect(checkStepTool("pkg.install", { ...tool, risk: "password" }, host)).toMatch(/password/);
    expect(checkStepTool("pkg.install", { ...tool, secrets: ["password"] }, host)).toMatch(
      /password/,
    );
    expect(checkStepTool("pkg.install", { ...tool, hidden: true }, host)).toMatch(/hidden/);
    expect(checkStepTool("pkg.remove", { ...tool, name: "pkg.remove" }, host)).toMatch(
      /recipe step/,
    );
  });
});
