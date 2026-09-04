// A terminal tab's panes, as a tree.
//
// A tab used to hold exactly one shell. It now holds a tree whose leaves
// are whole terminal panes — their own blocks, their own editor, their own
// autocomplete, nothing lesser for being in a split — and whose branches
// are a horizontal or vertical division with a draggable divider between
// the two sides.
//
// The main process needed almost nothing for this, and that is the design:
// ShellManager is keyed by an arbitrary string, so a leaf's shell is just
// another key, "<tabId>:<paneId>". The tab's own first pane keeps the bare
// tab id, which is what makes an unsplit tab behave exactly as it did
// before this file existed.
//
// Who starts and who kills: the caller's `makePane` starts the pane's
// shell, because the shell has to exist before the pane can attach to it,
// and a pane attaches as it is built. Killing is this module's, because
// only the tree knows when a pane has stopped existing — and a shell that
// outlives its pane is a real orphan process on the user's machine.
// Disposing the whole tree kills nothing: the tab is closing, and main's
// own close(tabId) reaps the tab and every split under it in one go.

import type { TerminalPane } from "./terminal-pane.js";

export type SplitTree = {
  element: HTMLElement;
  /** Splits the focused pane in two and moves the focus to the new one. */
  split(direction: "row" | "column"): void;
  /** Closes the focused pane and kills its shell. False when it was the
   *  last pane — nothing is closed, and the caller closes the tab. */
  closeFocused(): boolean;
  /** Moves the focus one pane on, wrapping at either end. */
  focus(delta: -1 | 1): void;
  focused(): TerminalPane;
  /** Every pane, in the order they are laid out. */
  panes(): readonly TerminalPane[];
  dispose(): void;
};

/** How narrow a dragged pane may get. Below this a terminal is no longer
 *  one — the divider stops rather than following the pointer. */
const MIN_PANE_PX = 80;

type Leaf = { kind: "leaf"; key: string; element: HTMLElement; pane: TerminalPane };
type Branch = {
  kind: "branch";
  direction: "row" | "column";
  element: HTMLElement;
  /** Always exactly two: a split divides one pane, and a branch left
   *  holding one child collapses into it. */
  children: [Node, Node];
};
type Node = Leaf | Branch;

/** Nothing in the split machinery is worth taking a terminal down for —
 *  the same discipline terminal-pane.ts and terminal-addons.ts follow. */
function attempt(work: () => void): void {
  try {
    work();
  } catch {
    // The terminal is untouched.
  }
}

/**
 * The tree for one terminal tab.
 *
 * `makePane(paneKey, host)` builds a whole pane inside `host` and is the
 * caller's business entirely: this module never knows what a pane is made
 * of, only where it sits and which one has the focus.
 */
