// The "Desktop site" props for the sidecar `WebView` (app/sidecar-view.tsx):
// DbGate and code-server both sniff the WebView's user agent and, seeing a
// mobile one, serve a "not supported on mobile" notice (DbGate) or a
// cramped phone layout (code-server) instead of their real UI. Sending a
// desktop Chrome UA gets the real desktop UI instead, and the viewport
// model below (1 CSS px = 1 dp at 100 %, −/+ re-laying the page out to the
// visible area) makes it usable once it's there. Every
// value here is deliberate — see sidecar-webview-config.test.ts for the
// bite-proof that pins each one — mirroring terminal-webview-config.ts's
// discipline for the terminal's own hardening props.
//
// This file is imported directly by its own test below, which runs under
// Vitest's plain Node environment (vitest.config.mts: `environment:
// "node"`, no React Native transform). `react-native`'s package entry uses
// Flow syntax that environment can't parse — a top-level `import {
// Platform } from "react-native"` here would fail every test that imports
// this module (confirmed: it throws "Flow is not supported" at collection
// time). So platform selection is a plain function of a `platformOS`
// string the caller supplies — `app/sidecar-view.tsx` is the one place
// that imports the real `Platform` from `react-native` and passes
// `Platform.OS` in, the same way `app/pair.tsx` and `app/_layout.tsx`
// already read `Platform.OS` directly (neither is reachable from a
// `src/**/*.test.ts` file, so neither hits this constraint).

const CHROME_VERSION = "128.0.0.0";
const WEBKIT_VERSION = "537.36";

/** A current desktop Chrome-on-macOS UA string — used on iOS, since that's
 * the shape a real Mac's Chrome sends and the shape iOS's own "Request
 * Desktop Site" override typically sends too. */
export const SIDECAR_USER_AGENT_MACOS =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/${WEBKIT_VERSION} ` +
  `(KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/${WEBKIT_VERSION}`;

/** A current desktop Chrome-on-Linux UA string — used on Android, since
 * Android's own Chrome runs on a Linux kernel and this is the shape a
 * genuine desktop Chrome on Linux sends. */
export const SIDECAR_USER_AGENT_LINUX =
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/${WEBKIT_VERSION} ` +
  `(KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/${WEBKIT_VERSION}`;

/** Picks the desktop UA for the running platform: the macOS-style string
 * on iOS, the Linux-style string everywhere else (Android is the only
 * other platform this app ships to). `platformOS` is `Platform.OS` from
 * `react-native`, passed in by the caller rather than read here — see the
 * file comment above for why. */
export function sidecarUserAgent(platformOS: string): string {
  return platformOS === "ios" ? SIDECAR_USER_AGENT_MACOS : SIDECAR_USER_AGENT_LINUX;
}

// The viewport model (real-device fix, 2026-09-20, Galaxy S23 Ultra —
// phone-fix-report.md has the screenshots): the earlier `width=1024` meta
// with no `initial-scale` made Chromium fit the whole 1024 px desktop
// layout into the 384 dp screen, a 0.375 scale — code-server's explorer
// rows came out ~7 px tall with ~5 dp text, nothing was readable or
// tappable, and the −/+ buttons (which only rewrote `width`) visibly did
// nothing on the phone. "Can't navigate the editor" was exactly that.
//
// Now 100 % means 1 CSS px = 1 dp, like a real mobile page: the layout
// width is the screen's own width in dp (`screen.width`, which follows the
// orientation on Android and iOS, so landscape simply gets the wider
// layout) and the page scale is pinned to 1. Zoom changes both together —
// scale S = percent / 100, layout width = screen.width / S — so the page
// always lays out to *exactly* the visible area: bigger zoom = narrower
// layout with bigger text and controls, never content off-screen with no
// way to pan (the failure CSS `zoom` had). `minimum-scale` and
// `maximum-scale` are pinned to S as well, not just `initial-scale`: an
// initial scale is only honoured on the first load, while a changed
// min/max range clamps the live page scale immediately — that is what
// makes a −/+ tap re-lay out the page in place. (Pinch-zoom is lost with
// min == max, but code-server and DbGate swallow the pinch gesture
// themselves anyway — real-device follow-up — so the buttons are the zoom.)
//
// Everything is computed inside the page (`screen.width` is only known
// there) by one shared snippet, run before the first content loads
// (`SIDECAR_VIEWPORT_SCRIPT`, at the 100 % default), again on every load
// end and on every −/+ tap (`zoomScript`), and re-run by the page itself
// on `resize` (rotation, split-screen) for the last zoom it was given —
// guarded so an unchanged content string is never re-set, since setting
// the meta itself fires a resize. Wrapped in try/catch and ending `true;`
// per RNWV's injected-script convention; it only ever touches a sidecar
// page's own DOM, never the terminal's — the terminal's WebView doesn't
// use this file at all.
export const SIDECAR_ZOOM_MIN = 50;
export const SIDECAR_ZOOM_MAX = 200;
export const SIDECAR_ZOOM_STEP = 10;
export const SIDECAR_ZOOM_DEFAULT = 100;

export type ZoomDirection = "in" | "out";

/** Clamps to the [50, 200] range this screen supports, and maps a
 * non-finite input (a corrupt stored value, a stray `NaN`) to the 100%
 * default rather than propagating it — every caller below routes through
 * this so an invalid value can never reach the injected script or get
 * persisted back out. */
function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return SIDECAR_ZOOM_DEFAULT;
  return Math.min(SIDECAR_ZOOM_MAX, Math.max(SIDECAR_ZOOM_MIN, Math.round(value)));
}

