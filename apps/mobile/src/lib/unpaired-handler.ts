// Extracted from `app/_layout.tsx`: a `_layout.tsx` React component can't
// be unit tested directly, so what happens on an unpaired episode lives here as
// a plain function instead: forget that machine, and act on where that leaves
// the user. Never rejects, so the user is never stranded on a dead Dashboard
// showing "This phone was unpaired." with no route forward.
//
// The outcome this answers is what lets the connection store
// (connection-store.ts) avoid marking the episode "handled" when the clear
// failed. A failed clear leaves the old record on disk, and the ordinary
// already-paired check would then show a contradictory "already paired" screen
// with only a Dashboard button that loops back with the now-revoked token
// (task-6-rereview-r1.md, Important 1), which is why `forget` sets the
// clear-failed signal and `/pair` shows its distinct `clearFailed` phase
// (pair-flow.ts's `entryPhaseKind`/`afterClearRetry`).
//
// What to forget and where to go are the caller's: `unpairedHandlerFor` in
// machine-sessions.ts fixes the machine and the cause when it builds this, so a
// clear always concerns the machine that was revoked, whichever is active by
// then.

import type { ForgetOutcome } from "./machine-sessions";

export type UnpairedOutcome = "cleared" | "clearFailed";

export function createUnpairedHandler(deps: {
  forget(): Promise<ForgetOutcome>;
  afterForget(outcome: ForgetOutcome): void;
  log(line: string): void;
}): () => Promise<UnpairedOutcome> {
  return async () => {
    let outcome: ForgetOutcome;
    try {
      outcome = await deps.forget();
    } catch {
      deps.log("onUnpaired: forgetting the machine failed; routing to /pair");
      outcome = { kind: "clearFailed" };
    }
    deps.afterForget(outcome);
    return outcome.kind === "clearFailed" ? "clearFailed" : "cleared";
  };
}
