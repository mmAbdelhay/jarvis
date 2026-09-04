// Moving around a pane's frozen blocks: selecting one, jumping between
// them, filtering the list down, and a sticky header that says which one
// the user is looking at once its own header has scrolled out of view.
//
// Filtering hides with the `hidden` property, never by removing elements —
// a filter that destroyed blocks would lose them for good. Selection tracks
// the BlockView itself rather than an index, so a block finishing above the
// selected one (or one being dropped once the pane's MAX_BLOCKS cap is hit)
// never leaves the wrong block marked selected.

import type { BlockView } from "./block-view.js";

/** No filter, "failed only" (⌘⇧F), or narrowed to one exact command (the
 *  block-more menu's "Filter to this command"). Only one is ever active —
 *  picking one clears whichever was active before it. */
type Filter = { kind: "none" } | { kind: "failed" } | { kind: "command"; command: string };

export type BlockNav = {
  move(delta: number): void;
  selected(): BlockView | undefined;
  clear(): void;
  toggleFailedFilter(): void;
  isFiltered(): boolean;
  /** The block-more menu's "Filter to this command": narrows the list to
   *  blocks whose command matches exactly, or clears the filter if that
   *  command is already the active one (a second click removes it). Not
   *  named in Task 7's interface, but the menu entry it wires — see the
   *  task's "Decisions already made". */
  filterToCommand(command: string): void;
  /** Called by the pane after a block is added or dropped. */
  sync(views: readonly BlockView[]): void;
  /** Plain text of every visible block, for the find bar. */
  searchText(): string;
  /** The find bar's fallback once the live terminal has no match: scrolls
   *  the first visible block whose text contains `query` (case-insensitive,
   *  matching the search addon's own default) into view and flags it
   *  `.found` for one second. Returns whether a block matched. Not named in
   *  Task 7's interface, but what "scroll the first matching block into
   *  view" needs — `searchText()` alone has no block boundaries to scroll
   *  to, only concatenated text. */
  findText(query: string): boolean;
  /** Back to a nav over nothing: no blocks, no selection, no filter and no
   *  sticky header. What a pane calls when the *thing* it is showing has
   *  been replaced — the Session view switching from one agent to another —
   *  as opposed to `sync`, which is one block arriving or being dropped
   *  from the same list. Leaves the listener in place: the nav goes on
   *  living, and `dispose` is still the only thing that ends it. */
  reset(): void;
  /** Releases the sticky header's document-level scroll listener. Call once,
   *  when the pane that owns this nav is disposed — without it, the
   *  listener (and everything it closes over: `views`, `selected`, `list`,
   *  `sticky`) outlives the tab that created it for the life of the
   *  process, and every scroll anywhere in the app pays for checking it. */
  dispose(): void;
};

/** Runs a piece of DOM measurement or manipulation, swallowing anything it
 *  throws — the same discipline terminal-pane.ts and terminal-addons.ts
 *  follow, and for the same reason: nothing here is worth taking a terminal
 *  down for. */
function attempt(work: () => void): void {
  try {
    work();
  } catch {
    // Nothing touched.
  }
}

