// The refresh token's own keychain entry (Phase 0 owner login), separate
// from secure-store.ts's pairing store. No `requireAuthentication`: the
// device-owner check (device-auth.ts) gates every read in auth-session.ts
// instead, so rotation writes never prompt. On iOS the item only exists
// while the phone has a passcode (`WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`)
// and is never backed up. Thin and untested: auth-session.ts carries the
// logic, its tests use a store double.

import * as ExpoSecureStore from "expo-secure-store";
import type { SecureStore } from "./secure-store";

const OPTIONS: ExpoSecureStore.SecureStoreOptions = {
  keychainService: "jarvis.refresh",
  keychainAccessible: ExpoSecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};

export const refreshStore: SecureStore = {
  async get(key) {
    const value = await ExpoSecureStore.getItemAsync(key, OPTIONS);
    return value ?? undefined;
  },
  async set(key, value) {
    await ExpoSecureStore.setItemAsync(key, value, OPTIONS);
  },
  async delete(key) {
    await ExpoSecureStore.deleteItemAsync(key, OPTIONS);
  },
};