export function createSplitTree(
  host: HTMLElement,
  makePane: (paneKey: string, host: HTMLElement) => TerminalPane,
  tabId: string,
): SplitTree {
  const element = document.createElement("div");
  element.className = "terminal-split";
  host.append(element);

  /** Each node's parent, for the two operations that need to walk up. The
   *  root is simply absent from it. */
  const parents = new Map<Node, Branch>();
  /** Pane ids never come round again, even after a close: a reused key
   *  would be a second shell under a name main still remembers. */
  let nextPaneId = 0;

  const leafElement = (): HTMLElement => {
    const created = document.createElement("div");
    created.className = "terminal-split-leaf";
    return created;
  };

  /** Builds the pane for an element that is already where it belongs in
   *  the document — xterm measures the element it is opened in, and one
   *  outside the document measures nothing at all. */
  const makeLeafIn = (key: string, host: HTMLElement): Leaf => {
    const leaf: Leaf = { kind: "leaf", key, element: host, pane: makePane(key, host) };
    // The pane you point at is the pane ⌘W closes and the one the app
    // considers focused — anything else would close a terminal the user
    // was not looking at.
    host.addEventListener("pointerdown", () => focusLeaf(leaf));
    return leaf;
  };

  // The tab's own pane, keyed by the bare tab id: an unsplit tab is one
  // leaf, and every one of its shell keys is what it was before splits.
  const firstElement = leafElement();
  element.append(firstElement);
  const first = makeLeafIn(tabId, firstElement);
  first.element.classList.add("focused");
  let root: Node = first;
  /** The focused leaf. Exactly one, always — every path that changes it
   *  goes through focusLeaf. */
  let current: Leaf = first;

  const leaves = (node: Node = root): Leaf[] =>
    node.kind === "leaf" ? [node] : [...leaves(node.children[0]), ...leaves(node.children[1])];

  const focusLeaf = (leaf: Leaf): void => {
    current = leaf;
    for (const other of leaves()) other.element.classList.toggle("focused", other === leaf);
    attempt(() => leaf.pane.focus());
  };

  const refitAll = (): void => {
    for (const leaf of leaves()) attempt(() => leaf.pane.refit());
  };

  /** Undoes a divider drag on a node about to be laid out afresh. */
  const resetSize = (node: Node): void => {
    node.element.style.flexBasis = "";
    node.element.style.flexGrow = "";
  };

  const makeDivider = (branch: Branch): HTMLElement => {
    const divider = document.createElement("div");
    divider.className = "terminal-split-divider";
    divider.dataset["direction"] = branch.direction;
    divider.setAttribute("role", "separator");
    divider.addEventListener("pointerdown", (event) => startDrag(branch, divider, event));
    return divider;
  };

  /** The drag currently in progress, if any — its own `stop`. Held so a
   *  tree disposed mid-drag (a tab closed with the button still down) takes
   *  its window listeners with it instead of leaving them, and everything
   *  they close over, alive for the life of the process. */
  let stopDrag: (() => void) | undefined;

  /**
   * The divider drag. The size goes on the child before the divider — the
   * one after it keeps growing into whatever is left — so a drag writes one
   * flex-basis and the browser lays out the rest.
   *
   * The listeners live on the window rather than on the divider, so a
   * pointer that leaves the thin divider mid-drag (which it does
   * immediately) goes on being followed — and the divider *captures* the
   * pointer, which is what makes that true outside the window as well.
   * Without the capture, a button released past the edge of the Electron
   * window never delivered a pointerup here at all: the drag stayed live,
   * the divider went on following a cursor with no button held, and every
   * pane it passed over was resized on hover, permanently, with the
   * listeners leaked and the branch's panes and xterms retained.
   */
  const startDrag = (branch: Branch, divider: HTMLElement, event: PointerEvent): void => {
    event.preventDefault();
    // A second pointerdown before the first drag ended (a second finger, a
    // capture that never arrived) ends the first rather than stacking.
    stopDrag?.();
    attempt(() => divider.setPointerCapture(event.pointerId));

    const move = (moveEvent: MouseEvent): void => {
      // Read afresh on every move: a collapsing branch below this one can
      // put a different node on this side between two pointer events.
      const first = branch.children[0];
      const box = branch.element.getBoundingClientRect();
      const horizontal = branch.direction === "row";
      const total = horizontal ? box.width : box.height;
      const offset = horizontal ? moveEvent.clientX - box.left : moveEvent.clientY - box.top;
      // Neither side may be dragged below MIN_PANE_PX. An element with no
      // measured size (a pane that has not been laid out yet) has no upper
      // bound to enforce, only the lower one.
      const upper = total > MIN_PANE_PX * 2 ? total - MIN_PANE_PX : Number.POSITIVE_INFINITY;
      first.element.style.flexBasis = `${Math.min(Math.max(offset, MIN_PANE_PX), upper)}px`;
      first.element.style.flexGrow = "0";
    };

    const stop = (): void => {
      if (stopDrag !== stop) return; // Already stopped; nothing to undo twice.
      stopDrag = undefined;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      divider.removeEventListener("lostpointercapture", stop);
      attempt(() => divider.releasePointerCapture(event.pointerId));
      // The cell grid changed under both panes: xterm only learns that
      // from a fit, and each pane's own refit guards its zero-size case.
      refitAll();
    };

    stopDrag = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    // Every other way a drag can end: the pointer cancelled (a touch turned
    // into a scroll, the device gone), or the capture lost for any reason
    // at all — including the window losing focus mid-drag, which is exactly
    // the case a bare pointerup never covered.
    window.addEventListener("pointercancel", stop);
    divider.addEventListener("lostpointercapture", stop);
  };

  /** Puts `replacement` where `node` sits — in the tree and in the DOM. */
  const replace = (node: Node, replacement: Node): void => {
    const parent = parents.get(node);
    node.element.parentElement?.replaceChild(replacement.element, node.element);
    if (parent === undefined) {
      root = replacement;
      parents.delete(replacement);
      return;
    }
    parent.children[parent.children[0] === node ? 0 : 1] = replacement;
    parents.set(replacement, parent);
  };

  return {
    element,

    split(direction) {
      const target = current;
      const branchElement = document.createElement("div");
      branchElement.className = "terminal-split-branch";
      branchElement.style.flexDirection = direction;
      const created = leafElement();

      // The DOM before the pane, so the new pane is built in an element
      // that is already on screen. Both sides share the branch afresh,
      // whatever an earlier drag left on the pane being split.
      const at = target.element.parentElement;
      at?.replaceChild(branchElement, target.element);
      resetSize(target);
      branchElement.append(target.element, created);

      let leaf: Leaf;
      try {
        leaf = makeLeafIn(`${tabId}:p${(nextPaneId += 1)}`, created);
      } catch {
        // A pane that could not be built leaves the tab exactly as it was,
        // down to where the pane being split sits in the document.
        created.remove();
        branchElement.parentElement?.replaceChild(target.element, branchElement);
        return;
      }

      const branch: Branch = {
        kind: "branch",
        direction,
        element: branchElement,
        children: [target, leaf],
      };
      branchElement.insertBefore(makeDivider(branch), created);

      const above = parents.get(target);
      if (above === undefined) root = branch;
      else {
        above.children[above.children[0] === target ? 0 : 1] = branch;
        parents.set(branch, above);
      }
      parents.set(target, branch);
      parents.set(leaf, branch);

      focusLeaf(leaf);
      refitAll();
    },

    closeFocused() {
      const target = current;
      const parent = parents.get(target);
      // No parent is no sibling: this is the tab's only pane, and closing
      // it is the tab's own business, not this tree's.
      if (parent === undefined) return false;

      const order = leaves();
      const index = order.indexOf(target);
      const sibling = parent.children[0] === target ? parent.children[1] : parent.children[0];

      resetSize(sibling);
      replace(parent, sibling);
      parents.delete(target);
      parents.delete(parent);
      attempt(() => target.pane.dispose());
      target.element.remove();
      // The pane is gone; its shell must go with it.
      // .catch on top of attempt(): attempt only catches a *synchronous*
      // throw, and this is the orphan-shell path (the design's Risk 4) —
      // an unhandled rejection here would be the only signal that a shell
      // outlived its pane, delivered as a console error nobody reads.
      attempt(() => void window.jarvis.closeTerminalPane(target.key).catch(() => {}));

      const remaining = leaves();
      // The pane that took its place on screen, or the last one when the
      // closed pane was itself the last.
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next !== undefined) focusLeaf(next);
      refitAll();
      return true;
    },

    focus(delta) {
      const order = leaves();
      if (order.length === 0) return;
      const index = order.indexOf(current);
      const next = order[(index + delta + order.length) % order.length];
      if (next !== undefined) focusLeaf(next);
    },

    focused: () => current.pane,

    panes: () => leaves().map((leaf) => leaf.pane),

    dispose() {
      // A drag in progress dies with the tree: its listeners live on the
      // window and would otherwise outlive every element they act on.
      stopDrag?.();
      for (const leaf of leaves()) {
        attempt(() => leaf.pane.dispose());
        leaf.element.remove();
      }
      parents.clear();
      element.remove();
    },
  };
}
