import { describe, expect, it } from "vitest";
import { ICONS, type IconSpec } from "./icon-paths";

describe("ICONS", () => {
  it("gives every icon at least one shape with usable attributes", () => {
    for (const [name, spec] of Object.entries(ICONS) as [string, IconSpec][]) {
      expect(spec.shapes.length, name).toBeGreaterThan(0);
      for (const shape of spec.shapes) {
        if (shape.kind === "path") {
          expect(shape.attrs.d, name).toMatch(/^M/);
        } else {
          for (const value of Object.values(shape.attrs)) {
            expect(Number.isFinite(value), `${name} ${shape.kind}`).toBe(true);
          }
        }
      }
    }
  });

  it("marks the icons that point along the reading direction to mirror", () => {
    const mirrored = Object.entries(ICONS as Record<string, IconSpec>)
      .filter(([, spec]) => spec.mirror)
      .map(([name]) => name)
      .sort();
    expect(mirrored).toEqual(["back", "send"]);
  });
});
