// Pure view-model helpers for app/docker/[project].tsx (fix round 1,
// Minor 4, task-6-review.md): the AppState transition logic pulled out of
// JSX so it is unit-testable — the same pattern changes-screen.ts and
// history-screen.ts use for a screen's own decision logic that a plain
// store test can't reach.

import type { AppStateStatus } from "react-native";
import type { DockerLogPhase } from "./docker-log-stream";

export type AppStateFollowAction =
  | { kind: "close" }
  | { kind: "reattach"; container: string }
  | { kind: "none" };

/**
 * What the Docker screen's log follower should do on an AppState
 * transition, given the container it was last following (`undefined` if
 * none is active) and the follower's current phase. Only a real
 * "background" transition detaches — iOS's transient "inactive" (a
 * notification pull-down, a Face ID sheet, an app-switcher peek) leaves a
 * live follower alone, since the app is still effectively present and the
 * connection is still live. Returning to "active" re-attaches the
 * remembered container (M5 ruling: detach on blur/background, re-attach on
 * focus/reconnect) — that reattachment is what makes detaching on
 * "background" safe in the first place, rather than an orphaned
 * laptop-side follower the user has to notice and clear by hand.
 *
 * M12 Task 8, rule 8: re-attach fires only when `phase` is `"idle"` — the
 * follower genuinely detached (a real "background" ran `close()` first).
 * An "inactive" → "active" transition with no "background" in between
 * never detached anything (`"inactive"` returns `{kind:"none"}` above), so
 * the follower's phase is still `"following"`/`"waiting"`/`"failed"`; a
 * phase-blind reattach would call `docker:follow` a second time for a
 * follower that is already live (or already failed and not idle), wasting
 * one of the device's four follower slots on every notification
 * pull-down.
 */
export function appStateFollowAction(
  next: AppStateStatus,
  following: string | undefined,
  phase: DockerLogPhase,
): AppStateFollowAction {
  if (next === "active") {
    return following !== undefined && phase === "idle"
      ? { kind: "reattach", container: following }
      : { kind: "none" };
  }
  if (next === "background") {
    return { kind: "close" };
  }
  // "inactive", "unknown", "extension": none of these mean the app has
  // actually left — leave the follower running.
  return { kind: "none" };
}