export function createBlockNav(list: HTMLElement, sticky: HTMLElement): BlockNav {
  let views: readonly BlockView[] = [];
  let selected: BlockView | undefined;
  let filter: Filter = { kind: "none" };

  function passesFilter(view: BlockView): boolean {
    if (filter.kind === "none") return true;
    if (filter.kind === "failed") return view.record.exitCode !== 0;
    return view.record.command === filter.command;
  }

  function visible(): BlockView[] {
    return views.filter((view) => !view.element.hidden);
  }

  /** Applies `filter` to every block's `hidden` property, and drops the
   *  selection if the filter just hid the block that held it — a selected
   *  block a user can no longer see is not a selection any more. */
  function applyFilter(): void {
    for (const view of views) view.element.hidden = !passesFilter(view);
    if (selected !== undefined && selected.element.hidden) {
      selected.setSelected(false);
      selected = undefined;
    }
  }

  function select(view: BlockView | undefined): void {
    if (selected === view) return;
    selected?.setSelected(false);
    selected = view;
    if (selected !== undefined) {
      selected.setSelected(true);
      attempt(() => selected?.element.scrollIntoView({ block: "nearest" }));
    }
  }

  /** The first block whose header has scrolled above the list's own top —
   *  the one the sticky header should be standing in for. Blocks are in top
   *  to bottom DOM order, so the search can stop at the first one still
   *  below the boundary; everything after it is further below still. */
  function updateSticky(): void {
    const container = list.parentElement;
    if (container === null) return;
    const boundary = container.getBoundingClientRect().top;
    let current: BlockView | undefined;
    for (const view of views) {
      if (view.element.hidden) continue;
      if (view.element.getBoundingClientRect().top > boundary) break;
      current = view;
    }
    if (current === undefined) {
      sticky.hidden = true;
      sticky.textContent = "";
      return;
    }
    // textContent only, and read fresh from the block's own header rather
    // than cloning it — cloning would duplicate the header's action
    // handlers (collapse, copy, re-run, more) onto a second, live-looking
    // element that does nothing when clicked.
    sticky.textContent = current.element.querySelector(".block-header")?.textContent ?? "";
    sticky.hidden = false;
  }
  // Registered on `document`, in the capture phase: `scroll` does not
  // bubble, but capture-phase listeners on an ancestor still see it as it
  // is dispatched down to the element that actually scrolled. Filtered to
  // the list's own scrolling ancestor so a scroll anywhere else in the app
  // — another pane, a dropdown — is ignored. That ancestor is looked up
  // fresh on every event rather than cached at construction time, since the
  // pane appends `list` to its root after creating it in some call orders
  // (and every order in this file's own tests).
  const onScroll = (event: Event): void => {
    if (!(event.target instanceof Node) || !event.target.contains(list)) return;
    attempt(updateSticky);
  };
  attempt(() => document.addEventListener("scroll", onScroll, true));

  return {
    move(delta: number): void {
      const candidates = visible();
      if (candidates.length === 0) return;
      const index = selected === undefined ? -1 : candidates.indexOf(selected);
      const next =
        index === -1
          ? delta > 0
            ? 0
            : candidates.length - 1
          : Math.max(0, Math.min(candidates.length - 1, index + delta));
      select(candidates[next]);
    },
    selected: () => selected,
    clear(): void {
      select(undefined);
    },
    toggleFailedFilter(): void {
      filter = filter.kind === "failed" ? { kind: "none" } : { kind: "failed" };
      applyFilter();
    },
    isFiltered: () => filter.kind !== "none",
    filterToCommand(command: string): void {
      filter =
        filter.kind === "command" && filter.command === command
          ? { kind: "none" }
          : { kind: "command", command };
      applyFilter();
    },
    sync(next: readonly BlockView[]): void {
      views = next;
      // Through select(), like every other path that drops a selection —
      // never by reassigning `selected` directly, which would skip
      // setSelected(false) and leave the dropped block's element carrying
      // a stale .selected class forever (it usually has no visible effect,
      // since the pane removes a dropped block's element around the same
      // time, but that is an accident of call order, not something this
      // function may rely on).
      if (selected !== undefined && !views.includes(selected)) select(undefined);
      applyFilter();
    },
    searchText(): string {
      return visible()
        .map((view) => view.text())
        .join("\n");
    },
    findText(query: string): boolean {
      if (query === "") return false;
      const needle = query.toLowerCase();
      const match = visible().find((view) => view.text().toLowerCase().includes(needle));
      if (match === undefined) return false;
      attempt(() => match.element.scrollIntoView({ block: "center" }));
      attempt(() => {
        match.element.classList.add("found");
        setTimeout(() => attempt(() => match.element.classList.remove("found")), 1000);
      });
      return true;
    },
    reset(): void {
      // Through select(), for the same reason sync() goes through it: a
      // selection dropped by reassignment would leave .selected behind.
      select(undefined);
      filter = { kind: "none" };
      views = [];
      // The header stands in for a block that has scrolled out of view, and
      // there is no longer a block for it to stand in for. Cleared here
      // rather than waiting for the next scroll, which may never come.
      attempt(() => {
        sticky.hidden = true;
        sticky.textContent = "";
      });
    },
    dispose(): void {
      attempt(() => document.removeEventListener("scroll", onScroll, true));
    },
  };
}
