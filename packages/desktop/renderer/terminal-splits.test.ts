// @vitest-environment jsdom
//
// The tree of panes behind a split terminal tab. Every leaf is a whole
// terminal pane, so the panes themselves are doubled here — what is under
// test is the tree: which pane has focus, what a split does to the DOM,
// and above all that a pane that goes away takes its shell with it. A
// shell that outlives its pane is a real orphan process on the user's
// machine, which is why the kill is asserted on rather than assumed.
//
// jsdom computes no layout, so nothing here claims to verify how a split
// looks. The divider tests assert what the drag *writes* — a flex-basis
// derived from where the pointer is — and leave the rest to a real window.
import { beforeEach, describe, expect, it } from "vitest";
import type { TerminalPane } from "./terminal-pane.js";
import { createSplitTree, type SplitTree } from "./terminal-splits.js";

type FakePane = {
  key: string;
  host: HTMLElement;
  focuses: number;
  refits: number;
  disposed: boolean;
  pane: TerminalPane;
};

let made: FakePane[];
let killed: string[];

function makePane(key: string, host: HTMLElement): TerminalPane {
  // What a real pane puts inside its host, so the tests can see that a
  // disposed pane took its DOM with it.
  const drawn = document.createElement("div");
  drawn.className = "terminal-pane";
  host.append(drawn);

  const fake: Partial<FakePane> = { key, host, focuses: 0, refits: 0, disposed: false };
  const pane = {
    element: drawn,
    write: () => {},
    focus: () => {
      fake.focuses = (fake.focuses ?? 0) + 1;
    },
    refit: () => {
      fake.refits = (fake.refits ?? 0) + 1;
    },
    dispose: () => {
      fake.disposed = true;
      drawn.remove();
    },
    blocks: () => [],
    blockNav: undefined,
    terminal: undefined,
    readInput: () => undefined,
    applyInput: () => {},
    editorElement: () => undefined,
  } as unknown as TerminalPane;
  fake.pane = pane;
  made.push(fake as FakePane);
  return pane;
}

function tree(host = document.createElement("div")): { tree: SplitTree; host: HTMLElement } {
  document.body.append(host);
  const built = createSplitTree(host, makePane, "tab-1");
  return { tree: built, host };
}

function paneOf(key: string): FakePane {
  const found = made.find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`no pane for ${key}`);
  return found;
}

function keyOf(pane: TerminalPane): string {
  const found = made.find((entry) => entry.pane === pane);
  if (found === undefined) throw new Error("unknown pane");
  return found.key;
}

/** jsdom has no PointerEvent, and the drag only ever reads clientX/clientY
 *  off the event — a MouseEvent under the pointer event's name is exactly
 *  what the listener sees. */
function pointer(target: EventTarget, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
}

