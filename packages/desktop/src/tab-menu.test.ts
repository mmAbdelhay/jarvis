import { describe, expect, it, vi } from "vitest";
import { tabMenuTemplate } from "./tab-menu.js";

describe("tabMenuTemplate", () => {
  it("orders the items Rename, Reload, Close with their given labels", () => {
    const template = tabMenuTemplate(
      { rename: "Rename", reload: "Reload", close: "Close" },
      { onRename: vi.fn(), onReload: vi.fn(), onClose: vi.fn() },
    );

    expect(template.map((item) => item.label)).toEqual(["Rename", "Reload", "Close"]);
  });

  it("wires each item's click to its own callback, not another item's", () => {
    const callbacks = { onRename: vi.fn(), onReload: vi.fn(), onClose: vi.fn() };
    const template = tabMenuTemplate(
      { rename: "Rename", reload: "Reload", close: "Close" },
      callbacks,
    );

    const click = (index: number): void => (template[index]?.click as (() => void) | undefined)?.();

    click(0);
    expect(callbacks.onRename).toHaveBeenCalledTimes(1);
    expect(callbacks.onReload).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();

    click(1);
    expect(callbacks.onReload).toHaveBeenCalledTimes(1);

    click(2);
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });

  it("passes localized (Arabic) labels straight through", () => {
    const template = tabMenuTemplate(
      { rename: "إعادة تسمية", reload: "إعادة تحميل", close: "إغلاق" },
      { onRename: vi.fn(), onReload: vi.fn(), onClose: vi.fn() },
    );

    expect(template.map((item) => item.label)).toEqual(["إعادة تسمية", "إعادة تحميل", "إغلاق"]);
  });
});
