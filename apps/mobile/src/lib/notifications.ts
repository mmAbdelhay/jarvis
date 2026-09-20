// The pure interface `push-registration.ts` and `native-notifications.ts`
// share — no `expo-notifications` import here, so this file (and anything
// that only imports its types) is safe to reach from a Vitest run. See
// native-notifications.ts's own header for how the real adapter is built
// over these shapes, and push-registration.ts for how the controller
// drives them (task-5-brief.md, "Interfaces").

/** `expo-notifications`' own permission statuses, mapped down to the four
 * this app distinguishes — see native-notifications.ts's mapping table
 * (rule 9). */
export type PushPermission = "granted" | "denied" | "blocked" | "undetermined";

/** A tapped notification's identifier and its `data` payload, exactly as
 * `expo-notifications` hands it back — still `unknown` until
 * `notification-tap.ts`'s `planNavigation` runs it through
 * `parsePushData`. */
export type NotificationResponse = { id: string; data: unknown };

/** The seam `push-registration.ts` drives instead of calling
 * `expo-notifications` directly — `native-notifications.ts`'s
 * `buildNotificationsAdapter` is the only real implementation; tests hand
 * the controller a fake one. */
export type NotificationsAdapter = {
  getPermission(): Promise<PushPermission>;
  requestPermission(): Promise<PushPermission>;
  isDevice(): boolean;
  projectId(): string | undefined;
  ensureAndroidChannel(name: string): Promise<void>;
  getExpoPushToken(projectId: string): Promise<string>;
  onTokenChanged(cb: () => void): () => void;
  onResponse(cb: (response: NotificationResponse) => void): () => void;
  lastResponse(): Promise<NotificationResponse | undefined>;
  setForegroundHandler(): void;
  platform(): "ios" | "android";
  /** M12 Task 12 minor: expo-notifications' own `setAutoServerRegistrationEnabledAsync`
   *  — when disabled, the library stops posting this device's token to
   *  Expo's server on its own in the background. `disable()`
   *  (push-registration.ts) calls this with `false` alongside clearing its
   *  own closure-held token, so "off" means the library stops trying too,
   *  not just that this controller stopped asking. `enable()` does not need
   *  to call it with `true`: getExpoPushTokenAsync re-enables auto-registration
   *  after every successful token fetch. */
  setAutoServerRegistrationEnabled(enabled: boolean): Promise<void>;
};