describe("the split tree", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    made = [];
    killed = [];
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
      closeTerminalPane: (paneKey: string) => {
        killed.push(paneKey);
        return Promise.resolve();
      },
    };
  });

  // An unsplit tab is exactly today's terminal: one pane, holding the shell
  // keyed by the bare tab id.
  it("starts as the tab's own single pane", () => {
    const { tree: split, host } = tree();

    expect(split.panes()).toHaveLength(1);
    expect(keyOf(split.focused())).toBe("tab-1");
    expect(host.querySelectorAll(".terminal-pane")).toHaveLength(1);
  });

  it("makes a second pane on a split and leaves the focus on it", () => {
    const { tree: split } = tree();

    split.split("row");

    expect(split.panes()).toHaveLength(2);
    expect(keyOf(split.focused())).toBe("tab-1:p1");
    expect(paneOf("tab-1:p1").focuses).toBeGreaterThan(0);
  });

  // Direction is the branch's, not the pane's: the stylesheet lays the two
  // out, and this module measures nothing.
  it("lays the two out along the direction it was given", () => {
    const { tree: split, host } = tree();

    split.split("column");

    const branch = host.querySelector<HTMLElement>(".terminal-split-branch");
    expect(branch?.style.flexDirection).toBe("column");
    expect(branch?.querySelectorAll(".terminal-split-divider")).toHaveLength(1);
  });

  it("splits the focused pane rather than the first one", () => {
    const { tree: split } = tree();
    split.split("row"); // focus is on p1
    split.split("column"); // so p2 lands beside p1

    expect(split.panes().map(keyOf)).toEqual(["tab-1", "tab-1:p1", "tab-1:p2"]);
    expect(keyOf(split.focused())).toBe("tab-1:p2");
  });

  it("keeps the focus on exactly one pane", () => {
    const { tree: split, host } = tree();
    split.split("row");

    split.focus(-1);

    expect(host.querySelectorAll(".terminal-split-leaf.focused")).toHaveLength(1);
    expect(keyOf(split.focused())).toBe("tab-1");
  });

  it("wraps as the focus moves off either end", () => {
    const { tree: split } = tree();
    split.split("row");

    split.focus(1);
    expect(keyOf(split.focused())).toBe("tab-1");

    split.focus(-1);
    expect(keyOf(split.focused())).toBe("tab-1:p1");
  });

  it("focuses the pane the user points at", () => {
    const { tree: split } = tree();
    split.split("row");

    pointer(paneOf("tab-1").host, "pointerdown", 10, 10);

    expect(keyOf(split.focused())).toBe("tab-1");
  });

  // The one that leaks child processes when it is wrong.
  it("disposes the closed pane and kills its shell", () => {
    const { tree: split, host } = tree();
    split.split("row");

    const closed = split.closeFocused();

    expect(closed).toBe(true);
    expect(paneOf("tab-1:p1").disposed).toBe(true);
    expect(killed).toEqual(["tab-1:p1"]);
    expect(host.querySelectorAll(".terminal-pane")).toHaveLength(1);
  });

  it("kills the tab's own shell when the tab's own pane is the one closed", () => {
    const { tree: split } = tree();
    split.split("row");
    split.focus(1); // back to the tab's own pane

    split.closeFocused();

    expect(killed).toEqual(["tab-1"]);
    expect(split.panes().map(keyOf)).toEqual(["tab-1:p1"]);
  });

  it("moves the focus to a surviving pane", () => {
    const { tree: split } = tree();
    split.split("row");

    split.closeFocused();

    expect(keyOf(split.focused())).toBe("tab-1");
    expect(paneOf("tab-1").focuses).toBeGreaterThan(0);
  });

  // Collapsing matters: a branch left holding one pane would keep a
  // divider the user could still drag against nothing.
  it("collapses the branch a closed pane leaves behind", () => {
    const { tree: split, host } = tree();
    split.split("row");

    split.closeFocused();

    expect(host.querySelectorAll(".terminal-split-divider")).toHaveLength(0);
    expect(host.querySelectorAll(".terminal-split-leaf")).toHaveLength(1);
  });

  // The caller closes the tab when this says false — an unsplit tab must
  // never end up as an empty pane with nothing in it.
  it("refuses to close the last pane, and kills nothing", () => {
    const { tree: split } = tree();

    const closed = split.closeFocused();

    expect(closed).toBe(false);
    expect(paneOf("tab-1").disposed).toBe(false);
    expect(killed).toEqual([]);
  });

  it("disposes every pane when the tab goes away, leaving the shells to main", () => {
    const { tree: split, host } = tree();
    split.split("row");
    split.split("column");

    split.dispose();

    expect(made.every((entry) => entry.disposed)).toBe(true);
    expect(host.querySelectorAll(".terminal-pane")).toHaveLength(0);
    // close(tabId) in main reaps the whole subtree; killing them here as
    // well would be a second kill for every pane.
    expect(killed).toEqual([]);
  });

  // jsdom lays nothing out, so what this can honestly assert is that the
  // drag writes a basis taken from where the pointer is. Whether that
  // basis produces the column widths the user dragged to is a real
  // window's business.
  it("sets a flex-basis on the pane before the divider as it is dragged", () => {
    const { tree: split, host } = tree();
    split.split("row");
    const divider = host.querySelector(".terminal-split-divider");
    if (divider === null) throw new Error("expected a divider");

    pointer(divider, "pointerdown", 400, 10);
    pointer(window, "pointermove", 300, 10);

    expect(paneOf("tab-1").host.style.flexBasis).toBe("300px");
    expect(paneOf("tab-1").host.style.flexGrow).toBe("0");
  });

  it("stops following the pointer once the drag ends, and refits every pane", () => {
    const { tree: split, host } = tree();
    split.split("row");
    const divider = host.querySelector(".terminal-split-divider");
    if (divider === null) throw new Error("expected a divider");
    pointer(divider, "pointerdown", 400, 10);
    pointer(window, "pointermove", 300, 10);
    const before = made.map((entry) => entry.refits);

    pointer(window, "pointerup", 300, 10);
    pointer(window, "pointermove", 120, 10);

    expect(paneOf("tab-1").host.style.flexBasis).toBe("300px");
    expect(made.map((entry) => entry.refits)).toEqual(before.map((count) => count + 1));
  });

  // A pointerup is not the only way a drag ends, and it is not even the
  // reliable one: a button released outside the Electron window delivers no
  // pointerup to the page at all. Without a capture (and something to catch
  // its loss) the drag stayed live — the divider went on following a cursor
  // with no button held, resizing panes on hover, for good, with the window
  // listeners leaked and the branch's panes and xterms retained.
  it("ends the drag when the pointer capture is lost rather than released", () => {
    const { tree: split, host } = tree();
    split.split("row");
    const divider = host.querySelector(".terminal-split-divider");
    if (divider === null) throw new Error("expected a divider");
    pointer(divider, "pointerdown", 400, 10);
    pointer(window, "pointermove", 300, 10);

    divider.dispatchEvent(new Event("lostpointercapture"));
    pointer(window, "pointermove", 120, 10);

    expect(paneOf("tab-1").host.style.flexBasis).toBe("300px");
  });

  it("ends the drag when the pointer is cancelled", () => {
    const { tree: split, host } = tree();
    split.split("row");
    const divider = host.querySelector(".terminal-split-divider");
    if (divider === null) throw new Error("expected a divider");
    pointer(divider, "pointerdown", 400, 10);
    pointer(window, "pointermove", 300, 10);

    pointer(window, "pointercancel", 300, 10);
    pointer(window, "pointermove", 120, 10);

    expect(paneOf("tab-1").host.style.flexBasis).toBe("300px");
  });

  // A tab closed with the button still down: the drag's listeners live on
  // the window and would otherwise outlive every element they act on.
  it("takes a drag in progress down with the tree", () => {
    const { tree: split, host } = tree();
    split.split("row");
    const divider = host.querySelector(".terminal-split-divider");
    if (divider === null) throw new Error("expected a divider");
    pointer(divider, "pointerdown", 400, 10);
    pointer(window, "pointermove", 300, 10);
    const pane = paneOf("tab-1").host;

    split.dispose();
    pointer(window, "pointermove", 120, 10);

    expect(pane.style.flexBasis).toBe("300px");
  });

  // A drag that would leave one side too narrow to be a terminal is
  // clamped rather than obeyed.
  it("keeps a dragged pane wide enough to be a terminal", () => {
    const { tree: split, host } = tree();
    split.split("row");
    const divider = host.querySelector(".terminal-split-divider");
    if (divider === null) throw new Error("expected a divider");

    pointer(divider, "pointerdown", 400, 10);
    pointer(window, "pointermove", 2, 10);

    expect(paneOf("tab-1").host.style.flexBasis).toBe("80px");
  });

  // Nothing in the split machinery may throw into a terminal: a pane that
  // cannot be built leaves the tab exactly as it was.
  it("leaves the tree alone when a new pane cannot be built", () => {
    const host = document.createElement("div");
    document.body.append(host);
    let first = true;
    const split = createSplitTree(
      host,
      (key, paneHost) => {
        if (first) {
          first = false;
          return makePane(key, paneHost);
        }
        throw new Error("no terminal today");
      },
      "tab-1",
    );

    expect(() => split.split("row")).not.toThrow();
    expect(split.panes()).toHaveLength(1);
    expect(keyOf(split.focused())).toBe("tab-1");
    // And nothing half-built left behind: the surviving pane is back where
    // it was, with no branch and no empty leaf around it.
    expect(host.querySelectorAll(".terminal-split-branch")).toHaveLength(0);
    expect(host.querySelectorAll(".terminal-split-leaf")).toHaveLength(1);
    expect(host.querySelector(".terminal-split")?.firstElementChild).toBe(paneOf("tab-1").host);
  });
});

