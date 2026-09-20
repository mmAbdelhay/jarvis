// Pure view-model helpers for app/history.tsx and app/transcript/[id].tsx
// (M7's session-screen.ts pattern). Fix round 1, Important 3: neither
// screen distinguished "genuinely nothing here" from "the load failed" —
// `HistoryState` carries no explicit phase, so both are derived here from
// `stale`/`loading`/`notice` instead of duplicating that logic in each
// screen.
import type { HistoryState } from "./history-store";
import { isRtl, t, type Language } from "./i18n";

export type ListDisplay =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "failed"; text: string }
  | { kind: "list" };

/**
 * What the session list (History screen, and the Changes screen's session
 * strip) should show. `sessions.length === 0` used to always mean
 * "history.empty" / "changes.noSessions" — including when a timeout or
 * offline refusal was the real reason nothing loaded, which showed no
 * error at all.
 */
export function historyListDisplay(state: HistoryState, language: Language): ListDisplay {
  if (state.sessions.length > 0) return { kind: "list" };
  if (state.loading) return { kind: "loading" };
  if (state.stale)
    return { kind: "failed", text: state.notice ?? t(language, "common.loadFailed") };
  return { kind: "empty" };
}

export type TranscriptDisplay =
  | { kind: "loading" }
  | { kind: "notFound" }
  | { kind: "failed"; text: string }
  | { kind: "empty" }
  | { kind: "entries" };

/**
 * What the transcript route should show for route param `id`. Before this,
 * `transcript/[id].tsx` read "no entries yet" (`view.transcript.length ===
 * 0`) and "not in the sessions list" (`selected === undefined`) as the only
 * two non-happy states, so a `session:transcript` timeout — entries stay
 * `[]`, nothing ever arrives — rendered as the ordinary empty-transcript
 * copy, and a `history:list` failure before any session loaded rendered as
 * a false "Session not found." `state.stale` is what tells the two apart:
 * `history-store.ts` only sets it on a failed fetch, never on a genuinely
 * empty result.
 */
export function transcriptDisplay(
  state: HistoryState,
  id: string,
  language: Language,
): TranscriptDisplay {
  const known = state.sessions.some((session) => session.id === id);
  if (!known) {
    if (state.loading) return { kind: "loading" };
    if (state.stale && state.sessions.length === 0) {
      return { kind: "failed", text: state.notice ?? t(language, "common.loadFailed") };
    }
    return { kind: "notFound" };
  }
  if (state.selectedId !== id || state.loading) return { kind: "loading" };
  if (state.transcript.length === 0) {
    return state.stale
      ? { kind: "failed", text: state.notice ?? t(language, "common.loadFailed") }
      : { kind: "empty" };
  }
  return { kind: "entries" };
}

/** Any character (loosely) from an Arabic-script block — Arabic, Arabic
 *  Supplement/Extended-A/-B, and the Arabic Presentation Forms blocks. Good
 *  enough to tell "this run is Arabic prose" from "this run is Latin-script
 *  code/diff/log text"; it does not need to be a full script detector. */
const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const STRONG_LTR = /[a-z]/i;

/**
 * M12 Task 8, rule 10: a transcript entry carries no per-turn language tag
 * (unlike TurnList.tsx's voice turns), and RN's `writingDirection` style is
 * iOS-only — it has no effect at all on Android, so an Arabic-UI user
 * reading an English/code reply would see it rendered right-to-left there.
 * A leading U+200E (LEFT-TO-RIGHT MARK) works on both platforms because it
 * is part of the text itself, not a style hint: the Unicode bidi algorithm
 * treats it as strong LTR context for the run that follows, up to the next
 * paragraph separator. `text` is split on `\n` (the bidi algorithm's own
 * paragraph boundary) so each line gets its own mark — a multi-line reply
 * mixing an Arabic sentence with a fenced code block needs one per run, not
 * one for the whole message.
 */
export function withLrmPrefixes(text: string, language: Language): string {
  if (!isRtl(language)) return text;
  return text
    .split("\n")
    .map((line) => (ARABIC_SCRIPT.test(line) || !STRONG_LTR.test(line) ? line : `‎${line}`))
    .join("\n");
}
