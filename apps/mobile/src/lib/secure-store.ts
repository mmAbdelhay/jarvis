// The one place `expo-secure-store` is touched. Everything else in the app
// (pairing-record.ts, and through it the token/pairing flow) talks to the
// narrow `SecureStore` interface below, so tests use an in-memory fake and
// never the keychain. iOS items use `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`:
// readable in the background (the RPC client reconnects while the app is
// backgrounded) but never included in an iCloud Keychain/device backup.

import * as ExpoSecureStore from "expo-secure-store";

export type SecureStore = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

const OPTIONS: ExpoSecureStore.SecureStoreOptions = {
  keychainAccessible: ExpoSecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const expoSecureStore: SecureStore = {
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
