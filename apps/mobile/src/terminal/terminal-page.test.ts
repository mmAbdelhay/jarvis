import { describe, expect, it } from "vitest";
import { MAX_SELECTION_CHARS, parsePageMessage } from "../lib/terminal-protocol";
import { createPageController, type PageDeps, type PageTerminal } from "./terminal-page";

function makeFakeTerminal(overrides?: Partial<PageTerminal>): PageTerminal & {
  written: string[];
  resetCount: number;
  scrolls: number[];
  setSize(cols: number, rows: number): void;
  setApplicationCursor(value: boolean): void;
  setBufferType(value: "normal" | "alternate"): void;
  setMouseTrackingMode(value: PageTerminal["modes"]["mouseTrackingMode"]): void;
  setSelection(value: string): void;
  readonly clearedSelections: number;
} {
  let cols = 80;
  let rows = 24;
  let applicationCursorKeysMode = false;
  let mouseTrackingMode: PageTerminal["modes"]["mouseTrackingMode"] = "none";
  let bufferType: "normal" | "alternate" = "normal";
  const written: string[] = [];
  const scrolls: number[] = [];
  let resetCount = 0;
  let selection = "";
  let clearedSelections = 0;

  return {
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
    get modes() {
      return { applicationCursorKeysMode, mouseTrackingMode };
    },
    get buffer() {
      return { active: { type: bufferType } };
    },
    write(data: string, done: () => void) {
      written.push(data);
      done();
    },
    reset() {
      resetCount += 1;
    },
    scrollLines(amount: number) {
      scrolls.push(amount);
    },
    getSelection() {
      return selection;
    },
    clearSelection() {
      selection = "";
      clearedSelections += 1;
    },
    setSelection(value: string) {
      selection = value;
    },
    get clearedSelections() {
      return clearedSelections;
    },
    written,
    scrolls,
    get resetCount() {
      return resetCount;
    },
    setSize(newCols: number, newRows: number) {
      cols = newCols;
      rows = newRows;
    },
    setApplicationCursor(value: boolean) {
      applicationCursorKeysMode = value;
    },
    setBufferType(value: "normal" | "alternate") {
      bufferType = value;
    },
    setMouseTrackingMode(value: PageTerminal["modes"]["mouseTrackingMode"]) {
      mouseTrackingMode = value;
    },
    ...overrides,
  };
}

function makeDeps(term: PageTerminal): PageDeps & {
  posted: unknown[];
  fitCount: number;
  fixedSizes: { cols: number; rows: number }[];
} {
  const posted: unknown[] = [];
  const fixedSizes: { cols: number; rows: number }[] = [];
  let fitCount = 0;
  return {
    term,
    fit() {
      fitCount += 1;
    },
    post(text: string) {
      posted.push(JSON.parse(text));
    },
    applyFixedSize(cols: number, rows: number) {
      fixedSizes.push({ cols, rows });
      (term as unknown as { setSize(c: number, r: number): void }).setSize(cols, rows);
    },
    lineHeightPx() {
      return 20;
    },
    posted,
    fixedSizes,
    get fitCount() {
      return fitCount;
    },
  };
}

