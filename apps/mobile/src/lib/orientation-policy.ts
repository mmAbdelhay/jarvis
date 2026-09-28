// Which orientations the app allows on this device. A phone stays portrait
// (a few screens — the terminal, a session, a sidecar — unlock it while
// focused); a tablet is laid out for both orientations by the wide layout,
// so it is never locked. The class comes from the device's physical screen,
// not the current window, so an iPad in Split View is still a tablet. The
// threshold is the wide layout's short-side floor: a device whose screen
// can ever be wide is a tablet.
// Pure so the threshold is unit tested; `app-orientation.ts` feeds it.

import { WIDE_MIN_SHORT_SIDE } from "./layout-class";

export type OrientationPolicy = "portrait-lock" | "free";

export function orientationPolicy(input: { shortSide: number }): OrientationPolicy {
  return input.shortSide < WIDE_MIN_SHORT_SIDE ? "portrait-lock" : "free";
}
