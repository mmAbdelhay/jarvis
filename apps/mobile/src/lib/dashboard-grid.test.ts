import { describe, expect, it } from "vitest";
import { dashboardColumns, dashboardGrid } from "./dashboard-grid";

describe("dashboardColumns", () => {
  it.each([
    [390, 1],
    [820, 2],
    [1366, 3],
  ] as const)("%i wide is %i column(s)", (width, columns) => {
    expect(dashboardColumns(width)).toBe(columns);
  });

  it("switches to three columns at 1100", () => {
    expect(dashboardColumns(1099)).toBe(2);
    expect(dashboardColumns(1100)).toBe(3);
  });

  it("uses two columns from the wide floor (744, iPad mini portrait)", () => {
    expect(dashboardColumns(743)).toBe(1);
    expect(dashboardColumns(744)).toBe(2);
  });
});

describe("dashboardGrid", () => {
  it("stacks every panel in phone order in one column", () => {
    expect(dashboardGrid(1)).toEqual([["system", "sessions", "projects"]]);
  });

  it("puts System over Sessions beside Projects in two columns", () => {
    expect(dashboardGrid(2)).toEqual([["system", "sessions"], ["projects"]]);
  });

  it("gives each panel its own column in three columns", () => {
    expect(dashboardGrid(3)).toEqual([["system"], ["sessions"], ["projects"]]);
  });
});
