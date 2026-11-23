// What a terminal tab carries between the main window and its pop-out, and
// back: the layout of its splits and the text typed but not yet sent. All of
// it is renderer-only state (the shells themselves live in main), so it
// travels through the host, which validates it here. Pure: no electron, no
// DOM.

/** A tab's split layout: leaves are pane keys ("<tabId>" or "<tabId>:pN"). */
export type SplitShape =
  | { key: string }
  | { direction: "row" | "column"; first: SplitShape; second: SplitShape };

export type PopoutTerminalState = {
  shape: SplitShape;
  /** Unsent text in a pane's command editor, by pane key. */
  drafts: Record<string, string>;
  /** The pane that had the focus. */
  focused?: string;
};

export const POPOUT_MAX_DEPTH = 8;
export const POPOUT_MAX_LEAVES = 16;
export const POPOUT_KEY_MAX = 200;
export const POPOUT_DRAFT_MAX = 64 * 1024;
export const POPOUT_DRAFTS_TOTAL_MAX = 256 * 1024;

/** The state a tab that was never split and has typed nothing carries. */
export function plainTerminalState(tabId: string): PopoutTerminalState {
  return { shape: { key: tabId }, drafts: {} };
}

function ownKey(key: unknown, tabId: string): key is string {
  return (
    typeof key === "string" &&
    key.length <= POPOUT_KEY_MAX &&
    (key === tabId || key.startsWith(`${tabId}:`))
  );
}

function parseShape(
  value: unknown,
  tabId: string,
  depth: number,
  keys: string[],
): SplitShape | undefined {
  if (typeof value !== "object" || value === null || depth > POPOUT_MAX_DEPTH) return undefined;
  const record = value as Record<string, unknown>;
  if ("key" in record) {
    if (!ownKey(record["key"], tabId) || keys.length >= POPOUT_MAX_LEAVES) return undefined;
    if (keys.includes(record["key"])) return undefined;
    keys.push(record["key"]);
    return { key: record["key"] };
  }
  const direction = record["direction"];
  if (direction !== "row" && direction !== "column") return undefined;
  const first = parseShape(record["first"], tabId, depth + 1, keys);
  if (first === undefined) return undefined;
  const second = parseShape(record["second"], tabId, depth + 1, keys);
  if (second === undefined) return undefined;
  return { direction, first, second };
}

/** The leaf keys of a shape, in layout order. */
export function shapeKeys(shape: SplitShape): string[] {
  return "key" in shape ? [shape.key] : [...shapeKeys(shape.first), ...shapeKeys(shape.second)];
}

/**
 * A state from the renderer, or undefined when it is not one: every pane key
 * must be this tab's own, the layout bounded, and a draft must belong to a
 * pane in it.
 */
export function parsePopoutState(value: unknown, tabId: string): PopoutTerminalState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const keys: string[] = [];
  const shape = parseShape(record["shape"], tabId, 0, keys);
  if (shape === undefined) return undefined;
  const drafts: Record<string, string> = {};
  const rawDrafts = record["drafts"];
  if (rawDrafts !== undefined) {
    if (typeof rawDrafts !== "object" || rawDrafts === null || Array.isArray(rawDrafts)) {
      return undefined;
    }
    let total = 0;
    for (const [key, text] of Object.entries(rawDrafts)) {
      if (!keys.includes(key) || typeof text !== "string" || text.length > POPOUT_DRAFT_MAX) {
        return undefined;
      }
      total += text.length;
      if (total > POPOUT_DRAFTS_TOTAL_MAX) return undefined;
      if (text !== "") drafts[key] = text;
    }
  }
  const focused = record["focused"];
  if (focused !== undefined && (typeof focused !== "string" || !keys.includes(focused))) {
    return undefined;
  }
  return { shape, drafts, ...(focused === undefined ? {} : { focused }) };
}
