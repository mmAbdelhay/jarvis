// The tap planner (M10 Task 5, rule 8). Pure — no navigation call, no
// client, no state: it only decides *where* a tapped notification should
// go, given the app's own current session list. The caller (outside this
// task's file scope) is responsible for actually navigating and for
// waiting up to NOTIFICATION_NAV_WAIT_MS for `sessionIds` to be populated
// (from a live `sessions:list` call over an `open` socket,
// `whenNotOpen: "reject"` — ruling 9 in global-constraints.md) before
// calling this.
//
// Security review item: `planNavigation` never returns a route for a
// `sessionId` absent from the given `sessionIds` set, and never for data
// that fails `parsePushData` — the route string is always built from the
// already-validated id, never the raw notification payload.
import { type PushData, parsePushData } from "@jarvis/wire";
import { isPrKey, reviewRoute } from "./reviews-store";

export const NOTIFICATION_NAV_WAIT_MS = 15_000;

export type TapPlan =
  | { route: string }
  | { route: undefined; reason: "invalid" | "unknown-session" | "dashboard" };

function sessionPlan(data: PushData, sessionIds: ReadonlySet<string>): TapPlan {
  if (data.sessionId !== undefined && sessionIds.has(data.sessionId)) {
    return { route: `/session/${data.sessionId}` };
  }
  return { route: undefined, reason: "unknown-session" };
}

const REVIEW_KINDS: ReadonlySet<unknown> = new Set([
  "review-comment",
  "review-queued",
  "review-requested",
]);

/** A `review-*` push goes to its PR's thread, the route built from the
 * validated key only. No `pr` at all (the laptop leaves it out when
 * project names are off) opens the Reviews list; a malformed one falls
 * back to the dashboard.
 * Checked on the raw value so it works whichever `PushKind`s this build's
 * wire knows about. */
function reviewPlan(data: unknown): TapPlan | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const raw = data as Record<string, unknown>;
  if (!REVIEW_KINDS.has(raw["kind"])) return undefined;
  const pr = raw["pr"];
  if (pr === undefined) return { route: "/reviews" };
  return isPrKey(pr) ? { route: reviewRoute(pr) } : { route: undefined, reason: "dashboard" };
}

/** Rule 8. `data` is whatever `expo-notifications` handed back for a
 * tapped notification's `data` field — still `unknown` until
 * {@link parsePushData} validates it. */
export function planNavigation(data: unknown, sessionIds: ReadonlySet<string>): TapPlan {
  const review = reviewPlan(data);
  if (review !== undefined) return review;
  const parsed = parsePushData(data);
  if (parsed === undefined) {
    return { route: undefined, reason: "invalid" };
  }
  switch (parsed.kind) {
    case "reply":
      return { route: "/voice" };
    case "session-done":
    case "session-failed":
    case "session-waiting":
      return sessionPlan(parsed, sessionIds);
    default:
      return { route: undefined, reason: "dashboard" };
  }
}
