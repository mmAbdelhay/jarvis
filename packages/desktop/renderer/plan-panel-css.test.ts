import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

describe("plan panel CSS", () => {
  it("uses tokens for every colour in plan-panel rules", () => {
    const rules = [...css.matchAll(/[^{}]*\.plan-panel[^{}]*\{([^}]*)\}/g)].map(
      (match) => match[1] ?? "",
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const declarations of rules) {
      expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
      for (const declaration of declarations.split(";")) {
        const [rawName, ...rawValue] = declaration.split(":");
        const name = rawName?.trim() ?? "";
        if (
          name !== "color" &&
          name !== "background" &&
          name !== "background-color" &&
          name !== "border" &&
          !name.endsWith("-color")
        ) {
          continue;
        }
        const value = rawValue.join(":").trim();
        if (value === "none" || value === "transparent" || value === "inherit") continue;
        expect(value).toContain("var(--");
      }
    }
  });

  it("sets the approved panel and gutter dimensions", () => {
    const panel = css.match(/\.plan-panel\s*\{([^}]*)\}/)?.[1] ?? "";
    const gutter = css.match(/\.plan-panel__gutter\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(panel).toContain("width: 420px");
    expect(panel).toContain("min-width: 300px");
    expect(panel).toContain("max-width: 60%");
    expect(gutter).toContain("width: 40px");
  });
});