/** The next zoom percentage for the header's −/+ buttons: one 10-point
 * step from `current`, clamped to [50, 200]. `current` is trusted only as
 * a starting point — a non-finite or out-of-range value (a fresh screen
 * before the first tap, or a corrupt persisted one) is first clamped
 * itself, so stepping from an invalid state still lands on a valid one
 * instead of compounding the corruption. */
export function nextZoom(current: number, direction: ZoomDirection): number {
  const step = direction === "in" ? SIDECAR_ZOOM_STEP : -SIDECAR_ZOOM_STEP;
  return clampZoom(clampZoom(current) + step);
}

/** The injected script that applies one zoom level (see the file comment
 * above for the model). `factor` is clamped to an integer in [50, 200]
 * before it ever reaches the template string — the only substituted value
 * is that integer, so there is no way for a caller-supplied value (even a
 * deliberately hostile one, were `factor`'s `number` type ever bypassed)
 * to inject script content through this function. The page keeps the last
 * percent on `window.__jarvisSidecarZoom` for its own resize re-apply. */
export function zoomScript(factor: number): string {
  const percent = clampZoom(factor);
  return `(function () {
  try {
    var apply = function () {
      var percent = window.__jarvisSidecarZoom;
      var scale = percent / 100;
      var base = (window.screen && window.screen.width) || window.innerWidth || 0;
      if (!(base > 0)) return;
      var width = Math.max(1, Math.round(base / scale));
      var content =
        "width=" + width +
        ", initial-scale=" + scale +
        ", minimum-scale=" + scale +
        ", maximum-scale=" + scale;
      var meta = document.querySelector('meta[name="viewport"]');
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute("name", "viewport");
        (document.head || document.documentElement).appendChild(meta);
      }
      if (meta.getAttribute("content") !== content) meta.setAttribute("content", content);
    };
    document.documentElement.style.zoom = "";
    window.__jarvisSidecarZoom = ${percent};
    if (!window.__jarvisSidecarZoomBound) {
      window.__jarvisSidecarZoomBound = true;
      window.addEventListener("resize", apply);
    }
    apply();
  } catch (e) {}
  true;
})();`;
}

/** The before-content-load script: the same model at the 100 % default
 * (the per-kind persisted zoom is re-applied on load end by the screen). */
export const SIDECAR_VIEWPORT_SCRIPT = zoomScript(SIDECAR_ZOOM_DEFAULT);

/** The zoom a sidecar kind starts at before the user has ever touched
 * −/+ (prefs.ts stores per-kind overrides only, `{}` by default). 100 %
 * (1 CSS px = 1 dp) for code-server and Headlamp; 60 % for DbGate, which
 * refuses to run at all below ~600 CSS px of layout width ("not supported
 * on mobile devices" — measured on the phone: it runs at 60 % = 640 px,
 * refuses at 70 % = 549 px) so its default must already clear that. Any
 * other/unknown kind gets the plain default. */
export function sidecarZoomDefault(kind: string | undefined): number {
  return kind === "database" ? 60 : SIDECAR_ZOOM_DEFAULT;
}

/** The non-UA, non-script desktop-site props: Android's own zoom controls
 * (pinch-zoom stays on; the on-screen +/- buttons stay off, matching every
 * other WebView surface in this app). Frozen like `TERMINAL_WEBVIEW_PROPS`
 * — these are load-bearing, not a tuning knob. */
export const SIDECAR_DESKTOP_WEBVIEW_PROPS = Object.freeze({
  setBuiltInZoomControls: true,
  setDisplayZoomControls: false,
});

/** The screen's one call: the full prop set to spread onto the sidecar
 * `WebView` for the current "Desktop site" toggle state. `false` (the
 * toggle off) spreads to nothing — the WebView falls back to its
 * out-of-the-box mobile UA and behaviour, exactly as it did before this
 * feature existed. `zoom` is the level to lay the page out at from its very
 * first paint (the kind's persisted or default zoom), so DbGate never
 * flashes its "not supported" notice at 100 % before load end corrects it;
 * on both platforms a changed `injectedJavaScriptBeforeContentLoaded` only
 * affects the *next* load, never reloads the live page — the live page is
 * driven by `zoomScript` through `injectJavaScript` instead. */
export function sidecarDesktopWebViewProps(
  desktopSite: boolean,
  platformOS: string,
  zoom: number = SIDECAR_ZOOM_DEFAULT,
):
  | {
      userAgent: string;
      setBuiltInZoomControls: boolean;
      setDisplayZoomControls: boolean;
      injectedJavaScriptBeforeContentLoaded: string;
    }
  | Record<string, never> {
  if (!desktopSite) return {};
  return {
    userAgent: sidecarUserAgent(platformOS),
    ...SIDECAR_DESKTOP_WEBVIEW_PROPS,
    injectedJavaScriptBeforeContentLoaded: zoomScript(zoom),
  };
}
