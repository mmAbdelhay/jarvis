// The browser build's PrefsStore (Task 13): expo-file-system has no web
// implementation, so prefs.json lives in localStorage under one key
// instead. Not a secret (language, speak-replies, sidecar view settings) —
// secrets never go here. Same contract as prefs-file.ts: a missing value
// reads as `undefined`; prefs.ts parses and falls back on anything else.
import type { PrefsStore } from "./prefs";

const PREFS_KEY = "jarvis.prefs";

export const filePrefsStore: PrefsStore = {
  async read() {
    return window.localStorage.getItem(PREFS_KEY) ?? undefined;
  },
  async write(text: string) {
    window.localStorage.setItem(PREFS_KEY, text);
  },
};
