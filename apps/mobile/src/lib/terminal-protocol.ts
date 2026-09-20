// The wire format between the terminal page (inside the WebView) and the
// native host (Task 6, task-6-brief.md). `PageMessage` is everything the
// page may post to native; `NativeMessage` is everything native may post to
// the page. Both directions are parsed/encoded field-by-field — never
// forwarded as opaque JSON — so a compromised or confused page can only
// ever produce one of these three shapes (rule 5, global-constraints.md).

export type PageMessage =
  | { t: "ready"; cols: number; rows: number }
  | { t: "resize"; cols: number; rows: number }
  | { t: "modes"; applicationCursor: boolean };

export type NativeMessage = { t: "write"; data: string } | { t: "reset" } | { t: "fit" };

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
    default:
      return undefined;
  }
}

export function encodeNativeMessage(message: NativeMessage): string {
  return JSON.stringify(message);
}
