// The hardening props for the terminal `WebView` (Task 6, ruling 13) and
// the navigation lock that goes with them. Every value here is load-bearing
// security configuration, not a tuning knob — see terminal-webview-config.test.ts
// for the bite-proof that pins each one.

export const TERMINAL_WEBVIEW_PROPS = Object.freeze({
  // Fix round 1, I1 (controller ruling, amends brief rule 7): `["*"]`, not
  // `["about:blank"]`. react-native-webview's own pre-check
  // (`createOnShouldStartLoadWithRequest` in WebViewShared.tsx) runs
  // *before* our `onShouldStartLoadWithRequest` callback and, on a
  // whitelist miss, hands the rejected URL straight to `Linking.openURL` —
  // so a non-`about:blank` navigation from a strict whitelist would leave
  // the app for Safari/another app's URL scheme instead of being silently
  // dropped, and would log a page-derived URL along the way. `["*"]` makes
  // the library's own pre-check always pass, so `allowTerminalNavigation`
  // below — which accepts only exact `about:blank` — is the *only* gate,
  // and a rejection there returns `false` with no `Linking` call at all.
  // The array itself is frozen too (M6): a shallow `Object.freeze` on the
  // containing object doesn't stop `originWhitelist.push(...)` at runtime.
  //
  // Fix round 3, m-r1-4: this whole guarantee rests on react-native-webview
  // 13.16.1's internal `createOnShouldStartLoadWithRequest` always passing
  // an `originWhitelist` of `["*"]` through to `onShouldStartLoadWithRequest`
  // without its own `Linking` fallback ever firing — behavior that can't be
  // exercised in a unit test (no RN renderer here). Whoever bumps the
  // `react-native-webview` pin in package.json must re-read that function
  // in the new version and re-verify `["*"]` still bypasses `Linking`
  // before merging the bump.
  originWhitelist: Object.freeze(["*"]) as string[],
  javaScriptEnabled: true,
  domStorageEnabled: false,
  cacheEnabled: false,
  incognito: true,
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  allowingReadAccessToURL: undefined as string | undefined,
  mixedContentMode: "never" as const,
  setSupportMultipleWindows: false,
  javaScriptCanOpenWindowsAutomatically: false,
  allowsLinkPreview: false,
  // The Fabric spec (RNCWebViewNativeComponent.ts) types this as an array;
  // the string form crashed Android on the first device run
  // (`castValue: assertion failed (value.isObject())` in RawValue.h).
  dataDetectorTypes: Object.freeze(["none"]) as ["none"],
  geolocationEnabled: false,
  allowsInlineMediaPlayback: false,
  mediaPlaybackRequiresUserAction: true,
  thirdPartyCookiesEnabled: false,
  sharedCookiesEnabled: false,
  keyboardDisplayRequiresUserAction: true,
  hideKeyboardAccessoryView: true,
  bounces: false,
  overScrollMode: "never" as const,
  textZoom: 100,
});

/** The terminal page never navigates anywhere: it loads once from an
 * `{ html, baseUrl: "about:blank" }` source and stays there. Anything the
 * WebView tries to navigate to — a link in agent output, a redirect, a
 * crafted URL — is refused.
 *
 * With `originWhitelist: ["*"]` above, this is the *only* gate — the
 * library's own whitelist check always passes, so every URL reaches this
 * function, and a `false` here is a silent no-op (no `Linking` call, no
 * log of the URL). Never widen this past an exact `about:blank` match. */
export function allowTerminalNavigation(url: string): boolean {
  return url === "about:blank";
}
