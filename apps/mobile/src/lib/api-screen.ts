// Pure params/rows view-model helpers for app/api/[project].tsx (fix round
// 2, "New Important" 1): the query/path params row logic pulled out of JSX
// so it is unit-testable — the same pattern docker-screen.ts/changes-
// screen.ts use for a screen's own decision logic a plain store test can't
// reach.
import type { KeyValueRow } from "@/components/api/KeyValueRows";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rowsFromArray(value: unknown): KeyValueRow[] {
  if (!Array.isArray(value)) return [];
  const rows: KeyValueRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const row: KeyValueRow = {
      name: typeof item.name === "string" ? item.name : "",
      value: typeof item.value === "string" ? item.value : "",
      enabled: item.enabled !== false,
    };
    // Fix round 1 (I4): a params row's `type` ("query" | "path") is the
    // field that decides whether the laptop's own serializer treats it as
    // a query string entry or a `/:name` route segment — read here so it
    // survives an edit round-trip instead of silently becoming a query
    // param on save.
    if (typeof item.type === "string") row.type = item.type;
    rows.push(row);
  }
  return rows;
}

export function rowsField(
  draft: Record<string, unknown> | undefined,
  field: string,
): KeyValueRow[] {
  return rowsFromArray(draft?.[field]);
}

export function rowsToPlain(
  rows: KeyValueRow[],
): { name: string; value: string; enabled: boolean; type?: string }[] {
  // Fix round 1 (I4): `type` (params[].type: "query" | "path") is written
  // back whenever a row carries one — dropping it here is exactly what
  // silently turned a path param into a query param on save.
  return rows.map((row) => ({
    name: row.name,
    value: row.value,
    enabled: row.enabled,
    ...(row.type !== undefined ? { type: row.type } : {}),
  }));
}

/** Fix round 1 (I4): `params` holds query *and* path rows together,
 *  distinguished only by `type` — split so each renders under its own
 *  heading, and so the Query editor's onChange only ever rewrites the
 *  query rows, never silently dropping a path row's `type` by routing it
 *  through the same round-trip. */
export function splitParams(draft: Record<string, unknown> | undefined): {
  path: KeyValueRow[];
  query: KeyValueRow[];
} {
  const rows = rowsField(draft, "params");
  return {
    path: rows.filter((row) => row.type === "path"),
    query: rows.filter((row) => row.type !== "path"),
  };
}

/** Fix round 2: `KeyValueRows.addRow()` creates a row with no `type` at
 *  all — the laptop's own serializer (@usebruno/lang's jsonToBruV2) only
 *  ever emits a `params` row as `type: "query"` or `type: "path"`, so a
 *  typeless row is silently dropped on save. Stamped at every point a
 *  query row is written back to `params`, so a brand-new row (or one
 *  otherwise missing its own type) always round-trips as an explicit
 *  query row rather than vanishing. */
export function stampQueryType(rows: KeyValueRow[]): KeyValueRow[] {
  return rows.map((row) => (row.type === undefined ? { ...row, type: "query" } : row));
}
