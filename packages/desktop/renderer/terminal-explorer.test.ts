// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createTerminalExplorer } from "./terminal-explorer.js";

const listing: Record<string, { name: string; directory: boolean }[]> = {
  "/proj": [
    { name: "src", directory: true },
    { name: "read me.md", directory: false },
  ],
  "/proj/src": [{ name: "main.ts", directory: false }],
};

function explorer() {
  const host = document.createElement("div");
  document.body.append(host);
  const list = vi.fn(async (_paneKey: string, path: string) => listing[path] ?? []);
  const choose = vi.fn();
  return { host, list, choose, view: createTerminalExplorer(host, "", { list, choose }) };
}

/** A microtask turn — the tree's own listings resolve on promises. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the terminal explorer", () => {
  it("roots at the focused pane's directory", async () => {
    const { view, list } = explorer();
    view.setRoot("tab-1", "/proj");
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith("tab-1", "/proj");
    expect(view.element.textContent).toContain("read me.md");
  });

  it("re-roots when the shell moves", async () => {
    const { view, list } = explorer();
    view.setRoot("tab-1", "/proj");
    await settle();
    view.setRoot("tab-1", "/proj/src");
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith("tab-1", "/proj/src");
    expect(view.element.textContent).toContain("main.ts");
  });

  // The cwd event fires on every prompt, not only when the directory
  // changed: a shell printing its prompt in the same place re-emits it.
  // Without this, every prompt would re-list the whole directory.
  it("does not re-list when the same pane reports the same directory", async () => {
    const { view, list } = explorer();
    view.setRoot("tab-1", "/proj");
    await settle();
    view.setRoot("tab-1", "/proj");
    view.setRoot("tab-1", "/proj");
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
  });

  // A different pane in the same directory is still a different shell: the
  // listing and every `choose` from it must be attributed to that shell.
  it("re-roots when the focus moves to another pane in the same directory", async () => {
    const { view, list } = explorer();
    view.setRoot("tab-1", "/proj");
    await settle();
    view.setRoot("tab-1:p1", "/proj");
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith("tab-1:p1", "/proj");
  });

  it("hands `choose` the pane key it is rooted for", async () => {
    const { view, choose } = explorer();
    view.setRoot("tab-1:p1", "/proj");
    await settle();
    view.element.querySelector<HTMLElement>('[data-path="/proj/read me.md"]')?.click();
    expect(choose).toHaveBeenCalledWith("tab-1:p1", "/proj/read me.md");
  });

  it("lists an expanded folder for the pane it is rooted for", async () => {
    const { view, list } = explorer();
    view.setRoot("tab-1:p1", "/proj");
    await settle();
    view.element.querySelector<HTMLElement>('[data-path="/proj/src"]')?.click();
    await settle();
    expect(list).toHaveBeenLastCalledWith("tab-1:p1", "/proj/src");
    expect(view.element.textContent).toContain("main.ts");
  });

  // A pane whose shell never reports a directory — no shell integration —
  // leaves the tab exactly as it was before the sidebar existed.
  it("shows nothing until it has a directory, then opens", async () => {
    const { view, list } = explorer();
    expect(view.isOpen()).toBe(false);
    expect(view.element.hidden).toBe(true);
    expect(list).not.toHaveBeenCalled();
    view.setRoot("tab-1", "/proj");
    await settle();
    expect(view.isOpen()).toBe(true);
    expect(view.element.hidden).toBe(false);
  });

  it("toggles hidden and back without losing the tree", async () => {
    const { view, list } = explorer();
    view.setRoot("tab-1", "/proj");
    await settle();
    view.toggle();
    expect(view.isOpen()).toBe(false);
    expect(view.element.hidden).toBe(true);
    view.toggle();
    expect(view.isOpen()).toBe(true);
    expect(view.element.hidden).toBe(false);
    expect(view.element.textContent).toContain("read me.md");
    expect(list).toHaveBeenCalledTimes(1);
  });

  // A closed sidebar stays closed through a `cd`: re-opening is the user's.
  it("does not re-open itself when the shell moves while it is closed", async () => {
    const { view } = explorer();
    view.setRoot("tab-1", "/proj");
    await settle();
    view.toggle();
    view.setRoot("tab-1", "/proj/src");
    await settle();
    expect(view.isOpen()).toBe(false);
    expect(view.element.hidden).toBe(true);
  });

  it("takes its element and every listener with it when disposed", async () => {
    const { view, host, list, choose } = explorer();
    view.setRoot("tab-1", "/proj");
    await settle();
    const row = view.element.querySelector<HTMLElement>('[data-path="/proj/read me.md"]');
    const folder = view.element.querySelector<HTMLElement>('[data-path="/proj/src"]');
    view.dispose();
    expect(host.contains(view.element)).toBe(false);
    expect(view.element.parentElement).toBe(null);

    // The rows outlive the element only because this test held on to them;
    // a click on one must reach nothing.
    row?.click();
    folder?.click();
    view.setRoot("tab-1", "/elsewhere");
    await settle();
    expect(choose).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("survives a listing that fails", async () => {
    const host = document.createElement("div");
    const list = vi.fn(() => {
      throw new Error("no");
    });
    const view = createTerminalExplorer(host, "", { list, choose: vi.fn() });
    expect(() => view.setRoot("tab-1", "/proj")).not.toThrow();
    await settle();
    // The header still says where the shell is — that came from the pane's
    // own cwd report, not from the listing — but there is nothing to list.
    expect(view.element.querySelectorAll(".file-tree-row").length).toBe(0);
  });

  // Nothing watches the filesystem and `setRoot` dedupes on
  // `(paneKey, path)`, so a file a command just created is invisible until
  // something re-lists the root. This is that something — the third of the
  // three refresh triggers the design named, the two others being a `cd`
  // and expanding a folder.
  it("re-lists the current root on an explicit refresh", async () => {
    const { view, list } = explorer();
    view.setRoot("tab-1", "/proj");
    await settle();
    expect(view.element.textContent).not.toContain("new.ts");

    // A command created a file. Without a refresh the tree cannot know.
    listing["/proj"] = [
      { name: "src", directory: true },
      { name: "new.ts", directory: false },
    ];
    view.setRoot("tab-1", "/proj");
    await settle();
    expect(list).toHaveBeenCalledTimes(1);

    view.refresh();
    await settle();

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith("tab-1", "/proj");
    expect(view.element.textContent).toContain("new.ts");

    listing["/proj"] = [
      { name: "src", directory: true },
      { name: "read me.md", directory: false },
    ];
  });

  // The palette offers the action before a pane's first prompt, and after a
  // ⌘W that cleared the sidebar. Neither has a directory to re-list, and
  // re-listing a remembered one would be a tree nobody is looking at.
  it("does nothing when there is no root to refresh", async () => {
    const { view, list } = explorer();

    expect(() => view.refresh()).not.toThrow();
    await settle();
    expect(list).not.toHaveBeenCalled();

    view.setRoot("tab-1", "/proj");
    await settle();
    view.clear();
    view.refresh();
    await settle();

    expect(list).toHaveBeenCalledTimes(1);
  });
});

// The window between a re-root and its listing. FileTree does not touch
// its container until the new listing resolves, so without the sidebar
// clearing it first the old pane's rows stay clickable under the new
// pane's key — one IPC round trip wide, and `choose` is about to open
// files for real.
describe("the terminal explorer mid-re-root", () => {
  /** A promise this test controls the settlement of. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("shows no row it could attribute to the wrong shell while re-rooting", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const pending = deferred<{ name: string; directory: boolean }[]>();
    const seen: string[][] = [];
    const choose = vi.fn();
    const list = vi.fn(async (paneKey: string, path: string) => {
      seen.push([paneKey, path]);
      if (path === "/proj") return [{ name: "read me.md", directory: false }];
      return await pending.promise;
    });
    const view = createTerminalExplorer(host, "", { list, choose });

    view.setRoot("tab-1", "/proj");
    await new Promise((r) => setTimeout(r, 0));
    expect(view.element.textContent).toContain("read me.md");

    // The focus moves to another pane; its listing has not answered yet.
    view.setRoot("tab-1:p1", "/other");
    const stale = view.element.querySelector<HTMLElement>('[data-path="/proj/read me.md"]');
    expect(stale).toBeNull();
    expect(view.element.querySelectorAll(".file-tree-row").length).toBe(0);

    pending.resolve([{ name: "there.md", directory: false }]);
    await new Promise((r) => setTimeout(r, 0));
    view.element.querySelector<HTMLElement>('[data-path="/other/there.md"]')?.click();
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith("tab-1:p1", "/other/there.md");
  });
});

// A pane closed with ⌘W leaves the sidebar rooted for a shell that is
// gone. The tab clears it rather than showing a directory nobody is in.
describe("clearing the terminal explorer", () => {
  it("empties and hides when there is no directory to show", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const list = vi.fn(async () => [{ name: "src", directory: true }]);
    const view = createTerminalExplorer(host, "", { list, choose: vi.fn() });
    view.setRoot("tab-1", "/proj");
    await new Promise((r) => setTimeout(r, 0));

    view.clear();

    expect(view.element.textContent).toBe("");
    expect(view.isOpen()).toBe(false);
  });

  // Cleared is "nothing to show", not "the user closed it": the next
  // directory brings the sidebar back.
  it("comes back on the next directory", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const list = vi.fn(async () => [{ name: "src", directory: true }]);
    const view = createTerminalExplorer(host, "", { list, choose: vi.fn() });
    view.setRoot("tab-1", "/proj");
    await new Promise((r) => setTimeout(r, 0));
    view.clear();

    view.setRoot("tab-1", "/proj");
    await new Promise((r) => setTimeout(r, 0));

    expect(view.isOpen()).toBe(true);
    expect(view.element.textContent).toContain("src");
  });

  // …unless the user closed it. A clear must not undo a dismissal.
  it("stays closed through a clear and a re-root when the user closed it", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const list = vi.fn(async () => [{ name: "src", directory: true }]);
    const view = createTerminalExplorer(host, "", { list, choose: vi.fn() });
    view.setRoot("tab-1", "/proj");
    await new Promise((r) => setTimeout(r, 0));
    view.toggle();

    view.clear();
    view.setRoot("tab-1", "/elsewhere");
    await new Promise((r) => setTimeout(r, 0));

    expect(view.isOpen()).toBe(false);
  });
});

// A toggle that changes nothing on screen must change nothing later
// either. The sidebar is hidden for two quite different reasons — the
// user closed it, and there is nothing to show — and a toggle aimed at
// the second was silently arming the first: the next directory would
// then be swallowed, and the sidebar would never open by itself again.
describe("toggling the terminal explorer with nothing to show", () => {
  const settleOnce = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));

  function build() {
    const host = document.createElement("div");
    document.body.append(host);
    const list = vi.fn(async () => [{ name: "src", directory: true }]);
    return { view: createTerminalExplorer(host, "", { list, choose: vi.fn() }), list };
  }

  it("opens on its first directory even after a toggle before it had one", async () => {
    const { view } = build();

    view.toggle();
    view.setRoot("tab-1", "/proj");
    await settleOnce();

    expect(view.isOpen()).toBe(true);
    expect(view.element.textContent).toContain("src");
  });

  // The ⌘W case: the sidebar was cleared because the surviving pane has
  // no directory, not because anyone dismissed it.
  it("opens again after a clear, a toggle and a new directory", async () => {
    const { view } = build();
    view.setRoot("tab-1", "/proj");
    await settleOnce();
    view.clear();

    view.toggle();
    view.setRoot("tab-1:p1", "/other");
    await settleOnce();

    expect(view.isOpen()).toBe(true);
  });

  // The real dismissal still holds — this is the behaviour the fix must
  // not trade away.
  it("stays closed when the user dismissed it while it had something to show", async () => {
    const { view } = build();
    view.setRoot("tab-1", "/proj");
    await settleOnce();

    view.toggle();
    view.setRoot("tab-1", "/other");
    await settleOnce();

    expect(view.isOpen()).toBe(false);
  });
});

// Nothing on screen said which directory the tree was rooted at before
// this header existed — a tab re-roots on every `cd`, silently. It reuses
// terminal-chips.ts's own $HOME collapse, so the edge cases that module
// already covers (a trailing-slash home, a root home of "/", a cwd that
// only shares a prefix with home) are not re-proven here — only that the
// header actually calls it, and moves on a re-root.
describe("the terminal explorer's header", () => {
  function build(home: string) {
    const host = document.createElement("div");
    document.body.append(host);
    const list = vi.fn(async (_paneKey: string, path: string) => listing[path] ?? []);
    return { host, view: createTerminalExplorer(host, home, { list, choose: vi.fn() }) };
  }

  const settleOnce = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));

  it("shows the root with $HOME collapsed to ~", async () => {
    const { view } = build("/Users/x");
    view.setRoot("tab-1", "/Users/x/projects/jarvis");
    await settleOnce();

    const header = view.element.querySelector(".terminal-explorer-header");
    expect(header?.textContent).toBe("~/projects/jarvis");
  });

  it("updates the header when the tree re-roots", async () => {
    const { view } = build("/Users/x");
    view.setRoot("tab-1", "/proj");
    await settleOnce();
    view.setRoot("tab-1", "/proj/src");
    await settleOnce();

    const header = view.element.querySelector(".terminal-explorer-header");
    expect(header?.textContent).toBe("/proj/src");
  });

  it("clears the header along with the tree", async () => {
    const { view } = build("/Users/x");
    view.setRoot("tab-1", "/proj");
    await settleOnce();

    view.clear();

    const header = view.element.querySelector(".terminal-explorer-header");
    expect(header?.textContent).toBe("");
  });

  // The one edge case worth re-checking here: a root that only shares a
  // text prefix with home must not collapse, which is exactly what the
  // reused function exists to get right.
  it("does not collapse a root that only shares a prefix with home", async () => {
    const { view } = build("/Users/x");
    view.setRoot("tab-1", "/Users/xavier/work");
    await settleOnce();

    const header = view.element.querySelector(".terminal-explorer-header");
    expect(header?.textContent).toBe("/Users/xavier/work");
  });
});
