// The keyboard model for the two screens that keep a key bar and a compose
// row pinned above the software keyboard (app/terminal/[paneKey].tsx,
// app/session/[id].tsx). Both are pure functions of `Platform.OS` (passed
// in by the caller — see sidecar-webview-config.ts's file comment for why
// nothing under src/lib imports `Platform` itself) so keyboard-offset.test.ts
// can pin every number below without a React Native runtime.
//
// Measured on the real phone (Galaxy S23 Ultra, Android 16, edge-to-edge,
// RN 0.86, dev client, 2026-09-20) — see phone-fix-report.md:
//   - the IME frame started at screenY = 530.1 dp of an 823.5 dp window,
//     so the keyboard covered 293.3 dp of it (navigation bar included);
//   - RN's own `keyboardDidShow` reported `height` = 278.4 dp, which is
//     ReactRootView's `imeInsets.bottom - systemBars.bottom` — the keyboard
//     *minus* the 14.9 dp gesture-navigation bar it sits on;
//   - `KeyboardAvoidingView` (behavior "padding") padded only 218.7 dp:
//     its `_relativeKeyboardHeight` subtracts `screenY` from its *parent-
//     relative* `onLayout` frame (`frame.y` is 0 for a screen root), so the
//     status bar + native-stack header above it (89.6 dp) never enter the
//     equation, and `keyboardVerticalOffset = insets.bottom` (the previous
//     attempt) only won back 14.9 of the missing 89.6 — the whole compose
//     row was still under the keyboard.
//
// So on Android the screen pads itself instead: RN's reported height plus
// the bottom safe-area inset is *exactly* the covered strip of a window that
// reaches the screen's bottom edge (278.4 + 14.9 = 293.3 dp on this phone),
// with no dependency on what sits above the screen. `KeyboardAvoidingView`
// gets no `behavior` there — RN then renders a plain `View` with the
// screen's own style intact, whereas any of its three behaviors would
// compose its own (wrong) `paddingBottom` over the style. iOS is untouched:
// `behavior="padding"` as before, no offset, no extra padding.

/** `KeyboardAvoidingView`'s `behavior` prop: "padding" on iOS (unchanged),
 * none on Android so the view stays a plain container and
 * `keyboardBottomPadding` below is the only thing moving the content. */
export function keyboardAvoidingBehavior(platform: string): "padding" | undefined {
  return platform === "ios" ? "padding" : undefined;
}

/** The bottom padding the screen applies itself on Android: RN's reported
 * keyboard height (already net of the system navigation bar) plus the
 * bottom safe-area inset (that same bar), i.e. the full strip the keyboard
 * covers; 0 while the keyboard is hidden and always 0 on iOS, where the
 * `KeyboardAvoidingView` does the work. Non-finite or negative inputs count
 * as 0 rather than producing a negative or NaN padding. */
export function keyboardBottomPadding(
  platform: string,
  keyboardHeight: number,
  bottomInset: number,
): number {
  if (platform !== "android") return 0;
  const height = Number.isFinite(keyboardHeight) ? Math.max(0, keyboardHeight) : 0;
  if (height === 0) return 0;
  const inset = Number.isFinite(bottomInset) ? Math.max(0, bottomInset) : 0;
  return height + inset;
}
