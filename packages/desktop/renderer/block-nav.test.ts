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

  let collapsed = false;
  return {
    element,
    record,
    // A stand-in for the real one: structured like the header block-view
    // builds, with a control that actually acts on this view.
    createHeader: () => {
      const built = document.createElement("div");
      built.className = "block-header";
      const commandEl = document.createElement("span");
      commandEl.className = "block-command";
      commandEl.textContent = command;
      const collapse = document.createElement("span");
      collapse.className = "block-collapse";
      collapse.textContent = collapsed ? "▸" : "▾";
      collapse.addEventListener("click", () => {
        collapsed = !collapsed;
        collapse.textContent = collapsed ? "▸" : "▾";
      });
      built.append(commandEl, collapse);
      return built;
    },
    setSelected: (selected: boolean) => element.classList.toggle("selected", selected),
    collapse: (next: boolean) => {
      collapsed = next;
    },
    isCollapsed: () => collapsed,
    text: () => `${command}\n${output}`,
    explain: () => {},
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

// What clicking a block's header does — the pointer route to the selection
// the palette's copy and re-run actions work on.
describe("selecting one block directly", () => {
  it("selects the block it is given, and unselects the previous one", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0), fakeView("b", 0)];
    n.sync(views);

    n.select(views[1] as BlockView);
    expect(n.selected()).toBe(views[1]);
    expect(views[1]?.element.classList.contains("selected")).toBe(true);

    n.select(views[0] as BlockView);
    expect(n.selected()).toBe(views[0]);
    expect(views[1]?.element.classList.contains("selected")).toBe(false);
  });

  // A block a filter is hiding is not something the user can have clicked,
  // and a selection they cannot see is not a selection — the same rule
  // applyFilter() already follows when a filter hides the selected block.
  it("ignores a block this nav does not know, or one a filter is hiding", () => {
    const { nav: n } = nav();
    const views = [fakeView("ok", 0), fakeView("bad", 1)];
    n.sync(views);
    n.toggleFailedFilter();

    n.select(views[0] as BlockView);
    expect(n.selected()).toBeUndefined();

    n.select(fakeView("stranger", 0));
    expect(n.selected()).toBeUndefined();
  });
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

  // Distinct from "clears the selection ... when its block is dropped"
  // above: this drops the selection through toggleFailedFilter() directly,
  // not through sync() — applyFilter()'s own clearing path, not select()'s.
  it("clears a selection directly, by toggling the failed filter over it, not only via sync", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0), fakeView("b", 1)];
    n.sync(views);
    n.move(1); // selects the first visible block: "a"
    expect(n.selected()).toBe(views[0]);

    n.toggleFailedFilter(); // hides "a" (ok)
    expect(n.selected()).toBeUndefined();
    expect(views[0]?.element.classList.contains("selected")).toBe(false);
  });

  // Same shape, over filterToCommand() instead of the failed filter.
  it("clears a selection directly, by filtering to a different command over it", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0), fakeView("b", 0)];
    n.sync(views);
    n.move(1); // selects "a"
    expect(n.selected()).toBe(views[0]);

    n.filterToCommand("b"); // hides "a"
    expect(n.selected()).toBeUndefined();
    expect(views[0]?.element.classList.contains("selected")).toBe(false);
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

  it("clears the selection, and its .selected class, when its block is dropped", () => {
    const { nav: n } = nav();
    const views = [fakeView("a", 0), fakeView("b", 0)];
    n.sync(views);
    n.move(1);
    n.move(1);
    expect(n.selected()).toBe(views[1]);

    n.sync([views[0]!]);
    expect(n.selected()).toBeUndefined();
    // Not just the return value of selected(): the dropped block's own
    // element must lose the class too, or a re-added block (or a stray
    // caller reading the DOM directly) would find it still marked selected.
    expect(views[1]?.element.classList.contains("selected")).toBe(false);
  });

  it("applies the active filter to newly synced blocks", () => {
    const { nav: n } = nav();
    n.sync([fakeView("a", 0)]);
    n.toggleFailedFilter();

    const fresh = fakeView("b", 0);
    n.sync([...(n.selected() ? [n.selected()!] : []), fresh]);
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
    // The block's own header, built for this purpose — not its textContent
    // flattened into one run ("a✓2.4s~/p▾⧉↻⋯") with dead glyphs where the
    // actions should be.
    expect(sticky.querySelector(".block-command")?.textContent).toBe("a");
    expect(sticky.querySelector(".block-collapse")).not.toBeNull();
  });

  // The whole point of the rebuild: the controls in the sticky header are
  // the block's own, so clicking one acts on the block it is standing in
  // for rather than doing nothing at all.
  it("acts on the block it stands in for", () => {
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

    sticky.querySelector<HTMLElement>(".block-collapse")?.click();

    expect(a.isCollapsed()).toBe(true);
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

    expect(sticky.querySelector(".block-command")?.textContent).toBe("a");
  });
});

describe("dispose", () => {
  // The sticky header listens on `document`, not on any element this nav
  // was handed — dispose() is the only way to stop it, and without it the
  // listener (and everything it closes over) outlives the pane forever.
  it("stops updating the sticky header once disposed", () => {
    const { list, sticky, nav: n } = nav();
    const container = document.createElement("div");
    container.append(sticky, list);
    document.body.append(container);
    container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;

    const a = fakeView("a", 0);
    const b = fakeView("b", 0);
    list.append(a.element, b.element);
    n.sync([a, b]);

    // Scrolled past "a" only: the listener works, same as the plain sticky
    // header tests above.
    a.element.getBoundingClientRect = () => ({ top: -40 }) as DOMRect;
    b.element.getBoundingClientRect = () => ({ top: 20 }) as DOMRect;
    container.dispatchEvent(new Event("scroll"));
    expect(sticky.querySelector(".block-command")?.textContent).toBe("a");

    // Now scrolled past both — if the listener still ran, this would flip
    // the header to "b". dispose() first, so it must not.
    n.dispose();
    b.element.getBoundingClientRect = () => ({ top: -10 }) as DOMRect;
    container.dispatchEvent(new Event("scroll"));

    expect(sticky.querySelector(".block-command")?.textContent).toBe("a");
  });

  it("does not throw when called twice", () => {
    const { nav: n } = nav();
    n.dispose();
    expect(() => n.dispose()).not.toThrow();
  });
});
