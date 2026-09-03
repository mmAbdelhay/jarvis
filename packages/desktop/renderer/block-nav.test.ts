// @vitest-environment jsdom
// packages/desktop/renderer/block-nav.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import type { BlockRecord } from "./terminal-blocks.js";
import type { BlockView } from "./block-view.js";
import { createBlockNav } from "./block-nav.js";

let nextId = 1;

/** A minimal stand-in for a real BlockView: an element with a `.block-header`
 *  child (so the sticky-header logic has something to read) and the four
 *  methods block-nav.ts actually calls. */
function fakeView(command: string, exitCode: number | undefined, output = ""): BlockView {
  const element = document.createElement("div");
  element.className = "block";
  element.dataset["status"] = exitCode === 0 ? "ok" : "failed";

  const header = document.createElement("div");
  header.className = "block-header";
  header.textContent = command;
  element.append(header);

  const record: BlockRecord = {
    id: nextId++,
    command,
    output,
    exitCode,
    startedAt: 0,
    endedAt: 100,
    cwd: undefined,
    truncated: false,
  };

  return {
    element,
    record,
    setSelected: (selected: boolean) => element.classList.toggle("selected", selected),
    collapse: () => {},
    isCollapsed: () => false,
    text: () => `${command}\n${output}`,
  };
}

function nav(): { list: HTMLElement; sticky: HTMLElement; nav: ReturnType<typeof createBlockNav> } {
  const list = document.createElement("div");
  const sticky = document.createElement("div");
  document.body.append(list, sticky);
  return { list, sticky, nav: createBlockNav(list, sticky) };
}

beforeEach(() => {
  document.body.replaceChildren();
  nextId = 1;
});

describe("moving the selection", () => {
  it("moves forward and clamps at the last block", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0), fakeView("b", 0), fakeView("c", 0)];
    n.sync(views);

    n.move(1);
    expect(n.selected()).toBe(views[0]);
    n.move(1);
    expect(n.selected()).toBe(views[1]);
    n.move(1);
    expect(n.selected()).toBe(views[2]);
    // One more past the end: stays put, does not wrap to the first.
    n.move(1);
    expect(n.selected()).toBe(views[2]);
  });

  it("moves backward and clamps at the first block", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0), fakeView("b", 0), fakeView("c", 0)];
    n.sync(views);

    n.move(-1);
    expect(n.selected()).toBe(views[2]);
    n.move(-1);
    n.move(-1);
    expect(n.selected()).toBe(views[0]);
    // One more past the start: stays put.
    n.move(-1);
    expect(n.selected()).toBe(views[0]);
  });

  it("does nothing when there are no blocks", () => {
    const { nav: n } = nav();
    n.sync([]);
    n.move(1);
    expect(n.selected()).toBeUndefined();
  });
});

describe("selection marks exactly one block", () => {
  it("clears the previous .selected as it moves to the next", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0), fakeView("b", 0), fakeView("c", 0)];
    n.sync(views);

    n.move(1);
    n.move(1);
    const withSelected = views.filter((v) => v.element.classList.contains("selected"));
    expect(withSelected).toEqual([views[1]]);
  });

  it("clear() removes the selection entirely", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0), fakeView("b", 0)];
    n.sync(views);
    n.move(1);
    n.clear();
    expect(n.selected()).toBeUndefined();
    expect(views[0]?.element.classList.contains("selected")).toBe(false);
  });
});

describe("filtering to failures", () => {
  it("hides ok blocks and restores them on a second toggle", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0), fakeView("b", 1), fakeView("c", 0)];
    n.sync(views);

    n.toggleFailedFilter();
    expect(n.isFiltered()).toBe(true);
    expect(views[0]?.element.hidden).toBe(true);
    expect(views[1]?.element.hidden).toBe(false);
    expect(views[2]?.element.hidden).toBe(true);

    n.toggleFailedFilter();
    expect(n.isFiltered()).toBe(false);
    expect(views.every((v) => !v.element.hidden)).toBe(true);
  });

  it("treats a block with no exit code as a failure, not ok", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0), fakeView("b", undefined)];
    n.sync(views);
    n.toggleFailedFilter();
    expect(views[0]?.element.hidden).toBe(true);
    expect(views[1]?.element.hidden).toBe(false);
  });

  it("only ever moves between visible blocks while filtered", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0), fakeView("b", 1), fakeView("c", 0), fakeView("d", 1)];
    n.sync(views);
    n.toggleFailedFilter();

    n.move(1);
    expect(n.selected()).toBe(views[1]);
    n.move(1);
    expect(n.selected()).toBe(views[3]);
    n.move(1);
    expect(n.selected()).toBe(views[3]); // clamps, does not fall onto a hidden block
  });
});

