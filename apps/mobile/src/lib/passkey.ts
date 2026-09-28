// Passkeys on the native app: none (Task 13 adds them to the browser build
// only — passkey.web.ts). This stub keeps shared imports resolvable and
// answers "unsupported" everywhere, so no native screen ever offers one.
import type { GetPasskeyAssertion } from "./auth-session";
import type { CreatePasskey } from "./passkey-registration";

export type Passkeys = {
  /** WebAuthn exists in this runtime. */
  isSupported(): boolean;
  /** A user-verifying platform authenticator (Touch ID, Windows Hello,
   *  ...) is available: only then does the sheet open on its own. */
  hasPlatformAuthenticator(): Promise<boolean>;
  getAssertion: GetPasskeyAssertion;
  create: CreatePasskey;
};

export const passkeys: Passkeys = {
  isSupported: () => false,
  hasPlatformAuthenticator: async () => false,
  getAssertion: async () => undefined,
  create: async () => "cancelled",
};
