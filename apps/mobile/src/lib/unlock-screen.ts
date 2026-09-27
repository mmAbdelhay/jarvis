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

/** Browser build: after the automatic stored sign-in (keep-signed-in)
 *  found nothing usable, raise the passkey sheet on its own — only when
 *  the browser has WebAuthn and the laptop has a passkey to offer. A
 *  browser that refuses a sheet without a tap just leaves the button. */
export function shouldAutoPasskey(
  storedOutcome: UnlockOutcome,
  context: { supported: boolean; hasPasskeys: boolean },
): boolean {
  if (!context.supported || !context.hasPasskeys) return false;
  return storedOutcome === "no-stored-token" || storedOutcome === "password-required";
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
