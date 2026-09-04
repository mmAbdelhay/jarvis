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
    const list = vi.fn((path: string) => (path === "/proj/src" ? d.promise : Promise.resolve(listing[path] ?? [])));
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
});
