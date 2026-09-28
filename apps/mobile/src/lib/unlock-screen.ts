// Pure decisions for app/unlock.tsx and the root layout's routing to it
// (Phase 0 owner login), split out so they are testable without React Native.

import type { AuthLockCause, AuthView, UnlockOutcome } from "./auth-session";
import type { MessageKey } from "./i18n";
import type { RegisterOutcome } from "./passkey-registration";
import type { ClientState } from "./rpc-client";

/** Paths the unlock redirect never fires from: itself, pairing (no owner
 *  session exists yet) and the entry redirect. */
const NO_REDIRECT_PATHS = new Set(["/unlock", "/pair", "/"]);

/** While an automatic resume/refresh is in flight (`auth.busy`) the app
 *  stays put: a reconnect that resumes on its own never flashes the unlock
 *  screen. */
export function shouldShowUnlock(state: ClientState, auth: AuthView, pathname: string): boolean {
  if (NO_REDIRECT_PATHS.has(pathname) || auth.busy) return false;
  return state === "locked" || auth.lockedLocally;
}

/** D3: the unlock screen's connection line is a retry button while there
 *  is no socket at all (never connected, or given up) — the password and
 *  passkey need one first. */
export function unlockCanRetryConnection(state: ClientState): boolean {
  return state === "idle" || state === "closed";
}

export function unlockMessageKey(outcome: UnlockOutcome): MessageKey | undefined {
  switch (outcome) {
    case "unlocked":
    case "no-stored-token":
    case "cancelled":
      return undefined;
    case "password-required":
      return "auth.reason.signedOut";
    case "wrong-password":
      return "auth.wrongPassword";
    case "rate-limited":
      return "auth.rateLimited";
    case "offline":
      return "auth.offline";
    case "failed":
      return "auth.failed";
    case "passkey-unsupported":
      return "auth.passkeyUnsupported";
    case "passkey-refused":
      return "auth.passkeyRefused";
  }
}

export type PasskeyContext = {
  /** WebAuthn exists in this browser. */
  supported: boolean;
  /** The platform reports a user-verifying platform authenticator
   *  (Touch ID, Windows Hello, ...). */
  platformAuthenticator: boolean;
  /** The laptop has at least one passkey. */
  hasPasskeys: boolean;
};

/** Browser build (controller ruling): after the page-load stored sign-in
 *  found nothing usable, raise the passkey sheet on its own only when the
 *  platform can verify the owner and the laptop has a passkey. Otherwise
 *  the passkey button is there, above the password. */
export function shouldAutoPasskey(storedOutcome: UnlockOutcome, context: PasskeyContext): boolean {
  if (!context.supported || !context.platformAuthenticator || !context.hasPasskeys) return false;
  return storedOutcome === "no-stored-token" || storedOutcome === "password-required";
}

/** The browser's one automatic sign-in at page load: the stored token
 *  (keep-signed-in), then maybe the passkey sheet. Never throws — a failing
 *  step ends as "failed", so the screen can always leave its busy state. A
 *  sheet the browser refuses without a tap comes back as "cancelled" and
 *  leaves the button. */
export async function runWebAutoSignIn(steps: {
  storedSignIn(): Promise<UnlockOutcome>;
  passkeyContext(): Promise<PasskeyContext>;
  passkeySignIn(): Promise<UnlockOutcome>;
}): Promise<UnlockOutcome> {
  try {
    const stored = await steps.storedSignIn();
    if (stored === "unlocked") return stored;
    if (!shouldAutoPasskey(stored, await steps.passkeyContext())) return stored;
    return await steps.passkeySignIn();
  } catch {
    return "failed";
  }
}

export function registerMessageKey(outcome: RegisterOutcome): MessageKey | undefined {
  switch (outcome) {
    case "registered":
      return "passkey.added";
    case "cancelled":
      return undefined;
    case "exists":
      return "passkey.exists";
    case "wrong-password":
      return "auth.wrongPassword";
    case "rate-limited":
      return "auth.rateLimited";
    case "offline":
      return "auth.offline";
    case "unsupported":
      return "auth.passkeyUnsupported";
    case "locked":
    case "failed":
      return "passkey.failed";
  }
}

export function lockCauseKey(cause: AuthLockCause | undefined): MessageKey | undefined {
  switch (cause) {
    case undefined:
      return undefined;
    case "idle":
      return "auth.reason.idle";
    case "expired":
      return "auth.reason.expired";
    case "logout":
      return "auth.reason.logout";
    case "signed-out":
      return "auth.reason.signedOut";
  }
}
