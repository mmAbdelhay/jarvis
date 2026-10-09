// packages/core/src/agent/consequential.ts
// Rafiq v1.1 contracts §2 / design §2.5: actions that save, overwrite,
// delete, send, submit, buy or install get their own card. Found by the
// model's declared intent, known shortcuts, and English/Arabic label words
// on the target the model names. The label is the model's reading of the
// screen, so this errs toward asking. Pure.
import type { CuIntent, ScreenAction } from "./screen-tools.js";

export type CuConsequence = CuIntent | "install";
export type DescribedTarget = { role: string; name?: string };
export type ConsequenceFinding = { intent: CuConsequence; source: "declared" | "label" | "key" };

const KEY_CONSEQUENCES: Readonly<Record<string, CuConsequence>> = {
  "ctrl+s": "save",
  "ctrl+shift+s": "save",
  "shift+delete": "delete",
  "ctrl+enter": "send",
};
// Final review finding 3: these press whatever has keyboard focus.
const ACTIVATE_KEYS: ReadonlySet<string> = new Set([
  "enter",
  "shift+enter",
  "space",
  "shift+space",
]);
const ENTER_KEYS: ReadonlySet<string> = new Set(["enter", "shift+enter"]);
// Roles whose Enter/Space/Delete edit text instead of pressing something.
const TEXT_ROLES: ReadonlySet<string> = new Set([
  "text",
  "entry",
  "password text",
  "paragraph",
  "document text",
  "editbar",
  "spin button",
  "terminal",
]);
// Keys that keep keyboard focus inside a text field (caret moves and edits).
const TEXT_EDIT_KEYS: ReadonlySet<string> = new Set([
  "backspace",
  "delete",
  "home",
  "end",
  "left",
  "right",
  "shift+home",
  "shift+end",
  "shift+left",
  "shift+right",
  "ctrl+a",
  "ctrl+c",
  "ctrl+v",
  "ctrl+x",
  "ctrl+z",
  "ctrl+y",
  "ctrl+shift+z",
  "ctrl+left",
  "ctrl+right",
  "ctrl+backspace",
]);

// Checked in this order: the first family with a matching phrase wins.
const LABELS: readonly (readonly [CuConsequence, readonly string[]])[] = [
  [
    "buy",
    [
      "buy",
      "purchase",
      "pay",
      "checkout",
      "check out",
      "place order",
      "place your order",
      "complete order",
      "order now",
      "payment",
      "subscribe",
      "donate",
      "شراء",
      "اشتر",
      "اشتري",
      "ادفع",
      "دفع",
      "اتمام الطلب",
      "اشتراك",
      "اشترك",
      "تبرع",
    ],
  ],
  [
    "delete",
    [
      "delete",
      "remove",
      "erase",
      "trash",
      "move to trash",
      "discard",
      "wipe",
      "empty",
      "حذف",
      "احذف",
      "ازاله",
      "ازل",
      "مسح",
      "امسح",
      "سله المهملات",
      "تجاهل",
    ],
  ],
  ["overwrite", ["overwrite", "replace", "استبدال", "استبدل", "الكتابه فوق"]],
  [
    "send",
    [
      "send",
      "post",
      "reply",
      "share",
      "publish",
      "forward",
      "tweet",
      "ارسال",
      "ارسل",
      "نشر",
      "انشر",
      "مشاركه",
      "شارك",
      "رد",
    ],
  ],
  [
    "submit",
    ["submit", "confirm", "sign up", "register", "تقديم", "قدم", "تاكيد", "اكد", "تسجيل", "اعتماد"],
  ],
  ["install", ["install", "update now", "upgrade", "تثبيت", "ثبت", "ترقيه", "تحديث الان"]],
  ["save", ["save", "export", "keep changes", "حفظ", "احفظ", "تصدير", "صدر"]],
];
const SEND_FIELDS: readonly string[] = [
  "message",
  "chat",
  "comment",
  "reply",
  "email",
  "mail",
  "post",
  "tweet",
  "رساله",
  "تعليق",
  "رد",
  "بريد",
  "دردشه",
];

const DIACRITICS = /[ً-ٰٟـ]/g;
const AR_PREFIXES: readonly string[] = ["وال", "بال", "فال", "كال", "لل", "ال", "و", "ف", "ب", "ل"];

