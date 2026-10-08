// The undo stack (Rafiq M3 §1): every confirm setter or file operation
// returns `undo: {tool, input}`; jarvisd keeps the last 20 and runs one on
// "undo". An undo runs WITHOUT a card — the user is reversing something they
// already approved — so what it may run is narrow: a tool of the same host
// server, in the same family (settings./files./apps./disks.), never a
// password-tier or secret-taking tool, never anything an add-on suggests.
// Pure.
import { CONTROL_TEXT } from "./messages.js";
import { normalizePhrase } from "./phrases.js";
import { HOST_FORCED_RISK, type RegisteredTool } from "./tool-registry.js";
import { isRecord } from "./types.js";

export const UNDO_LIMIT = 20;
const MAX_UNDO_INPUT_CHARS = 16_384;
export const UNDOABLE_FAMILIES = ["settings.", "files.", "apps.", "disks."] as const;

export type UndoStep = {
  title: string;
  tool: string;
  input: Record<string, unknown>;
  server: string;
  family: string;
  at: number;
};

export type UndoStack = {
  push(step: UndoStep): void;
  /** The newest step (that `match` accepts), removed from the stack. */
  pop(match?: (step: UndoStep) => boolean): UndoStep | undefined;
  size(): number;
  clear(): void;
};

export function undoFamily(tool: string): string | undefined {
  return UNDOABLE_FAMILIES.find((prefix) => tool.startsWith(prefix));
}

export function parseUndo(
  data: unknown,
  ran: RegisteredTool,
  lookup: (name: string) => RegisteredTool | undefined,
  hostServers: ReadonlySet<string>,
): { tool: RegisteredTool; input: Record<string, unknown> } | undefined {
  if (!isRecord(data) || !isRecord(data["undo"])) return undefined;
  const { tool, input } = data["undo"];
  if (typeof tool !== "string" || !isRecord(input)) return undefined;
  let copy: Record<string, unknown>;
  try {
    const text = JSON.stringify(input);
    if (text.length > MAX_UNDO_INPUT_CHARS) return undefined;
    copy = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!hostServers.has(ran.server)) return undefined;
  const family = undoFamily(ran.name);
  if (family === undefined || undoFamily(tool) !== family) return undefined;
  const target = lookup(tool);
  if (target === undefined || target.server !== ran.server) return undefined;
  if (target.risk === "password" || HOST_FORCED_RISK[tool] === "password") return undefined;
  if (target.secrets.length > 0) return undefined;
  return { tool: target, input: copy };
}

export function createUndoStack(limit = UNDO_LIMIT): UndoStack {
  const steps: UndoStep[] = [];
  return {
    push(step) {
      steps.push(step);
      if (steps.length > limit) steps.splice(0, steps.length - limit);
    },
    pop(match) {
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i] as UndoStep;
        if (match === undefined || match(step)) {
          steps.splice(i, 1);
          return step;
        }
      }
      return undefined;
    },
    size: () => steps.length,
    clear() {
      steps.length = 0;
    },
  };
}

export function stepTitle(titles: readonly string[]): string {
  const first = titles[0];
  if (first === undefined) return CONTROL_TEXT.lastChange;
  return titles.length === 1 ? first : CONTROL_TEXT.moreItems(first, titles.length - 1);
}

export type UndoRequest = { kind: "any" } | { kind: "files" };

// Stored normalised (normalizePhrase), so "Undo!" and "تَراجَع" match too.
const UNDO_ANY = new Set([
  "undo",
  "undo that",
  "undo it",
  "undo last change",
  "undo the last change",
  "undo my last change",
  "تراجع",
  "تراجع عن ذلك",
  "تراجع عن اخر تغيير",
  "الغ اخر تغيير",
]);
const UNDO_FILES = new Set([
  "undo last file change",
  "undo the last file change",
  "undo my last file change",
  "تراجع عن اخر تغيير في الملفات",
]);

export function undoRequestOf(text: string): UndoRequest | undefined {
  const phrase = normalizePhrase(text);
  if (UNDO_FILES.has(phrase)) return { kind: "files" };
  if (UNDO_ANY.has(phrase)) return { kind: "any" };
  return undefined;
}
