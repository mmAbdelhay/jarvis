// Wide layout (2026-09-28 spec §3): a phone that inherits a selection from
// a wide layout (a rotation, or a `?id=` / `?tab=` link) shows it with a
// back chip. Android's hardware Back does what the chip does, instead of
// leaving the tab. Pure so the rule is unit tested; `use-phone-back.ts`
// registers it.

/** The `hardwareBackPress` listener: true consumes the press. */
export function phoneBackHandler(showBack: boolean, clear: () => void): () => boolean {
  return () => {
    if (!showBack) return false;
    clear();
    return true;
  };
}

/** Whether to register that listener: only Android has a hardware Back
 *  (react-native-web's BackHandler logs an error when used). */
export function phoneBackListens(platform: string, showBack: boolean): boolean {
  return platform === "android" && showBack;
}