describe("filtering to one command", () => {
  it("narrows the list to blocks with that exact command", () => {
    const { nav: n } = nav();
    const views = [fakeView("git status", 0), fakeView("pnpm test", 0), fakeView("git status", 1)];
    n.sync(views);

    n.filterToCommand("git status");
    expect(views[0]?.element.hidden).toBe(false);
    expect(views[1]?.element.hidden).toBe(true);
    expect(views[2]?.element.hidden).toBe(false);
    expect(n.isFiltered()).toBe(true);
  });

  it("clicking the same command again clears the filter", () => {
    const { nav: n } = nav();
    const views = [fakeView("git status", 0), fakeView("pnpm test", 0)];
    n.sync(views);

    n.filterToCommand("git status");
    n.filterToCommand("git status");
    expect(n.isFiltered()).toBe(false);
    expect(views.every((v) => !v.element.hidden)).toBe(true);
  });
});

describe("sync", () => {
  it("keeps the selection when the selected block survives", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0), fakeView("b", 0)];
    n.sync(views);
    n.move(1);
    const selected = n.selected();

    n.sync([views[0]!, views[1]!, fakeView("c", 0)]);
    expect(n.selected()).toBe(selected);
  });

  it("clears the selection when its block is dropped", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0), fakeView("b", 0)];
    n.sync(views);
    n.move(1);
    n.move(1);
    expect(n.selected()).toBe(views[1]);

    n.sync([views[0]!]);
    expect(n.selected()).toBeUndefined();
  });

  it("applies the active filter to newly synced blocks", () => {
    const { nav: n } = nav();
    n.sync([fakeView("a", 0)]);
    n.toggleFailedFilter();

    const fresh = fakeView("b", 0);
    n.sync([...n.selected() ? [n.selected()!] : [], fresh]);
    expect(fresh.element.hidden).toBe(true);
  });
});

describe("searchText", () => {
  it("concatenates only the visible blocks", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0, "out-a"), fakeView("b", 1, "out-b"), fakeView("c", 0, "out-c")];
    n.sync(views);
    n.toggleFailedFilter();

    const text = n.searchText();
    expect(text).toContain("out-b");
    expect(text).not.toContain("out-a");
    expect(text).not.toContain("out-c");
  });

  it("includes every block once unfiltered", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0, "out-a"), fakeView("b", 0, "out-b")];
    n.sync(views);
    expect(n.searchText()).toContain("out-a");
    expect(n.searchText()).toContain("out-b");
  });
});

describe("findText — the find bar's fallback over frozen blocks", () => {
  it("finds a match by output text, case-insensitively, and flags the block", () => {
    const { nav: n } = nav();
    const a = fakeView("a", 0, "nothing here");
    const b = fakeView("b", 0, "42 PASSED");
    n.sync([a, b]);

    expect(n.findText("passed")).toBe(true);
    expect(b.element.classList.contains("found")).toBe(true);
    expect(a.element.classList.contains("found")).toBe(false);
  });

  it("reports no match rather than throwing", () => {
    const { nav: n } = nav();
    n.sync([fakeView("a", 0, "nothing here")]);
    expect(n.findText("nope")).toBe(false);
  });

  it("never matches a block hidden by the failed filter", () => {
    const { nav: n } = nav();
    const a = fakeView("a", 0, "42 passed");
    n.sync([a]);
    n.toggleFailedFilter(); // hides a (ok)
    expect(n.findText("passed")).toBe(false);
  });
});

describe("the sticky header", () => {
  it("shows the topmost scrolled-past block's header text once past it", () => {
    const { list, sticky, nav: n } = nav();
    const container = document.createElement("div");
    container.append(sticky, list);
    document.body.append(container);
    container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;

    const a = fakeView("a", 0);
    const b = fakeView("b", 0);
    list.append(a.element, b.element);
    n.sync([a, b]);

    a.element.getBoundingClientRect = () => ({ top: -40 }) as DOMRect;
    b.element.getBoundingClientRect = () => ({ top: 20 }) as DOMRect;

    container.dispatchEvent(new Event("scroll"));

    expect(sticky.hidden).toBe(false);
    expect(sticky.textContent).toBe("a");
  });

  it("hides itself when no block has scrolled past the top yet", () => {
    const { list, sticky, nav: n } = nav();
    const container = document.createElement("div");
    container.append(sticky, list);
    document.body.append(container);
    container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;

    const a = fakeView("a", 0);
    list.append(a.element);
    n.sync([a]);
    a.element.getBoundingClientRect = () => ({ top: 30 }) as DOMRect;

    container.dispatchEvent(new Event("scroll"));

    expect(sticky.hidden).toBe(true);
  });

  it("never picks a filtered-out block for the sticky header", () => {
    const { list, sticky, nav: n } = nav();
    const container = document.createElement("div");
    container.append(sticky, list);
    document.body.append(container);
    container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;

    const a = fakeView("a", 1);
    const b = fakeView("b", 0);
    list.append(a.element, b.element);
    n.sync([a, b]);
    n.toggleFailedFilter(); // hides b (ok)

    a.element.getBoundingClientRect = () => ({ top: -40 }) as DOMRect;
    b.element.getBoundingClientRect = () => ({ top: -40 }) as DOMRect;

    container.dispatchEvent(new Event("scroll"));

    expect(sticky.textContent).toBe("a");
  });
});
