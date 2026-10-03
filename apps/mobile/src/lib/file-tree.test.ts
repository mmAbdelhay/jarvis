import { describe, expect, it } from "vitest";
import {
  flattenTree,
  initialTree,
  loadedFolder,
  refreshedTree,
  reloadPaths,
  toggleFolder,
} from "./file-tree";

const root = [
  { name: "src", directory: true },
  { name: "docs", directory: true },
  { name: "package.json", directory: false },
];

describe("file tree", () => {
  it("starts with the root loading", () => {
    expect(flattenTree(initialTree())).toEqual([{ kind: "loading", path: "", depth: 0 }]);
  });

  it("lists the root once it has loaded, folders closed", () => {
    const state = loadedFolder(initialTree(), "", root);
    expect(flattenTree(state).map((row) => [row.kind, row.depth])).toEqual([
      ["folder", 0],
      ["folder", 0],
      ["file", 0],
    ]);
  });

  it("opening a folder marks it loading and asks for a read", () => {
    const base = loadedFolder(initialTree(), "", root);
    const opened = toggleFolder(base, "src");
    expect(opened.load).toBe(true);
    expect(flattenTree(opened.state)[1]).toEqual({ kind: "loading", path: "src", depth: 1 });
  });

  it("nests children one level deeper and flattens them in place", () => {
    let state = loadedFolder(initialTree(), "", root);
    state = toggleFolder(state, "src").state;
    state = loadedFolder(state, "src", [
      { name: "db", directory: true },
      { name: "server.ts", directory: false },
    ]);
    const rows = flattenTree(state);
    expect(
      rows.map((row) => (row.kind === "file" || row.kind === "folder" ? row.path : "?")),
    ).toEqual(["src", "src/db", "src/server.ts", "docs", "package.json"]);
    expect(rows[1]?.depth).toBe(1);
  });

  it("collapsing hides the children and re-opening does not read again", () => {
    let state = loadedFolder(initialTree(), "", root);
    state = loadedFolder(toggleFolder(state, "src").state, "src", [
      { name: "a.ts", directory: false },
    ]);
    state = toggleFolder(state, "src").state;
    expect(flattenTree(state)).toHaveLength(3);
    const again = toggleFolder(state, "src");
    expect(again.load).toBe(false);
    expect(flattenTree(again.state)).toHaveLength(4);
  });

  it("a failed folder shows an error row and keeps its siblings", () => {
    let state = loadedFolder(initialTree(), "", root);
    state = loadedFolder(toggleFolder(state, "src").state, "src", undefined);
    const rows = flattenTree(state);
    expect(rows.map((row) => row.kind)).toEqual(["folder", "error", "folder", "file"]);
    // Opening it again after closing retries the read.
    const retry = toggleFolder(toggleFolder(state, "src").state, "src");
    expect(retry.load).toBe(true);
  });

  it("a refresh reads the root and every open folder again", () => {
    let state = loadedFolder(initialTree(), "", root);
    state = loadedFolder(toggleFolder(state, "src").state, "src", []);
    expect(reloadPaths(state)).toEqual(["", "src"]);
    expect(refreshedTree(state).nodes).toEqual({ "": "loading", src: "loading" });
  });
});