export function normalizeLabel(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

function tokens(text: string): string[] {
  return normalizeLabel(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "");
}

function sameWord(token: string, word: string): boolean {
  if (token === word) return true;
  if (!/\p{Script=Arabic}/u.test(word)) return false;
  return AR_PREFIXES.some(
    (prefix) => token.startsWith(prefix) && token.slice(prefix.length) === word,
  );
}

function hasPhrase(labelTokens: readonly string[], phrase: string): boolean {
  const words = tokens(phrase);
  if (words.length === 0) return false;
  for (let i = 0; i + words.length <= labelTokens.length; i++) {
    if (words.every((word, j) => sameWord(labelTokens[i + j] as string, word))) return true;
  }
  return false;
}

/** GUI convention: "Export As…" opens a dialog; the dialog's button is the effect. */
export function opensDialog(label: string): boolean {
  return /(…|\.\.\.)\s*$/.test(label.trim());
}

export function labelIntent(label: string): CuConsequence | undefined {
  if (opensDialog(label)) return undefined;
  const labelTokens = tokens(label);
  for (const [intent, phrases] of LABELS) {
    if (phrases.some((phrase) => hasPhrase(labelTokens, phrase))) return intent;
  }
  return undefined;
}

function isSendField(target: string): boolean {
  const labelTokens = tokens(target);
  return SEND_FIELDS.some((word) => hasPhrase(labelTokens, word));
}

function known(focused: DescribedTarget | undefined): focused is DescribedTarget {
  return focused !== undefined && focused.role !== "unknown";
}

function isTextRole(focused: DescribedTarget | undefined): boolean {
  return known(focused) && TEXT_ROLES.has(focused.role.trim().toLowerCase());
}

/**
 * What still has keyboard focus after `combo` was pressed, as far as V can
 * tell without asking again: a text field survives caret moves and edits;
 * any other key (Tab, arrows in a list, Enter, Escape, shortcuts) may move
 * focus, so the control is forgotten.
 */
export function focusAfterKey(
  combo: string,
  focused: DescribedTarget | undefined,
): DescribedTarget | undefined {
  return isTextRole(focused) && TEXT_EDIT_KEYS.has(combo) ? focused : undefined;
}

// Enter or Space (key, or typed newline/space) presses the focused control.
// Unknown focus asks (it may be a default button); a text field only sends
// when it is a message field; any other control asks when its accessible
// name names a consequence.
function activation(
  enter: boolean,
  target: string | undefined,
  focused: DescribedTarget | undefined,
  unknownAsks: boolean,
): ConsequenceFinding | undefined {
  if (!known(focused)) return unknownAsks ? { intent: "submit", source: "key" } : undefined;
  if (isTextRole(focused)) {
    return enter && isSendFieldOf(target, focused) ? { intent: "send", source: "key" } : undefined;
  }
  const name = focused.name?.trim() ?? "";
  const intent = name === "" ? undefined : labelIntent(name);
  return intent === undefined ? undefined : { intent, source: "key" };
}

// The field the keyboard goes to: the model's target text OR the accessible
// name of the focused control (so a lying target cannot hide a chat box).
function isSendFieldOf(target: string | undefined, focused: DescribedTarget | undefined): boolean {
  if (target !== undefined && isSendField(target)) return true;
  if (focused === undefined || focused.role === "unknown") return false;
  const name = focused.name?.trim() ?? "";
  return name !== "" && isSendField(name);
}

// Contracts section 4 #2: the model's text alone is not trusted, but it is not
// ignored either. When jarvis-cu's describeAt names the control under the
// pointer, that accessible name is read first and wins when it names a
// consequence; otherwise the model's own target is still checked, because
// AT-SPI often reports a container or generic name for custom-drawn and
// web controls. Either one naming a consequence asks (errs toward asking).
function targetIntent(
  target: string,
  described: DescribedTarget | undefined,
): CuConsequence | undefined {
  if (described !== undefined && described.role !== "unknown") {
    const name = described.name?.trim() ?? "";
    if (name !== "") {
      const fromName = labelIntent(name);
      if (fromName !== undefined) return fromName;
    }
  }
  return labelIntent(target);
}

/**
 * `context.described` is the AT-SPI description of the point the action acts
 * on. For a drag that is the DESTINATION (x2,y2), not the source (x1,y1):
 * dropping "photo.jpg" onto Trash is a delete.
 */
export function detectConsequence(
  action: ScreenAction,
  context: {
    lastTypedTarget?: string;
    described?: DescribedTarget;
    focusedDescribed?: DescribedTarget;
  } = {},
): ConsequenceFinding | undefined {
  switch (action.kind) {
    case "click": {
      if (action.intent !== undefined) return { intent: action.intent, source: "declared" };
      if (action.button !== "left") return undefined;
      const intent = targetIntent(action.target, context.described);
      return intent === undefined ? undefined : { intent, source: "label" };
    }
    case "drag": {
      if (action.intent !== undefined) return { intent: action.intent, source: "declared" };
      const intent = targetIntent(action.target, context.described);
      return intent === undefined ? undefined : { intent, source: "label" };
    }
    case "key": {
      if (action.intent !== undefined) return { intent: action.intent, source: "declared" };
      const shortcut = Object.hasOwn(KEY_CONSEQUENCES, action.combo)
        ? KEY_CONSEQUENCES[action.combo]
        : undefined;
      if (shortcut !== undefined) return { intent: shortcut, source: "key" };
      if (action.combo === "delete" && !isTextRole(context.focusedDescribed)) {
        return { intent: "delete", source: "key" };
      }
      if (ACTIVATE_KEYS.has(action.combo)) {
        const enter = ENTER_KEYS.has(action.combo);
        return activation(enter, context.lastTypedTarget, context.focusedDescribed, true);
      }
      return undefined;
    }
    case "type": {
      // A typed newline presses Return, a typed space presses Space. With
      // the focus unknown only a newline asks: a space in an app without
      // accessibility is a recorded residual risk (threat model).
      const enter = action.text.includes("\n");
      if (!enter && !action.text.includes(" ")) return undefined;
      return activation(enter, action.target, context.focusedDescribed, enter);
    }
    default:
      return undefined;
  }
}