describe("createPageController", () => {
  it("start() posts ready with the fake's size, then modes", () => {
    const term = makeFakeTerminal();
    const deps = makeDeps(term);
    const controller = createPageController(deps);

    controller.start();

    expect(deps.posted).toEqual([
      { t: "ready", cols: 80, rows: 24 },
      { t: "modes", applicationCursor: false },
    ]);
    expect(deps.fitCount).toBe(1);
  });

  it('receive(\'{"t":"write","data":"x"}\') writes "x"', () => {
    const term = makeFakeTerminal();
    const deps = makeDeps(term);
    const controller = createPageController(deps);
    controller.start();
    deps.posted.length = 0;

    controller.receive('{"t":"write","data":"x"}');

    expect(term.written).toEqual(["x"]);
  });

  it("receive of an object (not a string) does nothing", () => {
    const term = makeFakeTerminal();
    const deps = makeDeps(term);
    const controller = createPageController(deps);
    controller.start();
    deps.posted.length = 0;

    controller.receive({ t: "write", data: "x" });

    expect(term.written).toEqual([]);
    expect(deps.posted).toEqual([]);
  });

  it("receive of bad JSON does nothing", () => {
    const term = makeFakeTerminal();
    const deps = makeDeps(term);
    const controller = createPageController(deps);
    controller.start();
    deps.posted.length = 0;

    controller.receive("{not json");

    expect(term.written).toEqual([]);
    expect(deps.posted).toEqual([]);
  });

  it('receive of {"t":"eval"} does nothing', () => {
    const term = makeFakeTerminal();
    const deps = makeDeps(term);
    const controller = createPageController(deps);
    controller.start();
    deps.posted.length = 0;

    controller.receive('{"t":"eval"}');

    expect(term.written).toEqual([]);
    expect(term.resetCount).toBe(0);
    expect(deps.posted).toEqual([]);
  });

  it('receive of {"t":"write","data":7} does nothing', () => {
    const term = makeFakeTerminal();
    const deps = makeDeps(term);
    const controller = createPageController(deps);
    controller.start();
    deps.posted.length = 0;

    controller.receive('{"t":"write","data":7}');

    expect(term.written).toEqual([]);
  });

  it("a write that flips applicationCursorKeysMode posts one modes after done", () => {
    const term = makeFakeTerminal();
    const deps = makeDeps(term);
    const controller = createPageController(deps);
    controller.start();
    deps.posted.length = 0;

    term.setApplicationCursor(true);
    controller.receive('{"t":"write","data":"\\u001b[?1h"}');

    expect(deps.posted).toEqual([{ t: "modes", applicationCursor: true }]);
  });

  it("a write with an unchanged mode posts nothing", () => {
    const term = makeFakeTerminal();
    const deps = makeDeps(term);
    const controller = createPageController(deps);
    controller.start();
    deps.posted.length = 0;

    controller.receive('{"t":"write","data":"hello"}');

    expect(deps.posted).toEqual([]);
  });

  it("reset() calls term.reset and posts modes if changed", () => {
    const term = makeFakeTerminal();
    const deps = makeDeps(term);
    const controller = createPageController(deps);
    controller.start();
    deps.posted.length = 0;

    term.setApplicationCursor(true);
    controller.receive('{"t":"reset"}');

    expect(term.resetCount).toBe(1);
    expect(deps.posted).toEqual([{ t: "modes", applicationCursor: true }]);
  });

  it("layoutChanged with an unchanged size posts nothing", () => {
    const term = makeFakeTerminal();
    const deps = makeDeps(term);
    const controller = createPageController(deps);
    controller.start();
    deps.posted.length = 0;

    controller.layoutChanged();

    expect(deps.posted).toEqual([]);
    expect(deps.fitCount).toBe(2);
  });

  it("layoutChanged with a size change posts resize", () => {
    const term = makeFakeTerminal();
    const deps = makeDeps(term);
    const controller = createPageController(deps);
    controller.start();
    deps.posted.length = 0;

    term.setSize(100, 30);
    controller.layoutChanged();

    expect(deps.posted).toEqual([{ t: "resize", cols: 100, rows: 30 }]);
  });

  it('receive({"t":"fit"}) behaves like layoutChanged', () => {
    const term = makeFakeTerminal();
    const deps = makeDeps(term);
    const controller = createPageController(deps);
    controller.start();
    deps.posted.length = 0;

    term.setSize(100, 30);
    controller.receive('{"t":"fit"}');

    expect(deps.posted).toEqual([{ t: "resize", cols: 100, rows: 30 }]);
    expect(deps.fitCount).toBe(2);
  });

  // Bug 8: a fixed size from native switches the page into rendering at
  // exactly that size, rather than fitting to the WebView's own layout.
  describe('receive({"t":"size", ...})', () => {
    it("applies the fixed size instead of fit(), and posts resize if it changed", () => {
      const term = makeFakeTerminal();
      const deps = makeDeps(term);
      const controller = createPageController(deps);
      controller.start();
      deps.posted.length = 0;
      const fitCountBefore = deps.fitCount;

      controller.receive('{"t":"size","cols":100,"rows":30}');

      expect(deps.fixedSizes).toEqual([{ cols: 100, rows: 30 }]);
      expect(deps.fitCount).toBe(fitCountBefore); // fit() itself never called
      expect(deps.posted).toEqual([{ t: "resize", cols: 100, rows: 30 }]);
    });

    it("a later layoutChanged() reapplies the fixed size rather than calling fit()", () => {
      const term = makeFakeTerminal();
      const deps = makeDeps(term);
      const controller = createPageController(deps);
      controller.start();
      controller.receive('{"t":"size","cols":100,"rows":30}');
      deps.posted.length = 0;
      deps.fixedSizes.length = 0;
      const fitCountBefore = deps.fitCount;

      controller.layoutChanged();

      expect(deps.fixedSizes).toEqual([{ cols: 100, rows: 30 }]);
      expect(deps.fitCount).toBe(fitCountBefore);
    });

    it('receive({"t":"fit"}) also reapplies the fixed size once one is set', () => {
      const term = makeFakeTerminal();
      const deps = makeDeps(term);
      const controller = createPageController(deps);
      controller.start();
      controller.receive('{"t":"size","cols":100,"rows":30}');
      deps.fixedSizes.length = 0;

      controller.receive('{"t":"fit"}');

      expect(deps.fixedSizes).toEqual([{ cols: 100, rows: 30 }]);
    });

    it("ignores a size message with a non-number cols/rows", () => {
      const term = makeFakeTerminal();
      const deps = makeDeps(term);
      const controller = createPageController(deps);
      controller.start();
      deps.posted.length = 0;

      controller.receive('{"t":"size","cols":"100","rows":30}');

      expect(deps.fixedSizes).toEqual([]);
      expect(deps.posted).toEqual([]);
    });
  });

  // Bug 9: xterm 6 dropped native touch scrolling — the page does it itself
  // via touchStart/touchMove/touchEnd, driven by the WebView's raw touch
  // deltas (dy in px, lineHeightPx() from the fake deps standing in for
  // the real font metrics).
  describe("touch scrolling (bug 9)", () => {
    it("a drag of exactly N line-heights scrolls N lines in the normal buffer", () => {
      const term = makeFakeTerminal();
      const deps = makeDeps(term);
      const controller = createPageController(deps);
      controller.start();

      controller.touchStart();
      controller.touchMove(-60); // finger moves up 3 line-heights (20px each)

      expect(term.scrolls).toEqual([1, 1, 1]);
    });

    it("dragging down scrolls up (toward scrollback), content follows the finger", () => {
      const term = makeFakeTerminal();
      const deps = makeDeps(term);
      const controller = createPageController(deps);
      controller.start();

      controller.touchStart();
      controller.touchMove(40); // finger moves down 2 line-heights

      expect(term.scrolls).toEqual([-1, -1]);
    });

    it("a sub-line-height drag scrolls nothing yet, and a tap (no movement) scrolls nothing", () => {
      const term = makeFakeTerminal();
      const deps = makeDeps(term);
      const controller = createPageController(deps);
      controller.start();

      controller.touchStart();
      controller.touchMove(-5);
      controller.touchEnd();

      controller.touchStart();
      controller.touchMove(0);
      controller.touchEnd();

      expect(term.scrolls).toEqual([]);
    });

    it("accumulates a drag across several touchMove calls", () => {
      const term = makeFakeTerminal();
      const deps = makeDeps(term);
      const controller = createPageController(deps);
      controller.start();

      controller.touchStart();
      controller.touchMove(-15); // 15px: under one line-height (20px), no scroll yet
      controller.touchMove(-15); // 30px total: one line-height, 10px left over
      controller.touchMove(-15); // 45px total: a second line-height, 5px left over

      expect(term.scrolls).toEqual([1, 1]);
    });

    it("touchEnd drops any leftover sub-line-height remainder", () => {
      const term = makeFakeTerminal();
      const deps = makeDeps(term);
      const controller = createPageController(deps);
      controller.start();

      controller.touchStart();
      controller.touchMove(-15);
      controller.touchEnd();
      controller.touchStart();
      controller.touchMove(-15); // would have completed the drag if carried over

      expect(term.scrolls).toEqual([]);
    });

    it("in the alternate buffer with mouse tracking on, emits a wheel message instead of scrolling", () => {
      const term = makeFakeTerminal();
      term.setBufferType("alternate");
      term.setMouseTrackingMode("vt200");
      const deps = makeDeps(term);
      const controller = createPageController(deps);
      controller.start();
      deps.posted.length = 0;

      controller.touchStart();
      controller.touchMove(-20);

      expect(term.scrolls).toEqual([]);
      expect(deps.posted).toEqual([{ t: "wheel", direction: "down" }]);
    });

    it("in the alternate buffer without mouse tracking, does nothing at all", () => {
      const term = makeFakeTerminal();
      term.setBufferType("alternate");
      const deps = makeDeps(term);
      const controller = createPageController(deps);
      controller.start();
      deps.posted.length = 0;

      controller.touchStart();
      controller.touchMove(-60);

      expect(term.scrolls).toEqual([]);
      expect(deps.posted).toEqual([]);
    });
  });

  it(
    "no posted message ever contains the written data " +
      "[bite-proof: echo data in modes; the test fails]",
    () => {
      const term = makeFakeTerminal();
      const deps = makeDeps(term);
      const controller = createPageController(deps);
      controller.start();
      deps.posted.length = 0;

      const secret = "TOP_SECRET_PTY_OUTPUT";
      term.setApplicationCursor(true);
      controller.receive(JSON.stringify({ t: "write", data: secret }));

      for (const message of deps.posted) {
        expect(JSON.stringify(message)).not.toContain(secret);
      }
    },
  );
});