// The tab's sidebar follows whichever pane has the focus, and only the
// tree knows when that changes — a split, a close, an ⌥⌘arrow or a click
// on another pane all move it.
describe("telling its owner which pane has the focus", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    made = [];
    killed = [];
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
      closeTerminalPane: () => Promise.resolve(),
    };
  });

  function watched(onFocus?: (key: string) => void): { tree: SplitTree; focused: string[] } {
    const host = document.createElement("div");
    document.body.append(host);
    const focused: string[] = [];
    const built = createSplitTree(
      host,
      makePane,
      "tab-1",
      onFocus ?? ((key) => focused.push(key)),
    );
    return { tree: built, focused };
  }

  it("names the pane a split moved the focus to", () => {
    const { tree: split, focused } = watched();

    split.split("row");

    expect(focused).toEqual(["tab-1:p1"]);
  });

  it("names the pane the focus moves back to", () => {
    const { tree: split, focused } = watched();
    split.split("row");

    split.focus(-1);

    expect(focused).toEqual(["tab-1:p1", "tab-1"]);
  });

  it("names the pane that survives a close", () => {
    const { tree: split, focused } = watched();
    split.split("row");

    split.closeFocused();

    expect(focused).toEqual(["tab-1:p1", "tab-1"]);
  });

  // Nothing may throw into a terminal: a hook that does is the owner's
  // problem, never a focus that fails to move.
  it("moves the focus even when the hook throws", () => {
    const { tree: split } = watched(() => {
      throw new Error("no");
    });

    expect(() => split.split("row")).not.toThrow();
    expect(keyOf(split.focused())).toBe("tab-1:p1");
  });
});
