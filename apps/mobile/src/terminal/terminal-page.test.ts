import { describe, expect, it } from "vitest";
import { createPageController, type PageDeps, type PageTerminal } from "./terminal-page";

function makeFakeTerminal(overrides?: Partial<PageTerminal>): PageTerminal & {
  written: string[];
  resetCount: number;
  setSize(cols: number, rows: number): void;
  setApplicationCursor(value: boolean): void;
} {
  let cols = 80;
  let rows = 24;
  let applicationCursorKeysMode = false;
  const written: string[] = [];
  let resetCount = 0;

  return {
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
    get modes() {
      return { applicationCursorKeysMode };
    },
    write(data: string, done: () => void) {
      written.push(data);
      done();
    },
    reset() {
      resetCount += 1;
    },
    written,
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
    ...overrides,
  };
}

function makeDeps(term: PageTerminal): PageDeps & { posted: unknown[]; fitCount: number } {
  const posted: unknown[] = [];
  let fitCount = 0;
  return {
    term,
    fit() {
      fitCount += 1;
    },
    post(text: string) {
      posted.push(JSON.parse(text));
    },
    posted,
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
