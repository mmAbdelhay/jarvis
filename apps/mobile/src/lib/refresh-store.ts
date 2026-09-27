// The refresh token's own keychain entry (Phase 0 owner login), separate
// from secure-store.ts's pairing store: reading it needs the owner's
// biometrics (`requireAuthentication`), and on iOS it only exists while the
// phone has a passcode (`WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`) and is never
// backed up. Its own `keychainService` keeps its auth-bound key apart from
// the pairing store's (expo-secure-store requires that). Thin and untested:
// auth-session.ts carries the logic, its tests use a store double.
//
// iOS prompts when *updating* an existing item but not when creating one,
// so `set` deletes first: a rotated token is stored without a prompt.
// Android prompts for every read and write of an auth-bound key.

import * as ExpoSecureStore from "expo-secure-store";
import type { RefreshStore } from "./auth-session";

const SERVICE = "jarvis.refresh";

export function createRefreshStore(prompt: () => string): RefreshStore {
  function options(): ExpoSecureStore.SecureStoreOptions {
    return {
      keychainService: SERVICE,
      keychainAccessible: ExpoSecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
      requireAuthentication: true,
      authenticationPrompt: prompt(),
    };
  }

  return {
    async get(key) {
      const value = await ExpoSecureStore.getItemAsync(key, options());
      return value ?? undefined;
    },
    async set(key, value) {
      await ExpoSecureStore.deleteItemAsync(key, options());
      await ExpoSecureStore.setItemAsync(key, value, options());
    },
    async delete(key) {
      await ExpoSecureStore.deleteItemAsync(key, options());
    },
    canUseBiometrics() {
      try {
        return ExpoSecureStore.canUseBiometricAuthentication();
      } catch {
        return false;
      }
    },
  };
}
