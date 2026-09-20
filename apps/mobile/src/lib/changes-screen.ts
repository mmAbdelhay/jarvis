// Pure view-model helpers for app/changes.tsx (M7's session-screen.ts
// pattern: logic that decides *what* to show, lifted out of JSX so it's
// testable without rendering). Fix round 1 addresses three screen-level
// review findings that a pure-store test can't reach on its own: the
// commit draft must survive an offline refusal (Behaviour 3), the
// previously chosen session must reopen on refocus (Behaviour 2), and a
// `failed` phase or a non-remote notice must never be a blank/misleading
// screen (Important 3).
import {
  ENDED_SESSION_NOTICE,
  type ChangesState,
  MUTATION_OFFLINE_NOTICE,
  MUTATION_SESSION_CHANGED_NOTICE,
  UNSUPPORTED_NOTICE,
} from "./changes-store";
import { t, type Language, type MessageKey } from "./i18n";
import { MALFORMED_REPLY_NOTICE } from "./workspace-results";

/**
 * The session id the Changes screen should reopen when it regains focus.
 * `routeId` (an `?id=` param from a session-detail link) wins the *first*
 * time this screen instance sees it — `lastConsumedRouteId` is the route id
 * the caller already applied, held in a ref that survives across
 * blur/refocus (unlike `routeId` itself, which never changes for the life
 * of this screen instance). Once consumed, later refocuses fall back to
 * the store's own `sessionId`, which survives `close()` (only its
 * subscriptions and visible data are torn down) — otherwise a session link
 * would keep overriding every chip the user taps afterward on each
 * refocus (Fix round 2, New Breakage 1: `routeId` is a stack-entry-lived
 * query param, not a one-shot navigation event, so giving it unconditional
 * precedence reopened the linked session forever, discarding the user's
 * later choice).
 */
export function sessionIdToReopen(
  state: ChangesState,
  routeId: string | undefined,
  lastConsumedRouteId: string | undefined,
): string | undefined {
  if (routeId !== undefined && routeId !== lastConsumedRouteId) return routeId;
  return state.sessionId;
}

/**
 * A commit/stage draft is cleared only once the store reports a real,
 * connected outcome — never on `uncertain` (timeout/mid-flight close) and
 * never while a `notice` is set. Before Fix round 1, an offline refusal set
 * neither flag, so this looked identical to success and the draft was lost
 * (Important 1); the store now always sets a notice on refusal
 * (MUTATION_OFFLINE_NOTICE), so this same check is now correct for that
 * path too.
 * [bite-proof: change the offline branch back to `stale: true` alone (no
 * notice) and `shouldClearDraft` wrongly returns true again — covered by
 * changes-store.test.ts's "gives an offline mutation refusal a distinct
 * notice" test guarding the producer side of this.]
 */
export function shouldClearDraft(state: ChangesState): boolean {
  return !state.uncertain && state.notice === undefined;
}

const NOTICE_KEYS: Readonly<Record<string, MessageKey>> = {
  [ENDED_SESSION_NOTICE]: "changes.endedWarning",
  [MUTATION_OFFLINE_NOTICE]: "changes.offline",
  [MUTATION_SESSION_CHANGED_NOTICE]: "changes.sessionChanged",
  [UNSUPPORTED_NOTICE]: "changes.unsupported",
  [MALFORMED_REPLY_NOTICE]: "changes.malformedReply",
};

/**
 * Turns a store notice into displayed text. The four sentinel tokens the
 * store can produce are translated; anything else is real server text and
 * shown verbatim (global-constraints 7 — server messages display as-is).
 */
export function noticeText(notice: string, language: Language): string {
  const key = NOTICE_KEYS[notice];
  return key ? t(language, key) : notice;
}

/**
 * Text for `phase === "failed"`. A notice (server text or a translated
 * sentinel) is shown when the store set one; otherwise (a bare
 * timeout/offline refresh failure, which carries no notice) this falls
 * back to a generic localized message instead of leaving the screen blank
 * (Important 3).
 */
export function failedText(state: ChangesState, language: Language): string {
  return state.notice !== undefined
    ? noticeText(state.notice, language)
    : t(language, "common.loadFailed");
}
