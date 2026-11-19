// The browser build opened inside the desktop app's machine view (another
// Jarvis machine shown in a Jarvis window). The host sets the view's user
// agent per session to end with `JarvisMachineView/1`; a page cannot change
// its own user agent. Decided once at startup (machine-view-env.ts), pure
// here. In a machine view the sign-in is kept (the stored refresh token, as
// with "Keep me signed in") and there is no idle lock; the laptop's
// 7-day-unused / 30-day-total refresh lifetimes still end it. Everywhere
// else nothing changes.

export const MACHINE_VIEW_TOKEN = "JarvisMachineView/1";

/** The idle window that never locks: auth-session arms no idle timer for a
 *  non-finite window. */
export const NO_IDLE_LOCK = Number.POSITIVE_INFINITY;

/** True only when the token is one whole space-separated word of the user
 *  agent: `XJarvisMachineView/1` or `JarvisMachineView/2` do not count. */
export function isMachineView(userAgent: string): boolean {
  return userAgent.split(" ").includes(MACHINE_VIEW_TOKEN);
}

/** Only the browser build looks at the user agent; the native app is never
 *  a machine view. */
export function machineViewFor(os: string, userAgent: unknown): boolean {
  return os === "web" && typeof userAgent === "string" && isMachineView(userAgent);
}

export function idleLockMs(machineView: boolean, ms: number): number {
  return machineView ? NO_IDLE_LOCK : ms;
}

export function keepSignedInFor(machineView: boolean, chosen: boolean): boolean {
  return machineView || chosen;
}
