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
});
