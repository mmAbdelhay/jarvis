// packages/core/src/agent/consequential.test.ts
import { describe, expect, it } from "vitest";
import { detectConsequence, focusAfterKey, labelIntent, normalizeLabel } from "./consequential.js";
import type { ScreenAction } from "./screen-tools.js";

const click = (
  target: string,
  extra: Partial<Extract<ScreenAction, { kind: "click" }>> = {},
): ScreenAction => ({
  kind: "click",
  x: 1,
  y: 1,
  button: "left",
  double: false,
  target,
  ...extra,
});

describe("detectConsequence", () => {
  it("trusts the declared intent first", () => {
    expect(detectConsequence(click("OK", { intent: "delete" }))).toEqual({
      intent: "delete",
      source: "declared",
    });
    expect(detectConsequence({ kind: "key", combo: "enter", intent: "submit" })).toEqual({
      intent: "submit",
      source: "declared",
    });
  });

  it("finds English button labels", () => {
    const cases: [string, string][] = [
      ["Export", "save"],
      ["Save", "save"],
      ["Replace", "overwrite"],
      ["Delete", "delete"],
      ["Move to Trash", "delete"],
      ["Send", "send"],
      ["Post comment", "send"],
      ["Submit", "submit"],
      ["Buy now", "buy"],
      ["Place order", "buy"],
      ["Pay $12.99", "buy"],
      ["Install", "install"],
    ];
    for (const [label, intent] of cases) {
      expect(detectConsequence(click(label))?.intent, label).toBe(intent);
    }
  });

  it("finds Arabic button labels, with diacritics, alef forms and clitics", () => {
    const cases: [string, string][] = [
      ["حفظ", "save"],
      ["احفَظ", "save"],
      ["تصدير", "save"],
      ["استبدال", "overwrite"],
      ["حذف", "delete"],
      ["احذف الملف", "delete"],
      ["إرسال", "send"],
      ["أرسل", "send"],
      ["والإرسال", "send"],
      ["تأكيد", "submit"],
      ["شراء الآن", "buy"],
      ["ادفع", "buy"],
      ["تثبيت", "install"],
    ];
    for (const [label, intent] of cases) {
      expect(detectConsequence(click(label))?.intent, label).toBe(intent);
    }
  });

  it("leaves harmless clicks, menus that open a dialog, and non-left buttons alone", () => {
    for (const label of [
      "File",
      "Open",
      "Cancel",
      "Image",
      "Export As…",
      "Save As...",
      "ملف",
      "فتح",
      "إلغاء",
    ]) {
      expect(detectConsequence(click(label)), label).toBeUndefined();
    }
    expect(detectConsequence(click("Delete", { button: "right" }))).toBeUndefined();
    expect(detectConsequence({ kind: "type", text: "beach", target: "Name" })).toBeUndefined();
    expect(detectConsequence({ kind: "scroll", x: 1, y: 1, dx: 0, dy: 1 })).toBeUndefined();
  });

  it("knows the save, delete and send shortcuts", () => {
    expect(detectConsequence({ kind: "key", combo: "ctrl+s" })?.intent).toBe("save");
    expect(detectConsequence({ kind: "key", combo: "ctrl+shift+s" })?.intent).toBe("save");
    expect(detectConsequence({ kind: "key", combo: "shift+delete" })?.intent).toBe("delete");
    expect(detectConsequence({ kind: "key", combo: "ctrl+enter" })?.intent).toBe("send");
    expect(detectConsequence({ kind: "key", combo: "tab" })).toBeUndefined();
  });

  const field = { role: "text", name: "File name" };
  const chat = { role: "entry", name: "Type a message" };

  it("Enter after typing into a message field is a send", () => {
    expect(
      detectConsequence(
        { kind: "key", combo: "enter" },
        { lastTypedTarget: "Message", focusedDescribed: { role: "text" } },
      )?.intent,
    ).toBe("send");
    expect(
      detectConsequence(
        { kind: "key", combo: "enter" },
        { lastTypedTarget: "اكتب رسالة", focusedDescribed: { role: "text" } },
      )?.intent,
    ).toBe("send");
    expect(
      detectConsequence({ kind: "key", combo: "enter" }, { focusedDescribed: chat })?.intent,
    ).toBe("send");
    expect(
      detectConsequence(
        { kind: "key", combo: "enter" },
        { lastTypedTarget: "File name", focusedDescribed: field },
      ),
    ).toBeUndefined();
  });

  it("a typed newline into a message field is a send", () => {
    const text = { focusedDescribed: { role: "text" } };
    expect(detectConsequence({ kind: "type", text: "hi\n", target: "Message" }, text)?.intent).toBe(
      "send",
    );
    expect(
      detectConsequence({ kind: "type", text: "a\nb", target: "اكتب رسالة" }, text)?.intent,
    ).toBe("send");
    expect(
      detectConsequence({ kind: "type", text: "hi", target: "Message" }, text),
    ).toBeUndefined();
    expect(
      detectConsequence({ kind: "type", text: "a\nb", target: "Notes" }, text),
    ).toBeUndefined();
  });

  // Final review finding 3: Enter or Space activates whatever has keyboard
  // focus. click a field -> Tab -> Enter must not press a focused Delete or
  // Buy button without a card.
  it("Enter or Space on an unknown focus asks", () => {
    for (const combo of ["enter", "space", "shift+enter", "shift+space"]) {
      expect(detectConsequence({ kind: "key", combo })).toEqual({
        intent: "submit",
        source: "key",
      });
      expect(
        detectConsequence({ kind: "key", combo }, { focusedDescribed: { role: "unknown" } }),
      ).toEqual({ intent: "submit", source: "key" });
    }
    expect(
      detectConsequence({ kind: "key", combo: "enter" }, { lastTypedTarget: "File name" }),
    ).toEqual({ intent: "submit", source: "key" });
    expect(detectConsequence({ kind: "type", text: "ok\n", target: "File name" })).toEqual({
      intent: "submit",
      source: "key",
    });
  });

  it("Enter or Space on a focused consequential button asks with its intent", () => {
    const del = { focusedDescribed: { role: "push button", name: "Delete" } };
    const buy = { focusedDescribed: { role: "push button", name: "Place your order" } };
    expect(detectConsequence({ kind: "key", combo: "enter" }, del)?.intent).toBe("delete");
    expect(detectConsequence({ kind: "key", combo: "space" }, del)?.intent).toBe("delete");
    expect(detectConsequence({ kind: "key", combo: "enter" }, buy)?.intent).toBe("buy");
    // A typed space or newline presses the focused button too.
    expect(detectConsequence({ kind: "type", text: " ", target: "x" }, del)?.intent).toBe("delete");
    expect(detectConsequence({ kind: "type", text: "\n", target: "x" }, buy)?.intent).toBe("buy");
    // A lying lastTypedTarget does not hide the focused button.
    expect(
      detectConsequence({ kind: "key", combo: "enter" }, { ...del, lastTypedTarget: "Notes" })
        ?.intent,
    ).toBe("delete");
  });

  it("Enter or Space on a harmless focused control does not ask", () => {
    const ok = { focusedDescribed: { role: "push button", name: "Open" } };
    expect(detectConsequence({ kind: "key", combo: "enter" }, ok)).toBeUndefined();
    expect(detectConsequence({ kind: "key", combo: "space" }, { focusedDescribed: field })).toBe(
      undefined,
    );
    expect(
      detectConsequence(
        { kind: "type", text: "beach png", target: "x" },
        { focusedDescribed: field },
      ),
    ).toBeUndefined();
  });

  it("a bare Delete outside a text field is a delete", () => {
    expect(detectConsequence({ kind: "key", combo: "delete" })?.intent).toBe("delete");
    expect(
      detectConsequence(
        { kind: "key", combo: "delete" },
        { focusedDescribed: { role: "table cell", name: "photo.jpg" } },
      )?.intent,
    ).toBe("delete");
    expect(
      detectConsequence({ kind: "key", combo: "delete" }, { focusedDescribed: field }),
    ).toBeUndefined();
  });

  it("drags onto a trash are deletes", () => {
    expect(
      detectConsequence({ kind: "drag", x1: 1, y1: 1, x2: 2, y2: 2, target: "Trash" })?.intent,
    ).toBe("delete");
  });
});

