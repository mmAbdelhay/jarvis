// The browser build's pairing store (Task 13), in place of expo-secure-store
// (whose web module is empty): the device token and the pairing record, in
// IndexedDB, AES-GCM encrypted under a non-extractable key
// (encrypted-store.ts). Always stored — the device token is what
// reconnects this browser. The export keeps the native name so every
// `expoSecureStore` caller (pair, settings, the root layout) works as is.
import { createEncryptedStore } from "./encrypted-store";
import { createIdbBackend } from "./idb-backend";

export const expoSecureStore = createEncryptedStore({
  backend: createIdbBackend("jarvis.secure"),
  subtle: globalThis.crypto.subtle,
  randomBytes: (length) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
  namespace: "jarvis.secure",
});
