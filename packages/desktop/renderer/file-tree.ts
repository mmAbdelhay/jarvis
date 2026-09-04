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
  // listing succeeded, so a caller (setRoot) can decide what else moves
  // together with a successful render.
  async function listInto(path: string, container: HTMLElement): Promise<boolean> {
    let entries: DirEntry[];
    try {
      entries = await hooks.list(path);
    } catch {
      return false;
    }

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

  function buildRow(parentPath: string, entry: DirEntry): HTMLElement {
    const path = `${parentPath}/${entry.name}`;

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
    row.addEventListener("click", () => {
      void (async () => {
        if (cached === undefined) {
          if (!(await listInto(path, children))) return;
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

  return {
    element,
    async setRoot(path: string): Promise<void> {
      // root() only moves once the listing actually succeeds — a rejected
      // setRoot must leave both the drawn tree and root() exactly as they
      // were, never a re-rooted tree with stale rows underneath it.
      if (await listInto(path, element)) root = path;
    },
    root(): string | undefined {
      return root;
    },
  };
}