describe("detectConsequence with AT-SPI description (contracts section 4 #2)", () => {
  it("reads a consequence from the accessible name even when the model says otherwise", () => {
    expect(
      detectConsequence(click("Cancel"), { described: { role: "push button", name: "Delete" } })
        ?.intent,
    ).toBe("delete");
  });

  it("still asks when the model names a consequence but AT-SPI gives a generic name", () => {
    expect(
      detectConsequence(click("Send"), { described: { role: "panel", name: "Compose" } })?.intent,
    ).toBe("send");
    expect(
      detectConsequence(click("Delete"), { described: { role: "push button", name: "Cancel" } })
        ?.intent,
    ).toBe("delete");
    expect(
      detectConsequence(
        { kind: "drag", x1: 1, y1: 1, x2: 2, y2: 2, target: "Trash" },
        { described: { role: "icon", name: "photo.jpg" } },
      )?.intent,
    ).toBe("delete");
  });

  it("does not ask when neither name nor target is consequential", () => {
    expect(
      detectConsequence(click("Open"), { described: { role: "push button", name: "Cancel" } }),
    ).toBeUndefined();
  });

  it("falls back to the model's target when the role is unknown or the name is empty", () => {
    expect(detectConsequence(click("Delete"), { described: { role: "unknown" } })?.intent).toBe(
      "delete",
    );
    expect(
      detectConsequence(click("Delete"), { described: { role: "push button", name: "" } })?.intent,
    ).toBe("delete");
  });

  it("still lets the declared intent win", () => {
    expect(
      detectConsequence(click("x", { intent: "send" }), {
        described: { role: "push button", name: "Cancel" },
      }),
    ).toEqual({ intent: "send", source: "declared" });
  });
});

