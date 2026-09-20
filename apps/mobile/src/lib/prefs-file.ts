// The app's real PrefsStore: prefs.json under the document directory, via
// expo-file-system. Thin and untested — prefs.ts carries the logic and its
// own tests exercise a FakeStore instead. Not a secret: no expo-secure-store.
import { File, Paths } from "expo-file-system";
import type { PrefsStore } from "./prefs";

const prefsFile = new File(Paths.document, "prefs.json");

export const filePrefsStore: PrefsStore = {
  async read() {
    if (!prefsFile.exists) {
      return undefined;
    }
    return prefsFile.text();
  },
  async write(text: string) {
    prefsFile.write(text);
  },
};
