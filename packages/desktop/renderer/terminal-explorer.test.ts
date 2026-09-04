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
  return { host, list, choose, view: createTerminalExplorer(host, { list, choose }) };
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
    const view = createTerminalExplorer(host, { list, choose: vi.fn() });
    expect(() => view.setRoot("tab-1", "/proj")).not.toThrow();
    await settle();
    expect(view.element.textContent).toBe("");
  });
});
