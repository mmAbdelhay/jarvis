import { describe, expect, it } from "vitest";
import {
  parsePopoutState,
  plainTerminalState,
  POPOUT_DRAFT_MAX,
  POPOUT_MAX_DEPTH,
  shapeKeys,
} from "./popout-state.js";

const split = (a: unknown, b: unknown, direction = "row") => ({ direction, first: a, second: b });

describe("parsePopoutState", () => {
  it("accepts a plain tab, a split layout, drafts and the focused pane", () => {
    expect(parsePopoutState(plainTerminalState("t1"), "t1")).toEqual(plainTerminalState("t1"));
    const state = {
      shape: split({ key: "t1" }, split({ key: "t1:p1" }, { key: "t1:p2" }, "column")),
      drafts: { "t1:p1": "git status", t1: "" },
      focused: "t1:p2",
    };
    expect(parsePopoutState(state, "t1")).toEqual({
      shape: state.shape,
      drafts: { "t1:p1": "git status" },
      focused: "t1:p2",
    });
    expect(shapeKeys(state.shape as never)).toEqual(["t1", "t1:p1", "t1:p2"]);
  });

  it("refuses another tab's pane keys, repeats, odd shapes and bad drafts", () => {
    const bad = [
      null,
      "x",
      { shape: { key: "t2" } },
      { shape: { key: "t10" } },
      { shape: { key: "t1:p1" }, drafts: { t1: "x" } },
      { shape: split({ key: "t1" }, { key: "t1" }) },
      { shape: { direction: "diagonal", first: { key: "t1" }, second: { key: "t1:p1" } } },
      { shape: { key: "t1" }, drafts: { t1: 5 } },
      { shape: { key: "t1" }, drafts: { t1: "x".repeat(POPOUT_DRAFT_MAX + 1) } },
      { shape: { key: "t1" }, drafts: ["x"] },
      { shape: { key: "t1" }, focused: "t1:p9" },
      { shape: { key: "t1".padEnd(300, "x") } },
    ];
    for (const value of bad) expect(parsePopoutState(value, "t1")).toBeUndefined();
  });

  it("bounds depth and the number of panes", () => {
    let deep: unknown = { key: "t1" };
    for (let i = 0; i <= POPOUT_MAX_DEPTH; i += 1) deep = split(deep, { key: `t1:p${i}` });
    expect(parsePopoutState({ shape: deep }, "t1")).toBeUndefined();
    let wide: unknown = { key: "t1" };
    for (let i = 1; i < 20; i += 1) wide = split({ key: `t1:p${i}` }, wide);
    expect(parsePopoutState({ shape: wide }, "t1")).toBeUndefined();
  });
});