describe("selection (wide layout, fix round 1)", () => {
  it("posts the selection's text when it changes, once per change", () => {
    const term = makeFakeTerminal();
    const deps = makeDeps(term);
    const controller = createPageController(deps);
    controller.start();
    deps.posted.length = 0;

    term.setSelection("hello");
    controller.selectionChanged();
    controller.selectionChanged();
    term.setSelection("");
    controller.selectionChanged();

    expect(deps.posted).toEqual([
      { t: "selection", text: "hello" },
      { t: "selection", text: "" },
    ]);
  });

  it("cuts a selection to the protocol's limit, so the app accepts it", () => {
    const term = makeFakeTerminal();
    term.setSelection("y".repeat(MAX_SELECTION_CHARS + 50));
    const raw: string[] = [];
    const deps = { ...makeDeps(term), post: (text: string) => raw.push(text) };
    createPageController(deps).selectionChanged();
    expect(raw).toHaveLength(1);
    expect(parsePageMessage(raw[0])).toEqual({
      t: "selection",
      text: "y".repeat(MAX_SELECTION_CHARS),
    });
  });

  it('receive({"t":"clearSelection"}) clears the terminal\'s selection', () => {
    const term = makeFakeTerminal();
    const controller = createPageController(makeDeps(term));
    term.setSelection("abc");
    controller.receive(JSON.stringify({ t: "clearSelection" }));
    expect(term.clearedSelections).toBe(1);
    expect(term.getSelection()).toBe("");
  });
});
