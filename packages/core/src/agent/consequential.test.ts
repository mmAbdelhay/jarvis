// packages/core/src/agent/consequential.test.ts
import { describe, expect, it } from "vitest";
import { detectConsequence, labelIntent, normalizeLabel } from "./consequential.js";
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

  it("Enter after typing into a message field is a send", () => {
    expect(
      detectConsequence({ kind: "key", combo: "enter" }, { lastTypedTarget: "Message" })?.intent,
    ).toBe("send");
    expect(
      detectConsequence({ kind: "key", combo: "enter" }, { lastTypedTarget: "اكتب رسالة" })?.intent,
    ).toBe("send");
    expect(
      detectConsequence({ kind: "key", combo: "enter" }, { lastTypedTarget: "File name" }),
    ).toBeUndefined();
    expect(detectConsequence({ kind: "key", combo: "enter" })).toBeUndefined();
  });

  it("drags onto a trash are deletes", () => {
    expect(
      detectConsequence({ kind: "drag", x1: 1, y1: 1, x2: 2, y2: 2, target: "Trash" })?.intent,
    ).toBe("delete");
  });
});

describe("detectConsequence with AT-SPI description (contracts section 4 #2)", () => {
  it("uses the accessible name instead of the model's target text", () => {
    expect(
      detectConsequence(click("Cancel"), { described: { role: "push button", name: "Delete" } })
        ?.intent,
    ).toBe("delete");
    expect(
      detectConsequence(click("Delete"), { described: { role: "push button", name: "Cancel" } }),
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
