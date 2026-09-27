// The wire format between the terminal page (inside the WebView) and the
// native host (Task 6, task-6-brief.md). `PageMessage` is everything the
// page may post to native; `NativeMessage` is everything native may post to
// the page. Both directions are parsed/encoded field-by-field — never
// forwarded as opaque JSON — so a compromised or confused page can only
// ever produce one of these three shapes (rule 5, global-constraints.md).

export type PageMessage =
  | { t: "ready"; cols: number; rows: number }
  | { t: "resize"; cols: number; rows: number }
  | { t: "modes"; applicationCursor: boolean }
  // Bug 9: a touch-drag scroll gesture in the alternate screen buffer,
  // while some program has mouse tracking on — carries only a synthesized
  // direction, never anything read from the terminal's own content. The
  // native side turns this into a `terminal:input`/`session:input` SGR
  // mouse-wheel escape sequence.
  | { t: "wheel"; direction: "up" | "down" };

export type NativeMessage =
  | { t: "write"; data: string }
  | { t: "reset" }
  | { t: "fit" }
  // Bug 8: the pty's real size, once known — the page resizes its
  // terminal to exactly this rather than fitting to the WebView's own
  // dimensions, so a phone attaching to a pane the desktop already sized
  // renders it correctly instead of garbling wrapped lines.
  | { t: "size"; cols: number; rows: number };

const MAX_TEXT_LENGTH = 256;

function isDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1000;
}

export function parsePageMessage(text: unknown): PageMessage | undefined {
  if (typeof text !== "string" || text.length > MAX_TEXT_LENGTH) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  switch (obj.t) {
    case "ready":
    case "resize":
      if (isDimension(obj.cols) && isDimension(obj.rows)) {
        return { t: obj.t, cols: obj.cols, rows: obj.rows };
      }
      return undefined;
    case "modes":
      if (typeof obj.applicationCursor === "boolean") {
        return { t: "modes", applicationCursor: obj.applicationCursor };
      }
      return undefined;
    case "wheel":
      if (obj.direction === "up" || obj.direction === "down") {
        return { t: "wheel", direction: obj.direction };
      }
      return undefined;
    default:
      return undefined;
  }
}

export function encodeNativeMessage(message: NativeMessage): string {
  return JSON.stringify(message);
}
