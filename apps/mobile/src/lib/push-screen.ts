// The pure decisions behind the Settings screen's Notifications switch
// (M10 Task 6, "Interfaces"/"Behaviour" rules 3-4). `app/settings.tsx` is
// layout only — every decision here is a plain function over PushView,
// unit tested without a simulator, same split as voice-screen.ts.
import type { MessageKey } from "./i18n";
import type { PushView } from "./push-registration";

/**
 * Rule 3: the status line under the switch. `off` shows nothing. `on`
 * checks the laptop-disabled and not-yet-registered cases before falling
 * back to a plain "on"; every other phase maps to its own fixed key.
 *
 * iOS sideload case (free-signing plan, work item 2): a token fetch that
 * failed on a real iOS device with permission granted means the push
 * entitlement was stripped by free signing — the status line names that
 * instead of the generic "unavailable"/"pending" it would otherwise show.
 * `platform` comes from the screen (Platform.OS); Android never takes
 * this branch, its token fetches fail for ordinary reasons.
 */
export function notificationsStatusKey(
  view: PushView,
  platform?: "ios" | "android",
): MessageKey | undefined {
  if (
    view.tokenFetchFailed === true &&
    platform === "ios" &&
    (view.phase === "unavailable" || (view.phase === "on" && view.registered === false))
  ) {
    return "settings.notifications.sideloaded";
  }
  switch (view.phase) {
    case "off":
      return undefined;
    case "requesting":
      return "settings.notifications.requesting";
    case "denied":
      return "settings.notifications.denied";
    case "blocked":
      return "settings.notifications.blocked";
    case "unavailable":
      return "settings.notifications.unavailable";
    case "error":
      return "settings.notifications.error";
    case "on":
      if (view.laptopEnabled === false) return "settings.notifications.laptopOff";
      if (view.registered === false) return "settings.notifications.pending";
      return "settings.notifications.on";
  }
}

/**
 * Rule 4: true only for phase "on" — the switch has no local state of its
 * own, so it snaps back on its own after a denial or an error.
 */
export function notificationsSwitchValue(view: PushView): boolean {
  return view.phase === "on";
}
