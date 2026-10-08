// The wide Workspace's Files aside: a lazily loaded tree over
// `terminal:listDir`. Folders load their children the first time they open;
// a failed load marks only that folder, so its siblings stay usable. Pure so
// the rules are unit tested; the component owns the reads.

import { childPath, type DirEntry } from "./file-browser";

/** `"loading"` while a folder's listing is in flight, `"error"` when it
 *  could not be read, otherwise the entries. */
export type TreeNode = DirEntry[] | "loading" | "error";

export type FileTreeState = {
  /** Paths (relative to the project root) of the open folders. */
  expanded: readonly string[];
  /** Listings by folder path; "" is the root. */
  nodes: Readonly<Record<string, TreeNode>>;
};

export type TreeRow =
  | { kind: "folder"; path: string; name: string; depth: number; expanded: boolean }
  | { kind: "file"; path: string; name: string; depth: number }
  | { kind: "loading"; path: string; depth: number }
  | { kind: "error"; path: string; depth: number };

/** The root starts loading: the tree reads it as soon as it mounts. */
export function initialTree(): FileTreeState {
  return { expanded: [], nodes: { "": "loading" } };
}

/** Open or close a folder. Opening one that has no listing (or whose last
 *  read failed) marks it loading and asks the caller to read it. */
export function toggleFolder(
  state: FileTreeState,
  path: string,
): { state: FileTreeState; load: boolean } {
  if (state.expanded.includes(path)) {
    return {
      state: { ...state, expanded: state.expanded.filter((open) => open !== path) },
      load: false,
    };
  }
  const node = state.nodes[path];
  const load = node === undefined || node === "error";
  return {
    state: {
      expanded: [...state.expanded, path],
      nodes: load ? { ...state.nodes, [path]: "loading" } : state.nodes,
    },
    load,
  };
}

/** A listing arrived (`undefined`: the read failed). */
export function loadedFolder(
  state: FileTreeState,
  path: string,
  entries: DirEntry[] | undefined,
): FileTreeState {
  return { ...state, nodes: { ...state.nodes, [path]: entries ?? "error" } };
}

/** Drop every listing and start again from the root (after a rename or a
 *  move to Trash). Open folders stay open and are read again by the caller
 *  through `reloadPaths`. */
export function refreshedTree(state: FileTreeState): FileTreeState {
  const nodes: Record<string, TreeNode> = {};
  for (const path of ["", ...state.expanded]) nodes[path] = "loading";
  return { expanded: state.expanded, nodes };
}

/** Every folder a refresh must read again: the root and the open ones. */
export function reloadPaths(state: FileTreeState): string[] {
  return ["", ...state.expanded];
}

/** The visible rows, top to bottom: each folder's children follow it, one
 *  level deeper, while it is open. Depth 0 is the project root's entries. */
export function flattenTree(state: FileTreeState): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (path: string, depth: number): void => {
    const node = state.nodes[path];
    if (node === undefined) return;
    if (node === "loading" || node === "error") {
      rows.push(
        node === "loading" ? { kind: "loading", path, depth } : { kind: "error", path, depth },
      );
      return;
    }
    for (const entry of node) {
      const full = childPath(path, entry.name);
      if (!entry.directory) {
        rows.push({ kind: "file", path: full, name: entry.name, depth });
        continue;
      }
      const open = state.expanded.includes(full);
      rows.push({ kind: "folder", path: full, name: entry.name, depth, expanded: open });
      if (open) walk(full, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}
