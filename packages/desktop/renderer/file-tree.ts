import type { DirEntry, EntryKind } from "../src/ipc.js";

/** What a right-click landed on: a row, or the empty space below the rows
 *  (`undefined`), which means "the root". */
export type FileTreeTarget = { path: string; directory: boolean } | undefined;

export type FileTreeHooks = {
  list: (path: string) => Promise<DirEntry[]>;
  /** A file was chosen. The tree neither opens nor runs anything. */
  choose: (path: string) => void;
  /** A right-click, at viewport coordinates. Absent means no menu at all —
   *  the tree is then exactly the read-only one it always was. */
  menu?: (target: FileTreeTarget, x: number, y: number) => void;
};

/** An inline name field the tree draws in place: a new row at the top of
 *  `parent`'s folder, or the name of the row at `path`. */
export type FileTreeEdit =
  | { kind: "create"; parent: string; entry: EntryKind }
  | { kind: "rename"; path: string };

export type FileTree = {
  element: HTMLElement;
  /** Re-roots and lists afresh. Safe to call with the same path. */
  setRoot(path: string): Promise<void>;
  root(): string | undefined;
  /** Lists the root and every expanded folder again, keeping what is
   *  expanded expanded. A folder whose listing has not changed keeps its
   *  rows — the same elements, so nothing under the pointer flickers — and
   *  a folder that is collapsed is simply forgotten, to be listed fresh on
   *  its next expansion. A no-op while a name is being typed: a reload
   *  would take the field away mid-word. */
  reload(): Promise<void>;
  /** Draws a name field and resolves with what was typed once Enter is
   *  pressed, or `undefined` for Escape, a click elsewhere, or an empty
   *  name. A second edit started while one is open cancels the first. */
  edit(request: FileTreeEdit): Promise<string | undefined>;
};

/** A folder row's own controls, by path, so reload and edit can reach a
 *  folder without walking the DOM. */
