// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createFileTree } from "./file-tree.js";

const listing: Record<string, { name: string; directory: boolean }[]> = {
  "/proj": [
    { name: "src", directory: true },
    { name: "read me.md", directory: false },
  ],
  "/proj/src": [{ name: "main.ts", directory: false }],
};

function tree(overrides: Partial<Parameters<typeof createFileTree>[0]> = {}) {
  const list = vi.fn(async (path: string) => listing[path] ?? []);
  const choose = vi.fn();
  return { list, choose, tree: createFileTree({ list, choose, ...overrides }) };
}

/** A promise this test controls the settlement of, for asserting what
 *  happens while a `list()` call is still in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("the file tree", () => {
  it("lists its root and nothing deeper", async () => {
    const { tree: t, list } = tree();
    await t.setRoot("/proj");
    expect(t.element.textContent).toContain("src");
    expect(t.element.textContent).toContain("read me.md");
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith("/proj");
  });

  it("lists a folder only when it is expanded", async () => {
    const { tree: t, list } = tree();
    await t.setRoot("/proj");
    t.element.querySelector<HTMLElement>('[data-path="/proj/src"]')?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(list).toHaveBeenCalledWith("/proj/src");
    expect(t.element.textContent).toContain("main.ts");
  });

  it("collapses without losing what it had", async () => {
    const { tree: t, list } = tree();
    await t.setRoot("/proj");
    const folder = () => t.element.querySelector<HTMLElement>('[data-path="/proj/src"]');
    folder()?.click();
    await new Promise((r) => setTimeout(r, 0));
    folder()?.click();
    expect(t.element.textContent).not.toContain("main.ts");
    folder()?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.element.textContent).toContain("main.ts");
    // The whole point of caching the built rows is that a collapse/expand
    // cycle never asks for the listing again: one call for the root, one
    // for the one real expansion — not one per expand.
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not fire a second list() call for a folder double-clicked before the first resolves", async () => {
    const d = deferred<{ name: string; directory: boolean }[]>();
    const list = vi.fn((path: string) =>
      path === "/proj/src" ? d.promise : Promise.resolve(listing[path] ?? []),
    );
    const t = createFileTree({ list, choose: vi.fn() });
    await t.setRoot("/proj");

    const folder = t.element.querySelector<HTMLElement>('[data-path="/proj/src"]');
    folder?.click();
    folder?.click();
    await Promise.resolve();
    await Promise.resolve();
    // One call for the root, and only one for "/proj/src" despite the
    // second click landing while the first was still in flight.
    expect(list).toHaveBeenCalledTimes(2);

    d.resolve(listing["/proj/src"] ?? []);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.element.textContent).toContain("main.ts");
  });

  it("keeps the previous state when a folder's expansion listing throws", async () => {
    let fail = false;
    const { tree: t } = tree({
      list: async (p: string) => {
        if (p === "/proj/src" && fail) throw new Error("nope");
        return listing[p] ?? [];
      },
    });
    await t.setRoot("/proj");
    fail = true;
    t.element.querySelector<HTMLElement>('[data-path="/proj/src"]')?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.element.textContent).not.toContain("main.ts");
    expect(t.element.textContent).toContain("src");
  });

  it("hands a chosen file's full path to its caller and opens nothing", async () => {
    const { tree: t, choose } = tree();
    await t.setRoot("/proj");
    t.element.querySelector<HTMLElement>('[data-path="/proj/read me.md"]')?.click();
    expect(choose).toHaveBeenCalledWith("/proj/read me.md");
  });

  it("renders a name containing markup as text", async () => {
    const nasty: Record<string, { name: string; directory: boolean }[]> = {
      "/proj": [{ name: "<img src=x onerror=alert(1)>", directory: false }],
    };
    const { tree: t } = tree({ list: async (p: string) => nasty[p] ?? [] });
    await t.setRoot("/proj");
    expect(t.element.querySelector("img")).toBeNull();
    expect(t.element.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("shows an empty directory as empty rather than failing", async () => {
    const { tree: t } = tree({ list: async () => [] });
    await t.setRoot("/nothing");
    expect(t.element.textContent).toBe("");
    expect(t.root()).toBe("/nothing");
  });

  it("lets the most recently called setRoot win even when an earlier one resolves later", async () => {
    const first = deferred<{ name: string; directory: boolean }[]>();
    const second = deferred<{ name: string; directory: boolean }[]>();
    const answers = [first.promise, second.promise];
    let calls = 0;
    const list = vi.fn(() => {
      const answer = answers[calls] ?? Promise.resolve([]);
      calls += 1;
      return answer;
    });
    const t = createFileTree({ list, choose: vi.fn() });

    const p1 = t.setRoot("/a");
    const p2 = t.setRoot("/b");

    // The later call (/b) resolves first; the earlier call (/a) resolves
    // after it. Last *called* must still win, not last *resolved*.
    second.resolve([{ name: "b-child", directory: false }]);
    await p2;
    first.resolve([{ name: "a-child", directory: false }]);
    await p1;

    expect(t.root()).toBe("/b");
    expect(t.element.textContent).toContain("b-child");
    expect(t.element.textContent).not.toContain("a-child");
  });

  it("keeps the previous tree when a listing throws", async () => {
    let fail = false;
    const { tree: t } = tree({
      list: async (p: string) => {
        if (fail) throw new Error("nope");
        return listing[p] ?? [];
      },
    });
    await t.setRoot("/proj");
    fail = true;
    await t.setRoot("/proj/src");
    expect(t.element.textContent).toContain("src");
  });

  // Chevrons and the equal-width spacer are most of what makes the sidebar
  // read as a tree rather than a flat, unindented list of names.
  describe("chevrons", () => {
    it("shows a collapsed chevron on a folder row, and flips it on expand and collapse", async () => {
      const { tree: t } = tree();
      await t.setRoot("/proj");

      const chevron = t.element.querySelector<HTMLElement>(
        '[data-path="/proj/src"] .file-tree-chevron',
      );
      expect(chevron?.textContent).toBe("▸");

      chevron?.closest<HTMLElement>(".file-tree-row")?.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(chevron?.textContent).toBe("▾");

      chevron?.closest<HTMLElement>(".file-tree-row")?.click();
      expect(chevron?.textContent).toBe("▸");
    });

    it("gives a file row a spacer, not a chevron", async () => {
      const { tree: t } = tree();
      await t.setRoot("/proj");

      const fileRow = t.element.querySelector<HTMLElement>('[data-path="/proj/read me.md"]');
      expect(fileRow?.querySelector(".file-tree-chevron")).toBeNull();
      expect(fileRow?.querySelector(".file-tree-spacer")).not.toBeNull();
    });
  });

  // A truncated name (styles.css clips overflow with an ellipsis) still
  // needs to be identifiable on hover — the full name goes on as a `title`
  // attribute, not into any markup.
  it("carries the full name as a title attribute, on both a file and a folder", async () => {
    const { tree: t } = tree();
    await t.setRoot("/proj");

    const fileName = t.element.querySelector<HTMLElement>(
      '[data-path="/proj/read me.md"] .file-tree-name',
    );
    const folderName = t.element.querySelector<HTMLElement>(
      '[data-path="/proj/src"] .file-tree-name',
    );
    expect(fileName?.getAttribute("title")).toBe("read me.md");
    expect(folderName?.getAttribute("title")).toBe("src");
  });

  // styles.css clips a long name with `white-space: pre` rather than
  // `nowrap` specifically so this survives: `nowrap` collapses a run of
  // spaces to one before rendering, `pre` does not. The DOM side of that —
  // the exact string reaching the name span, unmangled — is what this
  // pins; terminal-explorer-css.test.ts pins the CSS declaration itself.
  it("keeps both spaces of a double-space file name in the row's own text", async () => {
    const twoSpaces: Record<string, { name: string; directory: boolean }[]> = {
      "/proj": [{ name: "read  me.md", directory: false }],
    };
    const { tree: t } = tree({ list: async (p: string) => twoSpaces[p] ?? [] });
    await t.setRoot("/proj");

    const fileName = t.element.querySelector<HTMLElement>(
      '[data-path="/proj/read  me.md"] .file-tree-name',
    );
    expect(fileName?.textContent).toBe("read  me.md");
    expect(fileName?.getAttribute("title")).toBe("read  me.md");
  });
});

describe("reloading the file tree in place", () => {
  /** A mutable disk this describe owns, so one test's edits never leak. */
  function disk() {
    const entries: Record<string, { name: string; directory: boolean }[]> = {
      "/proj": [
        { name: "src", directory: true },
        { name: "a.md", directory: false },
      ],
      "/proj/src": [
        { name: "lib", directory: true },
        { name: "main.ts", directory: false },
      ],
      "/proj/src/lib": [{ name: "util.ts", directory: false }],
    };
    const list = vi.fn(async (path: string) => entries[path] ?? []);
    return { entries, list, tree: createFileTree({ list, choose: vi.fn() }) };
  }

  const row = (t: { element: HTMLElement }, path: string) =>
    t.element.querySelector<HTMLElement>(`[data-path="${path}"]`);
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  async function expand(t: { element: HTMLElement }, path: string) {
    row(t, path)?.click();
    await settle();
  }

  it("keeps open folders open, nested ones included, when a parent's listing changed", async () => {
    const { entries, tree: t } = disk();
    await t.setRoot("/proj");
    await expand(t, "/proj/src");
    await expand(t, "/proj/src/lib");

    entries["/proj"] = [...(entries["/proj"] ?? []), { name: "b.md", directory: false }];
    entries["/proj/src/lib"] = [{ name: "fresh.ts", directory: false }];
    await t.reload();

    expect(row(t, "/proj/b.md")).not.toBeNull();
    expect(row(t, "/proj/src/lib/fresh.ts")).not.toBeNull();
    expect(row(t, "/proj/src/lib/util.ts")).toBeNull();
  });

  it("leaves the very same rows in place when nothing changed", async () => {
    const { tree: t } = disk();
    await t.setRoot("/proj");
    await expand(t, "/proj/src");
    const before = row(t, "/proj/src/main.ts");

    await t.reload();

    expect(row(t, "/proj/src/main.ts")).toBe(before);
  });

  it("forgets a collapsed folder, so its next expansion lists it fresh", async () => {
    const { entries, list, tree: t } = disk();
    await t.setRoot("/proj");
    await expand(t, "/proj/src");
    await expand(t, "/proj/src"); // collapse
    entries["/proj/src"] = [{ name: "new.ts", directory: false }];

    await t.reload();
    const calls = list.mock.calls.length;
    await expand(t, "/proj/src");

    expect(list.mock.calls.length).toBe(calls + 1);
    expect(row(t, "/proj/src/new.ts")).not.toBeNull();
  });

  it("does nothing before it has a root", async () => {
    const { list, tree: t } = disk();
    await t.reload();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("typing a name in the file tree", () => {
  function setup() {
    const list = vi.fn(async (path: string) => listing[path] ?? []);
    const t = createFileTree({ list, choose: vi.fn() });
    document.body.append(t.element);
    return { list, t };
  }

  function type(input: HTMLInputElement | null, value: string, key: string) {
    if (input === null) throw new Error("no name field");
    input.value = value;
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }

  const field = (t: { element: HTMLElement }) =>
    t.element.querySelector<HTMLInputElement>(".file-tree-input");

  it("draws a new row at the top of the folder and resolves with the name on Enter", async () => {
    const { t } = setup();
    await t.setRoot("/proj");
    const pending = t.edit({ kind: "create", parent: "/proj", entry: "file" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(t.element.firstElementChild?.classList.contains("file-tree-editing")).toBe(true);
    type(field(t), "notes.md", "Enter");

    await expect(pending).resolves.toBe("notes.md");
    expect(field(t)).toBeNull();
  });

  it("expands a closed folder to create inside it", async () => {
    const { t } = setup();
    await t.setRoot("/proj");
    const pending = t.edit({ kind: "create", parent: "/proj/src", entry: "directory" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const children = t.element.querySelector<HTMLElement>(".file-tree-children");
    expect(children?.hidden).toBe(false);
    expect(children?.querySelector(".file-tree-input")).not.toBeNull();
    type(field(t), "", "Escape");
    await expect(pending).resolves.toBeUndefined();
  });

  it("renames in place, preselecting the name without its extension", async () => {
    const { t } = setup();
    await t.setRoot("/proj");
    const pending = t.edit({ kind: "rename", path: "/proj/read me.md" });
    const input = field(t);

    expect(input?.value).toBe("read me.md");
    expect([input?.selectionStart, input?.selectionEnd]).toEqual([0, "read me".length]);
    type(input, "readme.md", "Enter");

    await expect(pending).resolves.toBe("readme.md");
    const label = t.element.querySelector<HTMLElement>(
      '[data-path="/proj/read me.md"] .file-tree-name',
    );
    expect(label?.hidden).toBe(false);
  });

  it("treats Enter on an unchanged or empty name as a cancel", async () => {
    const { t } = setup();
    await t.setRoot("/proj");
    const same = t.edit({ kind: "rename", path: "/proj/read me.md" });
    type(field(t), "read me.md", "Enter");
    await expect(same).resolves.toBeUndefined();

    const empty = t.edit({ kind: "rename", path: "/proj/read me.md" });
    type(field(t), "", "Enter");
    await expect(empty).resolves.toBeUndefined();
  });

  it("keeps the terminal from seeing the keys typed into the field", async () => {
    const { t } = setup();
    await t.setRoot("/proj");
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    void t.edit({ kind: "rename", path: "/proj/read me.md" });
    type(field(t), "x", "a");
    document.removeEventListener("keydown", outside);
    expect(outside).not.toHaveBeenCalled();
  });

  it("does not reload under a name being typed, and cancels it on a re-root", async () => {
    const { list, t } = setup();
    await t.setRoot("/proj");
    const pending = t.edit({ kind: "rename", path: "/proj/read me.md" });
    const calls = list.mock.calls.length;

    await t.reload();
    expect(list.mock.calls.length).toBe(calls);

    await t.setRoot("/proj/src");
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("the file tree's context menu hook", () => {
  it("reports a row as its target and the empty space below as the root", async () => {
    const menu = vi.fn();
    const t = createFileTree({ list: async (p) => listing[p] ?? [], choose: vi.fn(), menu });
    await t.setRoot("/proj");

    t.element
      .querySelector('[data-path="/proj/src"]')
      ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 3, clientY: 4 }));
    t.element.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 6 }),
    );

    expect(menu.mock.calls).toEqual([
      [{ path: "/proj/src", directory: true }, 3, 4],
      [undefined, 5, 6],
    ]);
  });
});
