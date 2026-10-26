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

  it("keeps the reviews dock a side panel like the plan panel, colours from tokens", () => {
    const dock = css.match(/\.reviews-dock\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(dock).toContain("min-width: 280px");
    expect(dock).toContain("max-width: 60%");
    const handle = css.match(/\.reviews-dock-handle\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(handle).toContain("cursor: col-resize");
    const rules = [...css.matchAll(/[^{}]*\.reviews-(?:dock|chip|toggle)[^{}]*\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, declarations] of rules) {
      expect(declarations ?? "").not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
    }
  });
});

describe("the Plan and Reviews switches", () => {
  // Floated over the panes they covered the first block's action buttons.
  it("get a band of their own above the panes", () => {
    const band = css.match(
      /\.terminal-split:has\(> \.plan-toggle, > \.reviews-toggle\) \{ padding-block-start: (\d+)px; \}/,
    );
    expect(Number(band?.[1])).toBeGreaterThanOrEqual(30);
    for (const toggle of ["plan-toggle", "reviews-toggle"]) {
      const rule = css.match(new RegExp(`\\.${toggle} \\{([^}]*)\\}`))?.[1] ?? "";
      const top = Number(rule.match(/inset-block-start: (\d+)px/)?.[1]);
      const height = Number(rule.match(/height: (\d+)px/)?.[1]);
      expect(top + height, toggle).toBeLessThanOrEqual(Number(band?.[1]));
    }
  });
});
