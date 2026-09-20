// Extracted from `app/_layout.tsx`: a `_layout.tsx` React component can't
// be unit tested directly, so the actual "what happens on an unpaired
// episode" decision lives here as a plain function instead — try to clear
// the stored pairing, log a secret-free line if that fails, and navigate
// to /pair *either way*, so the user is never stranded on a dead Dashboard
// showing "This phone was unpaired." with no route forward.
//
// Navigating "either way" isn't enough on its own — a clearing failure
// leaves the old record on disk, and the ordinary already-paired check
// would then show a contradictory "already paired" screen with only a
// Dashboard button that loops back with the now-revoked token
// (task-6-rereview-r1.md, Important 1). The outcome this returns (and
// passes to `navigateToPair`) is what lets `/pair` show its distinct
// `clearFailed` phase instead (pair-flow.ts's
// `entryPhaseKind`/`afterClearRetry`) — and what lets the connection store
// (connection-store.ts) avoid marking the episode "handled" when it
// wasn't.
//
// The `clearFailed` phase is signalled through a one-shot, in-memory flag
// (clear-failed-signal.ts) rather than a route param — a
// `jarvis://pair?...&clearFailed=1` link could otherwise forge it. This is
// the *only* place that ever calls `setClearFailedSignal()`; `/pair` reads
// it back with `takeClearFailedSignal()`, never from a link or a param.
//
// The clear itself is also wrapped in the same app-wide `pairing-guard.ts`
// flag Settings' manual unpair uses, closing the window where a Settings
// "Reconnect" during this automatic clear could still read the
// not-yet-removed record and reconnect with a token that's about to be
// invalidated.

import { setClearFailedSignal } from "./clear-failed-signal";
import { setClearingPairing } from "./pairing-guard";

export type UnpairedOutcome = "cleared" | "clearFailed";

export function createUnpairedHandler(deps: {
  clearPairing(): Promise<void>;
  navigateToPair(outcome: UnpairedOutcome): void;
  log(line: string): void;
}): () => Promise<UnpairedOutcome> {
  return async () => {
    setClearingPairing(true);
    try {
      await deps.clearPairing();
    } catch {
      deps.log("onUnpaired: clearPairing failed; routing to /pair's clearFailed phase");
      setClearFailedSignal();
      deps.navigateToPair("clearFailed");
      return "clearFailed";
    } finally {
      setClearingPairing(false);
    }
    deps.navigateToPair("cleared");
    return "cleared";
  };
}
