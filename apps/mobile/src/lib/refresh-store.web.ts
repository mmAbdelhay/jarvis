// The browser build's refresh-token store (Task 13): its own IndexedDB
// database and its own non-extractable AES-GCM key (encrypted-store.ts).
// auth-session.ts writes here only while "Keep me signed in on this
// browser" is on (device-auth.web.ts answers that setting); with it off —
// the default — nothing is written and every page load needs a passkey or
// the password. The access token is never stored anywhere.
import { createEncryptedStore } from "./encrypted-store";
import { createIdbBackend } from "./idb-backend";

export const refreshStore = createEncryptedStore({
  backend: createIdbBackend("jarvis.refresh"),
  subtle: globalThis.crypto.subtle,
  randomBytes: (length) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
  namespace: "jarvis.refresh",
});