type FolderNode = {
  children: HTMLElement;
  expanded(): boolean;
  expand(): Promise<boolean>;
  /** Drops the cached rows of a collapsed folder: they would be stale. */
  forget(): void;
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

  /** Every folder row currently drawn, by its full path. */
  const folders = new Map<string, FolderNode>();
  /** Which listing each container is showing, so a reload whose answer is
   *  the same can leave the rows alone. */
  const shown = new WeakMap<HTMLElement, string>();
  /** The open name field's way out, if there is one. */
  let cancelEdit: (() => void) | undefined;

  const signature = (entries: DirEntry[]): string =>
    entries
      .map((entry) => `${entry.directory ? "d" : "f"}:${entry.name}`)
      .sort()
      .join("\n");

  // Wrapped in try/catch: nothing may throw into a terminal, and leaving
  // `container` untouched on failure is what keeps a rejected listing from
  // clobbering whatever was already drawn there — the previous tree, or an
  // empty container that never got its first render. Returns whether the
  // listing succeeded *and was actually written* — `stillValid` is checked
  // right before the DOM write (not just before starting the call), so a
  // caller can supersede an in-flight listing: when a later call has since
  // taken over, this one's answer arrives too late to matter and must never
  // clobber what the later call already drew. `keepIfSame` is a reload's:
  // the same listing as last time leaves the rows as they are and reports
  // "same", so the caller knows the folders under it are still the ones in
  // `folders`.
  async function listInto(
    path: string,
    container: HTMLElement,
    stillValid: () => boolean = () => true,
    keepIfSame = false,
  ): Promise<false | "drawn" | "same"> {
    let entries: DirEntry[];
    try {
      entries = await hooks.list(path);
    } catch {
      return false;
    }
    if (!stillValid()) return false;

    const sig = signature(entries);
    if (keepIfSame && shown.get(container) === sig) return "same";

    const rows = entries
      .slice()
      .sort((a, b) => {
        if (a.directory !== b.directory) return a.directory ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((entry) => buildRow(path, entry));
    container.replaceChildren(...rows);
    shown.set(container, sig);
    return "drawn";
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
    row.tabIndex = 0;
    row.dataset["path"] = path;
    row.dataset["directory"] = String(entry.directory);

    // Every row's name starts in the same column: a directory gets a
    // chevron, a file an equal-width blank in its place. That alignment is
    // most of what makes the list read as a tree.
    let chevron: HTMLElement | undefined;
    if (entry.directory) {
      chevron = document.createElement("span");
      chevron.className = "file-tree-chevron";
      chevron.textContent = "▸";
      row.append(chevron);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "file-tree-spacer";
      row.append(spacer);
    }

    const name = document.createElement("span");
    name.className = "file-tree-name";
    name.textContent = entry.name;
    // An attribute, not markup: a long name is clipped with an ellipsis in
    // CSS, and this is what still identifies it on hover.
    name.title = entry.name;
    row.append(name);

    if (hooks.menu !== undefined) {
      const menu = hooks.menu;
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        // The row's own menu, not the empty-space one the tree listens for.
        event.stopPropagation();
        menu({ path, directory: entry.directory }, event.clientX, event.clientY);
      });
    }

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

    const setOpen = (open: boolean): void => {
      children.hidden = !open;
      if (chevron !== undefined) chevron.textContent = open ? "▾" : "▸";
    };

    const node: FolderNode = {
      children,
      expanded: () => !children.hidden,
      async expand() {
        if (!children.hidden) return true;
        if (cached !== undefined) {
          children.replaceChildren(...cached);
          setOpen(true);
          return true;
        }
        if (loading) return false;
        loading = true;
        const listed = await listInto(path, children);
        loading = false;
        if (listed === false) return false;
        cached = [...children.childNodes];
        setOpen(true);
        return true;
      },
      forget() {
        if (children.hidden) {
          cached = undefined;
          shown.delete(children);
        }
      },
    };
    folders.set(path, node);

    row.addEventListener("click", () => {
      void (async () => {
        if (children.hidden) {
          await node.expand();
          return;
        }
        // Whatever is drawn now is what the next expansion shows — a
        // reload may have redrawn it since the first one.
        cached = [...children.childNodes];
        setOpen(false);
        children.replaceChildren();
      })();
    });

    return wrapper;
  }

  /** A reload of one folder already drawn: its listing again, and then
   *  the same for each of its subfolders that was open when the reload
   *  began. `wasOpen` is taken once, up front, by `reload` — a folder
   *  redrawn on the way down has lost the rows that knew which of its own
   *  subfolders were open. */
  async function reloadInto(
    path: string,
    container: HTMLElement,
    wasOpen: ReadonlySet<string>,
    valid: () => boolean,
  ): Promise<void> {
    const before = [...folders.keys()].filter((key) => isUnder(key, path));
    const listed = await listInto(path, container, valid, true);
    if (listed === false) return;
    if (listed === "drawn") {
      // The rows just replaced took their folders with them; only what is
      // still drawn stays reachable by path.
      for (const key of before) if (!isDrawn(key)) folders.delete(key);
    }
    for (const [key, node] of [...folders.entries()]) {
      if (!isDirectChild(key, path)) continue;
      if (wasOpen.has(key) && !node.expanded()) {
        // A folder that was open but is drawn closed — a fresh row from a
        // redraw above it: open it again, then bring its own subfolders
        // back the same way.
        if (await node.expand()) await reloadInto(key, node.children, wasOpen, valid);
      } else if (node.expanded()) {
        await reloadInto(key, node.children, wasOpen, valid);
      } else {
        node.forget();
      }
      if (!valid()) return;
    }
  }

  function isUnder(candidate: string, parent: string): boolean {
    const prefix = parent.endsWith("/") ? parent : `${parent}/`;
    return candidate.startsWith(prefix);
  }

  function isDirectChild(candidate: string, parent: string): boolean {
    if (!isUnder(candidate, parent)) return false;
    const rest = candidate.slice(parent.endsWith("/") ? parent.length : parent.length + 1);
    return rest !== "" && !rest.includes("/");
  }

  function rowFor(path: string): HTMLElement | undefined {
    for (const row of element.querySelectorAll<HTMLElement>(".file-tree-row")) {
      if (row.dataset["path"] === path) return row;
    }
    return undefined;
  }

  function isDrawn(path: string): boolean {
    return rowFor(path) !== undefined;
  }

  /** The input both edits use: Enter commits, Escape or leaving cancels. */
  function nameField(
    initial: string,
    onDone: (value: string | undefined) => void,
  ): { input: HTMLInputElement; cancel: () => void } {
    const input = document.createElement("input");
    input.className = "file-tree-input";
    input.type = "text";
    input.value = initial;
    input.spellcheck = false;
    let done = false;
    const finish = (value: string | undefined): void => {
      if (done) return;
      done = true;
      onDone(value === "" ? undefined : value);
    };
    input.addEventListener("keydown", (event) => {
      // The terminal under the sidebar must never see these keys.
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(input.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(undefined);
      }
    });
    input.addEventListener("blur", () => finish(undefined));
    return { input, cancel: () => finish(undefined) };
  }

  // Bumped on every setRoot call (not on every resolution), so the call
  // holding the *highest* generation when its listing settles is always the
  // most recently *called* one — last-called wins, regardless of the order
  // two overlapping calls happen to resolve in. A caller re-roots this tree
  // on every cwd event, so two calls overlapping (a fast `cd; cd ..`) is not
  // hypothetical.
  let generation = 0;

  if (hooks.menu !== undefined) {
    const menu = hooks.menu;
    element.addEventListener("contextmenu", (event) => {
      if (root === undefined) return;
      event.preventDefault();
      menu(undefined, event.clientX, event.clientY);
    });
  }

  return {
    element,
    async setRoot(path: string): Promise<void> {
      const gen = ++generation;
      cancelEdit?.();
      // root() only moves once the listing actually succeeds *and* is still
      // the most recent call by the time it resolves — an overlapping later
      // setRoot must never be clobbered by an earlier one settling after it.
      folders.clear();
      if ((await listInto(path, element, () => gen === generation)) !== false) root = path;
    },
    root(): string | undefined {
      return root;
    },
    async reload(): Promise<void> {
      const current = root;
      if (current === undefined || cancelEdit !== undefined) return;
      const gen = generation;
      const wasOpen = new Set(
        [...folders.entries()].filter(([, node]) => node.expanded()).map(([key]) => key),
      );
      await reloadInto(
        current,
        element,
        wasOpen,
        () => gen === generation && cancelEdit === undefined,
      );
    },
    edit(request: FileTreeEdit): Promise<string | undefined> {
      cancelEdit?.();
      return new Promise((resolve) => {
        const close: Array<() => void> = [];
        const settle = (value: string | undefined): void => {
          cancelEdit = undefined;
          for (const undo of close) undo();
          resolve(value);
        };

        if (request.kind === "rename") {
          const row = rowFor(request.path);
          const label = row?.querySelector<HTMLElement>(".file-tree-name");
          if (row === undefined || label === null || label === undefined) {
            resolve(undefined);
            return;
          }
          const current = label.textContent ?? "";
          const { input, cancel } = nameField(current, (value) =>
            settle(value === current ? undefined : value),
          );
          label.hidden = true;
          row.append(input);
          close.push(() => {
            input.remove();
            label.hidden = false;
          });
          cancelEdit = cancel;
          input.focus();
          // The name without its extension, the part a rename usually
          // changes; a dotfile's leading dot is not an extension.
          const dot = current.lastIndexOf(".");
          input.setSelectionRange(0, dot > 0 ? dot : current.length);
          return;
        }

        const parent = request.parent;
        void (async () => {
          let container: HTMLElement | undefined = parent === root ? element : undefined;
          if (container === undefined) {
            const node = folders.get(parent);
            if (node !== undefined && (await node.expand())) container = node.children;
          }
          if (container === undefined) {
            resolve(undefined);
            return;
          }
          const row = document.createElement("div");
          row.className = "file-tree-row file-tree-editing";
          const icon = document.createElement("span");
          icon.className = request.entry === "directory" ? "file-tree-chevron" : "file-tree-spacer";
          icon.textContent = request.entry === "directory" ? "▸" : "";
          const { input, cancel } = nameField("", settle);
          row.append(icon, input);
          container.prepend(row);
          close.push(() => row.remove());
          cancelEdit = cancel;
          input.focus();
        })();
      });
    },
  };
}
