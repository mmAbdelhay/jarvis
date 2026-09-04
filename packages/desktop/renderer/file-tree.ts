import type { DirEntry } from "../src/ipc.js";

export type FileTreeHooks = {
  list: (path: string) => Promise<DirEntry[]>;
  /** A file was chosen. The tree neither opens nor runs anything. */
  choose: (path: string) => void;
};

export type FileTree = {
  element: HTMLElement;
  /** Re-roots and lists afresh. Safe to call with the same path. */
  setRoot(path: string): Promise<void>;
  root(): string | undefined;
};

// The Workspace's file sidebar, beside the Terminal tab. Standalone and
// self-contained on purpose — it knows nothing about IPC, panes, shells or
// the Editor tab; it is handed a `list` and a `choose` and draws whatever
// `list` gives it. Follows renderTree in api.ts: rows built with
// document.createElement, every name in through textContent, never
// innerHTML — a file name is untrusted text, whatever happens to be on disk.
//
// Lazy expansion: a folder is listed on first expansion and its children div
// is kept from then on, so collapsing is `hidden = true`, never a re-list.
export function createFileTree(hooks: FileTreeHooks): FileTree {
  const element = document.createElement("div");
  element.className = "file-tree";
  let root: string | undefined;

  // Wrapped in try/catch: nothing may throw into a terminal, and leaving
  // `container` untouched on failure is what keeps a rejected listing from
  // clobbering whatever was already drawn there — the previous tree, or an
  // empty container that never got its first render. Returns whether the
  // listing succeeded *and was actually written* — `stillValid` is checked
  // right before the DOM write (not just before starting the call), so a
  // caller can supersede an in-flight listing: when a later call has since
  // taken over, this one's answer arrives too late to matter and must never
  // clobber what the later call already drew.
  async function listInto(
    path: string,
    container: HTMLElement,
    stillValid: () => boolean = () => true,
  ): Promise<boolean> {
    let entries: DirEntry[];
    try {
      entries = await hooks.list(path);
    } catch {
      return false;
    }
    if (!stillValid()) return false;

    const rows = entries
      .slice()
      .sort((a, b) => {
        if (a.directory !== b.directory) return a.directory ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((entry) => buildRow(path, entry));
    container.replaceChildren(...rows);
    return true;
  }

  // `parentPath` may end in "/" (a root of "/", or a caller-supplied
  // trailing slash) — a plain template join would then hand `hooks.list` and
  // `hooks.choose` a path with a doubled slash, and a consumer that
  // string-matches paths (the sidebar's dedupe, the containment check a
  // later task resolves them against) would silently miss it.
  function joinPath(parentPath: string, name: string): string {
    return `${parentPath}/${name}`.replace(/\/{2,}/g, "/");
  }

  function buildRow(parentPath: string, entry: DirEntry): HTMLElement {
    const path = joinPath(parentPath, entry.name);

    const row = document.createElement("div");
    row.className = "file-tree-row";
    row.dataset["path"] = path;
    row.dataset["directory"] = String(entry.directory);

    const name = document.createElement("span");
    name.className = "file-tree-name";
    name.textContent = entry.name;
    row.append(name);

    if (!entry.directory) {
      row.addEventListener("click", () => hooks.choose(path));
      return row;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "file-tree-node";
    wrapper.append(row);

    const children = document.createElement("div");
    children.className = "file-tree-children";
    children.hidden = true;
    wrapper.append(children);

    // The listed rows, cached in JS once `list` has actually answered — kept
    // even while collapsed, so a second expansion redraws them for free
    // instead of calling `list` again. `hidden` alone is not enough to keep
    // a collapsed folder's names out of the tree's textContent (the DOM
    // walk textContent does ignores CSS/`hidden` entirely), so a collapse
    // also empties `children`'s actual child nodes; `cached` is what makes
    // that safe to do.
    let cached: ChildNode[] | undefined;
    // `cached` is only set once `listInto` has actually returned, so a
    // second click landing while the first expansion's `list()` is still in
    // flight would otherwise see `cached === undefined` too and fire a
    // second `list()` call for the same folder — `loading` closes that
    // window: a click that arrives mid-expansion is ignored rather than
    // starting a second one.
    let loading = false;
    row.addEventListener("click", () => {
      void (async () => {
        if (cached === undefined) {
          if (loading) return;
          loading = true;
          const ok = await listInto(path, children);
          loading = false;
          if (!ok) return;
          cached = [...children.childNodes];
          children.hidden = false;
          return;
        }
        children.hidden = !children.hidden;
        children.replaceChildren(...(children.hidden ? [] : cached));
      })();
    });

    return wrapper;
  }

  // Bumped on every setRoot call (not on every resolution), so the call
  // holding the *highest* generation when its listing settles is always the
  // most recently *called* one — last-called wins, regardless of the order
  // two overlapping calls happen to resolve in. A caller re-roots this tree
  // on every cwd event, so two calls overlapping (a fast `cd; cd ..`) is not
  // hypothetical.
  let generation = 0;

  return {
    element,
    async setRoot(path: string): Promise<void> {
      const gen = ++generation;
      // root() only moves once the listing actually succeeds *and* is still
      // the most recent call by the time it resolves — an overlapping later
      // setRoot must never be clobbered by an earlier one settling after it.
      if (await listInto(path, element, () => gen === generation)) root = path;
    },
    root(): string | undefined {
      return root;
    },
  };
}
