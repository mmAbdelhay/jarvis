// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { initPopped, isPopped, onPoppedChange, poppedTabs, setPoppedTabs } from "./popped.js";

describe("the popped tabs", () => {
  it("holds the ids it is given, ignoring anything that is not a string, and tells listeners only of a real change", () => {
    const seen: string[][] = [];
    const stop = onPoppedChange((ids) => seen.push([...ids]));
    expect(setPoppedTabs(["t1", 7, null, "t2"])).toBe(true);
    expect([...poppedTabs()]).toEqual(["t1", "t2"]);
    expect(isPopped("t1")).toBe(true);
    expect(isPopped("t3")).toBe(false);
    expect(setPoppedTabs(["t2", "t1"])).toBe(false);
    expect(setPoppedTabs("nope")).toBe(true);
    expect([...poppedTabs()]).toEqual([]);
    expect(seen).toEqual([["t1", "t2"], []]);
    stop();
    setPoppedTabs(["t9"]);
    expect(seen).toHaveLength(2);
    setPoppedTabs([]);
  });

  it("reads the list at start (the main window may have reloaded) and follows the host's pushes", async () => {
    let push: (ids: string[]) => void = () => {};
    const api = {
      popoutList: vi.fn(async () => ["t4"]),
      onPopoutChanged: vi.fn((cb: (ids: string[]) => void) => {
        push = cb;
        return () => {};
      }),
    };
    await initPopped(api);
    expect([...poppedTabs()]).toEqual(["t4"]);
    push(["t4", "t5"]);
    expect([...poppedTabs()]).toEqual(["t4", "t5"]);
    setPoppedTabs([]);
  });

  it("keeps a tab that left the set counted as popped until its return has been taken, then tells listeners once", async () => {
    let finish: () => void = () => {};
    const returned: string[] = [];
    const seen: string[][] = [];
    const stop = onPoppedChange((ids) => seen.push([...ids]));
    await initPopped(
      { popoutList: vi.fn(async () => ["t1"]), onPopoutChanged: vi.fn(() => () => {}) },
      (tabId) =>
        new Promise<void>((resolve) => {
          returned.push(tabId);
          finish = resolve;
        }),
    );
    expect(seen).toEqual([["t1"]]);
    setPoppedTabs([]);
    expect(returned).toEqual(["t1"]);
    expect(isPopped("t1")).toBe(true);
    expect(seen).toEqual([["t1"]]);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(isPopped("t1")).toBe(false);
    expect(seen).toEqual([["t1"], []]);
    // A tab that is popped again while settling is simply popped.
    stop();
  });

  it("still lets a tab go when taking its return fails", async () => {
    await initPopped(
      { popoutList: vi.fn(async () => ["t7"]), onPopoutChanged: vi.fn(() => () => {}) },
      async () => {
        throw new Error("no channel");
      },
    );
    setPoppedTabs([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isPopped("t7")).toBe(false);
  });

  it("starts with none when the host cannot say", async () => {
    await initPopped({
      popoutList: vi.fn(async () => {
        throw new Error("no channel");
      }),
      onPopoutChanged: vi.fn(() => () => {}),
    });
    expect([...poppedTabs()]).toEqual([]);
  });
});
