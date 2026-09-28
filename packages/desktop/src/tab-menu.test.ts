import { describe, expect, it, vi } from "vitest";
import { tabMenuTemplate } from "./tab-menu.js";

describe("tabMenuTemplate", () => {
  it("orders the items Rename, Reload, Close, Plans with their given labels", () => {
    const template = tabMenuTemplate(
      { rename: "Rename", reload: "Reload", close: "Close", plans: "Plans" },
      { onRename: vi.fn(), onReload: vi.fn(), onClose: vi.fn(), onPlans: vi.fn() },
    );

    expect(template.map((item) => item.label)).toEqual(["Rename", "Reload", "Close", "Plans"]);
  });

  it("wires each item's click to its own callback, not another item's", () => {
    const callbacks = { onRename: vi.fn(), onReload: vi.fn(), onClose: vi.fn(), onPlans: vi.fn() };
    const template = tabMenuTemplate(
      { rename: "Rename", reload: "Reload", close: "Close", plans: "Plans" },
      callbacks,
    );

    const click = (index: number): void => (template[index]?.click as (() => void) | undefined)?.();

    click(0);
    expect(callbacks.onRename).toHaveBeenCalledTimes(1);
    expect(callbacks.onReload).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(callbacks.onPlans).not.toHaveBeenCalled();

    click(1);
    expect(callbacks.onReload).toHaveBeenCalledTimes(1);

    click(2);
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);

    click(3);
    expect(callbacks.onPlans).toHaveBeenCalledTimes(1);
  });

  // Task 8 fix round 1: a non-terminal tab has no plan panel of its own,
  // so its chip's menu leaves the item out entirely rather than offering
  // an action that does nothing.
  it("omits Plans when showPlans is false, keeping Rename/Reload/Close", () => {
    const callbacks = { onRename: vi.fn(), onReload: vi.fn(), onClose: vi.fn(), onPlans: vi.fn() };
    const template = tabMenuTemplate(
      { rename: "Rename", reload: "Reload", close: "Close", plans: "Plans" },
      callbacks,
      { showPlans: false },
    );

    expect(template.map((item) => item.label)).toEqual(["Rename", "Reload", "Close"]);
  });

  it("includes Plans by default, and when showPlans is explicitly true", () => {
    const withDefault = tabMenuTemplate(
      { rename: "Rename", reload: "Reload", close: "Close", plans: "Plans" },
      { onRename: vi.fn(), onReload: vi.fn(), onClose: vi.fn(), onPlans: vi.fn() },
    );
    const withExplicitTrue = tabMenuTemplate(
      { rename: "Rename", reload: "Reload", close: "Close", plans: "Plans" },
      { onRename: vi.fn(), onReload: vi.fn(), onClose: vi.fn(), onPlans: vi.fn() },
      { showPlans: true },
    );

    expect(withDefault.map((item) => item.label)).toEqual(["Rename", "Reload", "Close", "Plans"]);
    expect(withExplicitTrue.map((item) => item.label)).toEqual([
      "Rename",
      "Reload",
      "Close",
      "Plans",
    ]);
  });

  it("passes localized (Arabic) labels straight through", () => {
    const template = tabMenuTemplate(
      { rename: "إعادة تسمية", reload: "إعادة تحميل", close: "إغلاق", plans: "الخطط" },
      { onRename: vi.fn(), onReload: vi.fn(), onClose: vi.fn(), onPlans: vi.fn() },
    );

    expect(template.map((item) => item.label)).toEqual([
      "إعادة تسمية",
      "إعادة تحميل",
      "إغلاق",
      "الخطط",
    ]);
  });
});