describe("normalizeLabel / labelIntent", () => {
  it("normalises Arabic spelling variants", () => {
    expect(normalizeLabel("إرسالُ")).toBe(normalizeLabel("ارسال"));
    expect(normalizeLabel("رسالة")).toBe(normalizeLabel("رساله"));
  });

  it("prefers overwrite over save for a replace dialog", () => {
    expect(labelIntent("Replace file")).toBe("overwrite");
  });
});

describe("focusAfterKey", () => {
  const field = { role: "text", name: "Search" };
  it("forgets the focused control after any key that can move focus", () => {
    for (const combo of [
      "tab",
      "shift+tab",
      "up",
      "down",
      "left",
      "right",
      "pagedown",
      "f6",
      "enter",
      "escape",
      "ctrl+l",
      "ctrl+tab",
    ]) {
      expect(focusAfterKey(combo, { role: "push button", name: "Open" })).toBeUndefined();
    }
    for (const combo of ["tab", "shift+tab", "enter", "escape", "f6", "ctrl+tab"]) {
      expect(focusAfterKey(combo, field)).toBeUndefined();
    }
  });

  it("keeps a text field across editing keys only", () => {
    for (const combo of [
      "backspace",
      "delete",
      "ctrl+a",
      "ctrl+c",
      "ctrl+v",
      "ctrl+x",
      "ctrl+z",
      "home",
      "end",
      "left",
      "right",
      "shift+left",
      "shift+end",
    ]) {
      expect(focusAfterKey(combo, field)).toEqual(field);
    }
    expect(focusAfterKey("left", { role: "list item", name: "a" })).toBeUndefined();
    expect(focusAfterKey("backspace", undefined)).toBeUndefined();
  });
});

describe("labelIntent buy phrases (V7)", () => {
  it("catches common checkout labels", () => {
    for (const label of [
      "Place your order",
      "Continue to payment",
      "Pay now",
      "Complete order",
      "Proceed to payment",
      "متابعة الدفع",
      "إتمام الشراء",
    ]) {
      expect(labelIntent(label)).toBe("buy");
    }
  });
});
