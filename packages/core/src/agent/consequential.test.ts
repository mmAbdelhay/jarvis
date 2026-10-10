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
        { lastTypedTarget: "Notes", focusedDescribed: { role: "text", name: "Notes" } },
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

  // Final review (security): Enter, Space, their modified variants and
  // Delete act on whatever has keyboard focus. They ask unless jarvis-cu's
  // live focus proves the control is a plain text field. Fail closed.
  describe("keyboard activation on each focus state", () => {
    type Focus = { role: string; name?: string } | undefined;
    const ENTERS = ["enter", "shift+enter", "alt+enter", "ctrl+shift+enter", "alt+shift+enter"];
    const SPACES = ["space", "shift+space", "ctrl+space", "ctrl+shift+space", "alt+shift+space"];
    const DELETES = ["delete", "ctrl+delete", "alt+delete", "ctrl+shift+delete"];
    const unsure: [string, Focus][] = [
      ["no focus reported", undefined],
      ["unknown focus", { role: "unknown" }],
      ["unknown focus with a name", { role: "unknown", name: "Search" }],
      ["a harmless-looking button", { role: "push button", name: "Open" }],
      ["an unnamed button", { role: "push button" }],
      ["an OK button", { role: "push button", name: "OK" }],
      ["a check box", { role: "check box", name: "Remember me" }],
      ["a menu item", { role: "menu item", name: "Export As…" }],
      ["a list item", { role: "list item", name: "photo.jpg" }],
      ["a table cell", { role: "table cell", name: "photo.jpg" }],
      ["a blank role", { role: "  " }],
    ];
    const ctx = (focus: Focus) => (focus === undefined ? {} : { focusedDescribed: focus });

    for (const [label, focus] of unsure) {
      it(`Enter, Space and Delete ask on ${label}`, () => {
        for (const combo of [...ENTERS, ...SPACES]) {
          expect(detectConsequence({ kind: "key", combo }, ctx(focus)), combo).toEqual({
            intent: "submit",
            source: "key",
          });
        }
        for (const combo of DELETES) {
          expect(detectConsequence({ kind: "key", combo }, ctx(focus)), combo).toEqual({
            intent: "delete",
            source: "key",
          });
        }
        // A plain-looking typed target never vouches for the focus.
        expect(
          detectConsequence(
            { kind: "key", combo: "enter" },
            { ...ctx(focus), lastTypedTarget: "Notes" },
          ),
        ).toEqual({ intent: "submit", source: "key" });
      });
    }

    it("a focused consequential control asks with its own intent", () => {
      const del = { role: "push button", name: "Delete" };
      const buy = { role: "push button", name: "Place your order" };
      for (const combo of [...ENTERS, ...SPACES]) {
        expect(detectConsequence({ kind: "key", combo }, ctx(del))?.intent, combo).toBe("delete");
        expect(detectConsequence({ kind: "key", combo }, ctx(buy))?.intent, combo).toBe("buy");
      }
      expect(detectConsequence({ kind: "key", combo: "delete" }, ctx(buy))?.intent).toBe("buy");
      expect(
        detectConsequence(
          { kind: "key", combo: "enter" },
          { ...ctx(del), lastTypedTarget: "Notes" },
        )?.intent,
      ).toBe("delete");
    });

    for (const role of [
      "text",
      "entry",
      "password text",
      "paragraph",
      "document text",
      "terminal",
    ]) {
      it(`a plain ${role} field lets Enter, Space and Delete through`, () => {
        const plain = { role, name: "Notes" };
        for (const combo of [...ENTERS, ...SPACES, ...DELETES]) {
          expect(detectConsequence({ kind: "key", combo }, ctx(plain)), combo).toBeUndefined();
        }
      });
    }

    it("Enter in a message field sends; Space and Delete there do not", () => {
      for (const focus of [chat, { role: "text", name: "اكتب رسالة" }]) {
        for (const combo of ENTERS) {
          expect(detectConsequence({ kind: "key", combo }, ctx(focus))?.intent, combo).toBe("send");
        }
        for (const combo of [...SPACES, ...DELETES]) {
          expect(detectConsequence({ kind: "key", combo }, ctx(focus)), combo).toBeUndefined();
        }
      }
      expect(
        detectConsequence(
          { kind: "key", combo: "enter" },
          { focusedDescribed: { role: "text" }, lastTypedTarget: "Message" },
        )?.intent,
      ).toBe("send");
    });

    // Enter in a dialog's file-name entry presses the dialog's default
    // button (GIMP's Export, a Save dialog's Save).
    it("Enter in a file-name field is a save", () => {
      for (const focus of [
        field,
        { role: "text", name: "اسم الملف" },
        { role: "text", name: "Filename" },
      ]) {
        for (const combo of ENTERS) {
          expect(detectConsequence({ kind: "key", combo }, ctx(focus))?.intent, combo).toBe("save");
        }
        expect(detectConsequence({ kind: "key", combo: "space" }, ctx(focus))).toBeUndefined();
        expect(detectConsequence({ kind: "key", combo: "delete" }, ctx(focus))).toBeUndefined();
      }
      expect(
        detectConsequence(
          { kind: "key", combo: "enter" },
          { focusedDescribed: { role: "text", name: "Name" }, lastTypedTarget: "File name" },
        )?.intent,
      ).toBe("save");
      expect(
        detectConsequence({ kind: "type", text: "beach.png\n", target: "File name" }, ctx(field))
          ?.intent,
      ).toBe("save");
    });

    it("the declared intent and the fixed shortcuts still win", () => {
      expect(
        detectConsequence({ kind: "key", combo: "ctrl+enter" }, ctx({ role: "text" }))?.intent,
      ).toBe("send");
      expect(
        detectConsequence({ kind: "key", combo: "shift+delete" }, ctx({ role: "text" }))?.intent,
      ).toBe("delete");
      expect(
        detectConsequence({ kind: "key", combo: "space", intent: "buy" }, ctx({ role: "text" }))
          ?.intent,
      ).toBe("buy");
    });

    it("other keys do not ask", () => {
      for (const combo of ["tab", "shift+tab", "escape", "backspace", "a", "ctrl+a", "down"]) {
        for (const [, focus] of unsure) {
          expect(detectConsequence({ kind: "key", combo }, ctx(focus)), combo).toBeUndefined();
        }
      }
    });
  });

  it("a typed newline or space presses the focused control", () => {
    const del = { focusedDescribed: { role: "push button", name: "Delete" } };
    const ok = { focusedDescribed: { role: "push button", name: "Open" } };
    expect(detectConsequence({ kind: "type", text: " ", target: "x" }, del)?.intent).toBe("delete");
    expect(detectConsequence({ kind: "type", text: "\n", target: "x" }, del)?.intent).toBe(
      "delete",
    );
    expect(detectConsequence({ kind: "type", text: "a b", target: "x" }, ok)?.intent).toBe(
      "submit",
    );
    expect(detectConsequence({ kind: "type", text: "ok\n", target: "Notes" })).toEqual({
      intent: "submit",
      source: "key",
    });
    // Recorded residual risk: a space with the focus unknown does not ask.
    expect(detectConsequence({ kind: "type", text: "a b", target: "Notes" })).toBeUndefined();
    expect(
      detectConsequence(
        { kind: "type", text: "beach png", target: "x" },
        { focusedDescribed: field },
      ),
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
